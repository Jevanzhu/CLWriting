#!/usr/bin/env node
/**
 * X-P2-16：README 数字对账门——测试文件数 + 用例数 vs README 声称值。
 *
 * 背景：「账实对照」是本项目卖点，但 W-P2-15 专项修账后批 6 加测试又漂移
 * （修账用了滞后统计快照，之后无人对账）。把对账从自律升级为门禁：
 * CI 每跑必核，README 数字失准即红。
 *
 * 统计口径：
 * - 单测文件：test 目录下全部 *.test.ts（不含 e2e 的 *.spec.ts）
 * - 单测用例：`vitest list --json` 全量枚举（不执行，秒级）
 * - e2e spec：test/e2e 目录下 *.spec.ts 文件数
 * - e2e 用例：spec 文件内 `test(`/`test.serial(`/`test.describe(` 顶层调用静态计数
 *   （playwright 无 list --json，静态计数足够当门禁——漂移即失配）
 *
 * R63-12：`.only` 拒绝门扩到无条件 `.skip`（调试遗留 it.skip 同样让用例静默
 * 跳过而门禁照常绿）；条件式 skip（test.skip(!env.X) 环境门）白名单豁免。
 * 净化/计数/检出逻辑抽为纯函数 export，直测见 test/scripts/check-counts.test.ts。
 *
 * R66-37（十四轮）：e2e spec 顺序快照守卫——README「勿改动 spec 顺序」从注释
 * 契约升级为机器门：spec 名单/字典序位漂移即红（详见 E2E_SPEC_ORDER_SNAPSHOT）。
 *
 * 用法：npm run check:counts（退出码 1 = 失配，并列出实测值供修 README）
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// fileURLToPath 解码百分号编码（工作区路径含 ^ 时 pathname 会带 %5E，scandir 直接 ENOENT）
const root = fileURLToPath(new URL('..', import.meta.url))

// ── 剥注释/字符串（X-32：e2e 用例计数与 .only 检查共用同一净化口径）──────────────
// 背景 A（二轮复审门禁补强）：test.only/it.only/describe.only 会让该文件其余用例
// 静默跳过——门禁照常绿但覆盖面骤减，vitest list 的枚举数不变、README 对账也发现不了。
// 背景 B（X-32）：e2e 用例静态计数此前不剥——注释掉的样例用例、字符串里的「test(」
// 说明文本会被数成真实用例，README 对账口径失真。剥注释时保留 https:// 的协议斜杠
// 不被误剥。
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}
// 字符串字面量内容清空（保留空串定界符维持词法形态）：标题/说明文本不参与匹配。
// R73-78（批 F-12）：模板串改前向扫描支持 ${} 嵌套——旧单条正则 `[^`\\]*` 在
// 「模板内嵌套模板/字符串」（如 `a ${ t(`x`) } b`）处提前截断，半截模板残留在净化
// 输出里：残留中的 `test(` 假声明被虚增计数、真实用例可能被吞（计数漂移）。扫描器
// 口径：最外层模板（含 ${} 表达式内的嵌套模板与单双引号串）整体清成 ""；未闭合
// 模板与旧正则口径一致——不匹配、原样保留。
/**
 * 从 src[at]（须为反引号）起吞一个完整模板串，返回闭合反引号下标；未闭合返回 -1。
 * ${} 表达式内允许：花括号嵌套（对象字面量）、单双引号串（串内反引号不算定界）、
 * 嵌套模板（递归吞到其闭合）。
 */
function skipTemplateLiteral(src, at) {
  let depth = 0 // 0 = 模板文本段；>0 = ${ } 表达式内花括号平衡深度
  let i = at + 1
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') { i += 2; continue }
    if (depth === 0) {
      if (c === '`') return i
      if (c === '$' && src[i + 1] === '{') { depth = 1; i += 2; continue }
    } else {
      if (c === '{') { depth++; i++; continue }
      if (c === '}') { depth--; i++; continue }
      if (c === "'" || c === '"') {
        // 表达式内的普通字符串：串内反引号/${} 不参与模板定界，整串跳过
        const q = c
        i++
        while (i < src.length && src[i] !== q && src[i] !== '\n') {
          if (src[i] === '\\') i += 2
          else i++
        }
        i++ // 越过闭合引号（未闭合时停在行尾断点，容错前进）
        continue
      }
      if (c === '`') {
        const close = skipTemplateLiteral(src, i)
        if (close === -1) return -1
        i = close + 1
        continue
      }
    }
    i++
  }
  return -1
}

export function stripStrings(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === "'" || c === '"') {
      // 单双引号串：口径同旧正则（不跨行、\ 转义），清成 ""
      let j = i + 1
      let closed = false
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === c) { closed = true; break }
        if (src[j] === '\n') break
        j++
      }
      if (closed) { out += '""'; i = j + 1 }
      else { out += src.slice(i, j); i = j } // 未闭合：原样保留（旧正则同口径）
      continue
    }
    if (c === '`') {
      const close = skipTemplateLiteral(src, i)
      if (close !== -1) { out += '""'; i = close + 1; continue }
      out += c // 未闭合模板：原样保留（旧正则不匹配未闭合串）
      i++
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * R65-63（F-11）：门禁净化统一入口——先清字符串再剥注释。
 * 反过来（先注释后字符串）时，字符串内容里的非冒前 `//`（如 base64 片段、
 * URL 路径段）会被当行注释吃掉、吞掉行尾引号污染后续计数；先空串则注释内
 * 的引号已成对占位，注释剥离不受影响。占位 `""` 保形使 .skip 标题串探测仍命中。
 */
export function sanitizeForCount(src) {
  return stripComments(stripStrings(src))
}

/**
 * e2e 用例静态计数：只数真实用例声明 test( / test.serial( / test.only( / test.fail( /
 * test.fixme(，排除 hook/describe/skip（test.beforeAll( 等点后缀会虚增——曾把 37 数成 56）；
 * 计数前剥注释/字符串（X-32），被注释/写进字符串的声明样例不再计入
 * R62-56：test.fail( / test.fixme( 也声明真实用例（期望失败/挂起的测试），此前漏数
 */
export function countE2eCases(src) {
  const m = sanitizeForCount(src).match(
    /(^|[^.\w])(?:test\.serial|test\.only|test\.fail|test\.fixme|test)\s*\(/g,
  )
  return m ? m.length : 0
}

/**
 * R63-12：.only / 无条件 .skip 检出（返回各自命中数，剥注释/字符串后判定）。
 * - .only 一律拒绝（其余用例被静默跳过，门禁假绿）。
 * - .skip 只拒「无条件式」——首参为标题字符串（剥字符串后 `(` 紧跟 `"`）是调试
 *   遗留/长期弃置；条件式（首参布尔表达式，如 test.skip(!process.env.X) 环境门）
 *   `(` 后非 `"`，白名单豁免（release-smoke.spec.ts 的发布门先例）。
 */
export function findOnlyOrSkipViolations(src) {
  const clean = sanitizeForCount(src)
  // R64-38（十二轮）：only 门正则补 `.each` 组合——`it.only.each([...])('t', fn)` 形态
  // 此前不被 `\s*\(` 匹配（only 后面是 .each），漏放行整个参数化组（其余用例静默跳过）。
  const only = clean.match(/(^|[^.\w])(?:it|test|describe)\.only(?:\.each)?\s*[({[]/g)
  // R65-59（F-3）：无条件 skip 同补 `.each` 组合——`it.skip.each([...])('t', fn)` 同样
  // 静默跳过整组；条件式豁免口径不变（plain 形态首参须标题串，each 形态第二调用首参须标题串）
  // R27-134（二十七轮）：plain 形态补零参——`test.skip()`（连条件都没有的无条件整用例
  // 跳过，比标题串形态更赤裸）此前 `\(\s*"` 只认标题串首参，零参漏放行；剥串后判定
  // `(` 紧跟 `"`（标题串）或 `)`（零参）均算无条件，其余首参（环境门表达式）照旧豁免
  const skipPlain = clean.match(/(^|[^.\w])(?:it|test|describe)\.skip\s*\(\s*(?:"|\))/g)
  const skipEach = clean.match(/(^|[^.\w])(?:it|test|describe)\.skip\.each\s*\([^)]*\)\s*\(\s*"/g)
  return { only: only ? only.length : 0, uncondSkip: (skipPlain?.length ?? 0) + (skipEach?.length ?? 0) }
}

/**
 * R76-40（二十四轮 F 域）：空洞测试门——剥注释/字符串后每个 .test.ts 至少一处
 * expect( / assert 调用。单测数来自 vitest list（数声明不数断言）：只声明用例、
 * 零断言的文件也能满足 README 计数对账，此前仅靠 coverage 语句门 82 弱兜底。
 * 口径：expect( 是 vitest 家规断言面（全量实测无一文件例外）；assert(/.( 认
 * node:assert 形态；写进字符串/注释的样例不算（sanitizeForCount 同源）。
 */
export function findAssertionFreeTestFiles(entries) {
  return entries
    .filter((e) => !/(^|[^.\w])(?:expect|assert)\s*[.(]/.test(sanitizeForCount(e.src)))
    .map((e) => e.relPath)
}

/**
 * R76-6（二十四轮 F 域）：e2e pageerror 基线接线静态门——R75-7 把渲染层异常升级为红
 * 的前提是各 spec 接 attachPageErrorBaseline，但接线是约定式 opt-in 无机器校验：新增
 * spec 漏接一行，「渲染层异常被断言偶然通过掩盖」的洞静默重开。剥注释/字符串后每个
 * spec 须有一处 attachPageErrorBaseline( 调用（import 行不带 `(` 不会误判通过）；
 * 无浏览器页面的 spec 走显式豁免名单（登记理由，新增须改此处过目）。
 */
export const PAGEERROR_WIRING_EXEMPT = [
  'test/e2e/release-smoke.spec.ts', // 发布 smoke：API 冒烟无浏览器页面（R75-7 摸底时即未接，正当理由）
]
export function missingPageErrorWiring(entries, exempt = PAGEERROR_WIRING_EXEMPT) {
  return entries
    .filter((e) => !exempt.includes(e.relPath))
    .filter((e) => !/(^|[^.\w])attachPageErrorBaseline\s*\(/.test(sanitizeForCount(e.src)))
    .map((e) => e.relPath)
}

/**
 * 递归收集文件
 * F-5（二十九轮批 F）：`.` 前缀跳过同时覆盖外置卷 AppleDouble 元数据（macOS 在 exFAT
 * 等卷上为每个真实文件旁生成 `._<name>` 副本，含 `._x.test.ts` 形态）——与 vitest
 * exclude 的 `._*` 通配同口径（vitest.config.ts），否则外置卷工作区跑门禁时副本虚增
 * 测试文件计数。此处显式注记，防后续把点前缀跳过误当普通 dotfile 卫生而收窄。
 */
function walk(dir, pred, out = []) {
  for (const name of readdirSync(dir)) {
    // `._*`（AppleDouble）以 `.` 开头，随 dotfile 一并跳过（对齐 vitest 收集口径）
    if (name === 'node_modules' || name.startsWith('.')) continue
    const fp = join(dir, name)
    const st = statSync(fp)
    if (st.isDirectory()) walk(fp, pred, out)
    else if (pred(name)) out.push(fp)
  }
  return out
}

// ── R66-37（十四轮）：e2e spec 顺序快照守卫 ─────────────────────────────────────
// e2e 的 28+ spec 共享 globalSetup 的单一临时 workDir，playwright.config workers:1
// 下按 spec 路径 localeCompare 序串行跑，前一个建的书/写的内容供后一个用——顺序是
// 隐式契约（README「勿加并行或改动 spec 顺序」此前只有注释、无机器守卫）。
// R28-28（二十八轮）：快照单一真相源 = test/e2e/spec-order.snapshot.txt——此前本处
// 硬编码 spec 名单数组、与快照文件双真相源，改序者同步其一漏其二即静默分叉。本脚本
// 改为直读快照文件（缺失/解析失败/行形不合规一律 fail-closed 报人话），按 spec 裸
// 文件名比对（快照由守卫写入 entry.name，e2e 扁平目录下锁名即锁序）：
// 新增/改名/删除任何 spec 都会改变名单或序位 → 失配红，逼改动者显式确认「插序是否
// 破坏前序 spec 的落盘依赖」后用 CLW_UPDATE_SPEC_ORDER_SNAPSHOT=1 重拍快照（序为
// localeCompare，镜像 Playwright 收集序，见 spec-order.guard.test.ts R28-27）。
const SPEC_ORDER_SNAPSHOT_PATH = join(root, 'test', 'e2e', 'spec-order.snapshot.txt')

/**
 * R28-28：读取 spec 顺序快照（唯一真相源），fail-closed——
 * - 文件缺失 / 读失败：报人话指路重拍命令；
 * - 解析后 0 行：空快照当不了契约基线；
 * - 行形不合规（须为 test/e2e/*.spec.ts 相对路径）：点名坏行。
 * 任一中招即 process.exit(1)，绝不静默放行。
 */
function loadSpecOrderSnapshot() {
  let raw
  try {
    raw = readFileSync(SPEC_ORDER_SNAPSHOT_PATH, 'utf8')
  } catch (e) {
    console.error('\ncheck:counts 失败：spec 顺序快照缺失/不可读（R28-28 fail-closed）——')
    console.error(`  唯一真相源：${SPEC_ORDER_SNAPSHOT_PATH}`)
    console.error(`  读失败原因：${e.message ?? String(e)}`)
    console.error('  若为首次建立或有意重排，先跑守卫重拍：CLW_UPDATE_SPEC_ORDER_SNAPSHOT=1 npx vitest run test/e2e/spec-order.guard.test.ts')
    process.exit(1)
  }
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) {
    console.error('\ncheck:counts 失败：spec 顺序快照为空，当不了契约基线（R28-28 fail-closed）——')
    console.error(`  唯一真相源：${SPEC_ORDER_SNAPSHOT_PATH}`)
    console.error('  重拍：CLW_UPDATE_SPEC_ORDER_SNAPSHOT=1 npx vitest run test/e2e/spec-order.guard.test.ts')
    process.exit(1)
  }
  const bad = lines.filter((line) => !/^[\w.-]+\.spec\.ts$/.test(line))
  if (bad.length > 0) {
    console.error('\ncheck:counts 失败：spec 顺序快照含不合规行（须为 *.spec.ts 裸文件名，每行一个）（R28-28 fail-closed）——')
    for (const b of bad) console.error('  - ' + b)
    process.exit(1)
  }
  return lines
}

/**
 * R66-37：spec 名单/顺序失配检出（纯函数，便于直测）。
 * 返回 { added, removed }——同名增删即名单漂移；只有名单一致时顺序才有意义
 * （名单一致 + 排序后比较恒等，顺序漂移只会表现为增删位差）。
 */
export function diffSpecOrder(actualRelativePaths, snapshot) {
  const actual = [...actualRelativePaths].sort()
  const want = [...snapshot]
  const added = actual.filter((p) => !want.includes(p))
  const removed = want.filter((p) => !actual.includes(p))
  return { added, removed }
}

/**
 * J0（win 适配，2026-08-28 本机实测暴露）：walk 产出平台原生分隔符路径（Windows 为 `\`），
 * 快照名单恒为 posix 相对路径——先剥 root 再统一 `\`→`/` 归一化。否则 windows 上
 * R66-37 守卫全体失配假红（'test\e2e\x.spec.ts' ≠ 'test/e2e/x.spec.ts'）；R70-9 只修了
 * vitest list 的 spawn，本归一化是其漏网的另一半（win CI 腿落库后未实跑 check:counts 故未暴露）。
 */
export function posixRelPath(root, fp) {
  return fp.replace(root, '').replace(/\\/g, '/')
}

// 门禁主体收进 main() + 直跑守卫：node 直跑本文件（npm run check:counts）时执行；
// 被测试 import（R63-12 直测纯函数）时不触发 vitest list / process.exit 副作用
function main() {
  const unitFiles = walk(join(root, 'test'), (n) => n.endsWith('.test.ts'))
  const e2eSpecs = walk(join(root, 'test', 'e2e'), (n) => n.endsWith('.spec.ts'))

  // vitest list --json：[{ fullName, ... }]（不执行用例）
  let vitestJson = ''
  try {
    // R70-9（十八轮）：win 上 spawn(shell:false) 只找 npx.exe（实际是 npx.cmd）→
    // ENOENT/EINVAL 必挂 windows CI 腿；改 process.execPath 直跑 vitest.mjs（免 npx 免 shell）
    vitestJson = execFileSync(
      process.execPath,
      [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'list', '--json'],
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
  } catch (e) {
    console.error('check:counts：vitest list 执行失败（' + (e.message ?? String(e)) + '）')
    process.exit(1)
  }
  const unitTests = JSON.parse(vitestJson).length

  let e2eCases = 0
  for (const fp of e2eSpecs) e2eCases += countE2eCases(readFileSync(fp, 'utf8'))

  // ── R66-37（十四轮）：e2e spec 顺序快照守卫 ─────────────────────
  // spec 名单/localeCompare 序位与快照失配即红：新 spec 插序改变 workers:1 下的执行
  // 顺序，前序 spec 的落盘依赖可能静默错位——须人工确认后重拍唯一真相源快照文件。
  const { added: specAdded, removed: specRemoved } = diffSpecOrder(
    // R28-28：快照行 = spec 裸文件名（守卫写 entry.name），此处对齐口径取 basename
    e2eSpecs.map((fp) => basename(fp)),
    loadSpecOrderSnapshot(),
  )
  if (specAdded.length > 0 || specRemoved.length > 0) {
    console.error('\ncheck:counts 失败：e2e spec 名单/顺序与快照失配（R66-37）——')
    console.error('  spec 按 workers:1 localeCompare 序串行跑且共享单一 workDir，顺序是隐式契约（README「勿改动 spec 顺序」）。')
    console.error('  唯一真相源 = test/e2e/spec-order.snapshot.txt；新增/改名 spec 前请确认其序位不破坏前序 spec 的落盘依赖，再重拍快照：')
    console.error('  CLW_UPDATE_SPEC_ORDER_SNAPSHOT=1 npx vitest run test/e2e/spec-order.guard.test.ts')
    for (const p of specAdded) console.error('  + 新增（当前在跑，快照缺）: ' + p)
    for (const p of specRemoved) console.error('  - 移除（快照有，当前缺）: ' + p)
    process.exit(1)
  }

  // ── .only / 无条件 .skip 拒绝 ─────────────────────
  const onlyHits = []
  for (const fp of [...unitFiles, ...e2eSpecs]) {
    const { only, uncondSkip } = findOnlyOrSkipViolations(readFileSync(fp, 'utf8'))
    const n = only + uncondSkip
    if (n > 0) onlyHits.push(`${posixRelPath(root, fp)}（${n} 处）`)
  }
  if (onlyHits.length > 0) {
    console.error('\ncheck:counts 失败：发现 .only 或无条件 .skip 用例（提交前移除——其余用例会被静默跳过，门禁假绿；环境门条件式 skip 可豁免）：')
    for (const h of onlyHits) console.error('  - ' + h)
    process.exit(1)
  }

  // ── R76-6（二十四轮 F 域）：e2e pageerror 接线静态门 ─────────────
  const pageerrorMissing = missingPageErrorWiring(
    e2eSpecs.map((fp) => ({ relPath: posixRelPath(root, fp), src: readFileSync(fp, 'utf8') })),
  )
  if (pageerrorMissing.length > 0) {
    console.error('\ncheck:counts 失败：e2e spec 未接 pageerror 基线（R76-6）——')
    console.error('  渲染层未捕获异常只有接了 attachPageErrorBaseline 才会让用例红（R75-7），漏接=该 spec 异常被断言偶然通过掩盖。')
    console.error('  在首个 page 动作前接线：attachPageErrorBaseline(page, \'<spec 文件名去 .spec.ts>\')；')
    console.error('  无浏览器页面的 spec 须在 PAGEERROR_WIRING_EXEMPT 登记理由：')
    for (const p of pageerrorMissing) console.error('  - ' + p)
    process.exit(1)
  }

  // ── R76-40（二十四轮 F 域）：空洞测试门 ─────────────
  const assertionFree = findAssertionFreeTestFiles(
    unitFiles.map((fp) => ({ relPath: posixRelPath(root, fp), src: readFileSync(fp, 'utf8') })),
  )
  if (assertionFree.length > 0) {
    console.error('\ncheck:counts 失败：零断言测试文件（R76-40）——')
    console.error('  只声明用例不写 expect/assert 也能计入单测数对账（数声明不数断言），空洞测试从计数门静默通过：')
    for (const p of assertionFree) console.error('  - ' + p)
    process.exit(1)
  }

  const actual = {
    unitFiles: unitFiles.length,
    unitTests,
    e2eSpecs: e2eSpecs.length,
    e2eCases,
  }

  // ── README 声称值抽取 ─────────────────────────────
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const claims = []
  const mismatch = []

  function claim(pattern, value, label) {
    const m = readme.match(pattern)
    if (!m) {
      mismatch.push(`README 缺少「${label}」声称值（模式失配：${pattern}）——实测 ${value}`)
      return
    }
    claims.push({ label, claimed: Number(m[1]), actual: value })
    if (Number(m[1]) !== value) {
      mismatch.push(`${label}：README 声称 ${m[1]}，实测 ${value}`)
    }
  }

  // R67-23（十五轮）：锚定短语的正则对全/半角变体容错——此前只认全角括号 + 半角
  // 斜杠/逗号的一种精确排印，README 排版微调即模式失配→假红（fail-closed 方向没错，
  // 但把排版差异当数字失真红太脆）；语义锚（短语 + 数字位置）不变，真失配/真缺行仍红。
  const PH = (inner) => `[（(]${inner}[)）]`
  // J0（win 适配，2026-08-28 本机实测）：README 单测数为 macOS/Linux 口径——win 上 J3
  // 的 skipIf(win32) 平台门用例不进 vitest list 收集（实测 4066→4010，差属预期非丢失），
  // 单测数对账由 macos/ubuntu 腿承担（承 coverage 门「阈值门留分支 CI」的平台分工先例）；
  // win 腿仍对账测试文件数与 e2e spec/用例数（平台不变量）。
  const isWin = process.platform === 'win32'
  const claimUnitTests = (pattern, label) => {
    if (!isWin) claim(pattern, actual.unitTests, label)
  }
  // 徽章：tests-2937%20all%20green（示例为 2026-08-23 当前值，实际以 README 为准）
  claimUnitTests(/badge\/tests-(\d+)%20all%20green/, '徽章单测数')
  // 「npm test                   # 2937 单测」
  claimUnitTests(/npm test\s+[#＃]\s*(\d+)\s*单测/, 'npm test 单测数')
  // 「vitest（2937 单测）+ Playwright（28 specs / 41 用例）」
  claimUnitTests(new RegExp(`vitest${PH('(\\d+) 单测')}`), '技术栈单测数')
  claim(new RegExp('Playwright[（(](\\d+) specs'), actual.e2eSpecs, 'Playwright spec 数')
  // dd-P3（E-P3-3）：锚定完整短语——裸 `(\d+) 用例）` 会命中 README 里任何以"用例）"结尾的数字
  claim(new RegExp(`Playwright${PH('\\d+ specs [\\/／] (\\d+) 用例')}`), actual.e2eCases, 'Playwright 用例数')
  // P-11（第十四轮）：开发节 e2e 行此前是盲区——「Playwright e2e（mock 驱动，28 specs / 41 用例）」
  // 中间夹了「e2e（mock 驱动，」，不匹配上面的「Playwright（」模式，该行漂移时门禁仍绿
  claim(
    new RegExp(`Playwright e2e${PH(`mock 驱动[,，](\\d+) specs [\\/／] \\d+ 用例`)}`),
    actual.e2eSpecs,
    '开发节 e2e spec 数',
  )
  claim(
    new RegExp(`Playwright e2e${PH(`mock 驱动[,，]\\d+ specs [\\/／] (\\d+) 用例`)}`),
    actual.e2eCases,
    '开发节 e2e 用例数',
  )
  // 「327 个测试文件 / 2937 单测全绿」
  claim(/(\d+) 个测试文件 [\/／] \d+ 单测全绿/, actual.unitFiles, '测试文件数')
  claimUnitTests(/\d+ 个测试文件 [\/／] (\d+) 单测全绿/, '状态段单测数')

  console.log(`实测：${actual.unitFiles} 个测试文件 / ${actual.unitTests} 单测；${actual.e2eSpecs} e2e spec / ${actual.e2eCases} 用例`)

  if (mismatch.length > 0) {
    console.error('\ncheck:counts 失配（README 数字漂移，修 README 后再提交）：')
    for (const m of mismatch) console.error('  - ' + m)
    process.exit(1)
  }
  console.log('check:counts 通过：README 声称值与实测一致。')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
