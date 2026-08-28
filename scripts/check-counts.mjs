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
import { join } from 'node:path'
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
// 字符串字面量内容清空（保留空串定界符维持词法形态）：标题/说明文本不参与匹配
export function stripStrings(src) {
  return src.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""')
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
  const skipPlain = clean.match(/(^|[^.\w])(?:it|test|describe)\.skip\s*\(\s*"/g)
  const skipEach = clean.match(/(^|[^.\w])(?:it|test|describe)\.skip\.each\s*\([^)]*\)\s*\(\s*"/g)
  return { only: only ? only.length : 0, uncondSkip: (skipPlain?.length ?? 0) + (skipEach?.length ?? 0) }
}

/** 递归收集文件 */
function walk(dir, pred, out = []) {
  for (const name of readdirSync(dir)) {
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
// 下按 spec 路径字典序串行跑，前一个建的书/写的内容供后一个用——顺序是隐式契约
// （README「勿加并行或改动 spec 顺序」此前只有注释、无机器守卫）。
// 快照按代码单元排序（Array.prototype.sort 默认序，与 playwright 的文件排序同基），
// 锁相对路径：新增/改名/删除任何 spec 都会改变名单或字典序位 → 失配红，
// 逼改动者显式确认「插序是否破坏前序 spec 的落盘依赖」后再同步快照。
// 【快照 = 2026-08-27 工作区实测清单（含并行批新增 settings-book-scope.spec.ts）】
const E2E_SPEC_ORDER_SNAPSHOT = [
  'test/e2e/ai-degrade.spec.ts',
  'test/e2e/ai-provider.spec.ts',
  'test/e2e/ai-review.spec.ts',
  'test/e2e/analysis.spec.ts',
  'test/e2e/audit.spec.ts',
  'test/e2e/auto-write.spec.ts',
  'test/e2e/batch-finalize.spec.ts',
  'test/e2e/check.spec.ts',
  'test/e2e/conflict.spec.ts',
  'test/e2e/edit-save.spec.ts',
  'test/e2e/export-ai-settings.spec.ts',
  'test/e2e/finalize.spec.ts',
  'test/e2e/focus.spec.ts',
  'test/e2e/foreshadow.spec.ts',
  'test/e2e/learn.spec.ts',
  'test/e2e/overview-short.spec.ts',
  'test/e2e/release-smoke.spec.ts',
  'test/e2e/rewrite.spec.ts',
  'test/e2e/search.spec.ts',
  'test/e2e/settings-book-scope.spec.ts',
  'test/e2e/shelf-search.spec.ts',
  'test/e2e/shelf.spec.ts',
  'test/e2e/short-flow.spec.ts',
  'test/e2e/short-full-flow.spec.ts',
  'test/e2e/switch-book.spec.ts',
  'test/e2e/tree-issues.spec.ts',
  'test/e2e/tree-ops.spec.ts',
  'test/e2e/usage-card.spec.ts',
  'test/e2e/version-restore.spec.ts',
]

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
  // spec 名单/字典序位与快照失配即红：新 spec 插序改变 workers:1 下的执行顺序，
  // 前序 spec 的落盘依赖可能静默错位——须人工确认后同步 E2E_SPEC_ORDER_SNAPSHOT。
  const { added: specAdded, removed: specRemoved } = diffSpecOrder(
    e2eSpecs.map((fp) => fp.replace(root, '')),
    E2E_SPEC_ORDER_SNAPSHOT,
  )
  if (specAdded.length > 0 || specRemoved.length > 0) {
    console.error('\ncheck:counts 失败：e2e spec 名单/顺序与快照失配（R66-37）——')
    console.error('  spec 按 workers:1 字典序串行跑且共享单一 workDir，顺序是隐式契约（README「勿改动 spec 顺序」）。')
    console.error('  新增/改名 spec 前请确认其字典序位不破坏前序 spec 的落盘依赖，再同步本快照：')
    for (const p of specAdded) console.error('  + 新增（当前在跑，快照缺）: ' + p)
    for (const p of specRemoved) console.error('  - 移除（快照有，当前缺）: ' + p)
    process.exit(1)
  }

  // ── .only / 无条件 .skip 拒绝 ─────────────────────
  const onlyHits = []
  for (const fp of [...unitFiles, ...e2eSpecs]) {
    const { only, uncondSkip } = findOnlyOrSkipViolations(readFileSync(fp, 'utf8'))
    const n = only + uncondSkip
    if (n > 0) onlyHits.push(`${fp.replace(root, '')}（${n} 处）`)
  }
  if (onlyHits.length > 0) {
    console.error('\ncheck:counts 失败：发现 .only 或无条件 .skip 用例（提交前移除——其余用例会被静默跳过，门禁假绿；环境门条件式 skip 可豁免）：')
    for (const h of onlyHits) console.error('  - ' + h)
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
  // 徽章：tests-2937%20all%20green（示例为 2026-08-23 当前值，实际以 README 为准）
  claim(/badge\/tests-(\d+)%20all%20green/, actual.unitTests, '徽章单测数')
  // 「npm test                   # 2937 单测」
  claim(/npm test\s+[#＃]\s*(\d+)\s*单测/, actual.unitTests, 'npm test 单测数')
  // 「vitest（2937 单测）+ Playwright（28 specs / 41 用例）」
  claim(new RegExp(`vitest${PH('(\\d+) 单测')}`), actual.unitTests, '技术栈单测数')
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
  claim(/\d+ 个测试文件 [\/／] (\d+) 单测全绿/, actual.unitTests, '状态段单测数')

  console.log(`实测：${actual.unitFiles} 个测试文件 / ${actual.unitTests} 单测；${actual.e2eSpecs} e2e spec / ${actual.e2eCases} 用例`)

  if (mismatch.length > 0) {
    console.error('\ncheck:counts 失配（README 数字漂移，修 README 后再提交）：')
    for (const m of mismatch) console.error('  - ' + m)
    process.exit(1)
  }
  console.log('check:counts 通过：README 声称值与实测一致。')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
