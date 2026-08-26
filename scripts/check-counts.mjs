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
 * e2e 用例静态计数：只数真实用例声明 test( / test.serial( / test.only( / test.fail( /
 * test.fixme(，排除 hook/describe/skip（test.beforeAll( 等点后缀会虚增——曾把 37 数成 56）；
 * 计数前剥注释/字符串（X-32），被注释/写进字符串的声明样例不再计入
 * R62-56：test.fail( / test.fixme( 也声明真实用例（期望失败/挂起的测试），此前漏数
 */
export function countE2eCases(src) {
  const m = stripStrings(stripComments(src)).match(
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
  const clean = stripStrings(stripComments(src))
  // R64-38（十二轮）：only 门正则补 `.each` 组合——`it.only.each([...])('t', fn)` 形态
  // 此前不被 `\s*\(` 匹配（only 后面是 .each），漏放行整个参数化组（其余用例静默跳过）。
  const only = clean.match(/(^|[^.\w])(?:it|test|describe)\.only(?:\.each)?\s*[({[]/g)
  const uncondSkip = clean.match(/(^|[^.\w])(?:it|test|describe)\.skip\s*\(\s*"/g)
  return { only: only ? only.length : 0, uncondSkip: uncondSkip ? uncondSkip.length : 0 }
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

// 门禁主体收进 main() + 直跑守卫：node 直跑本文件（npm run check:counts）时执行；
// 被测试 import（R63-12 直测纯函数）时不触发 vitest list / process.exit 副作用
function main() {
  const unitFiles = walk(join(root, 'test'), (n) => n.endsWith('.test.ts'))
  const e2eSpecs = walk(join(root, 'test', 'e2e'), (n) => n.endsWith('.spec.ts'))

  // vitest list --json：[{ fullName, ... }]（不执行用例）
  let vitestJson = ''
  try {
    vitestJson = execFileSync('npx', ['vitest', 'list', '--json'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (e) {
    console.error('check:counts：vitest list 执行失败（' + (e.message ?? String(e)) + '）')
    process.exit(1)
  }
  const unitTests = JSON.parse(vitestJson).length

  let e2eCases = 0
  for (const fp of e2eSpecs) e2eCases += countE2eCases(readFileSync(fp, 'utf8'))

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

  // 徽章：tests-2937%20all%20green（示例为 2026-08-23 当前值，实际以 README 为准）
  claim(/badge\/tests-(\d+)%20all%20green/, actual.unitTests, '徽章单测数')
  // 「npm test                   # 2937 单测」
  claim(/npm test\s+#\s*(\d+)\s*单测/, actual.unitTests, 'npm test 单测数')
  // 「vitest（2937 单测）+ Playwright（28 specs / 41 用例）」
  claim(/vitest（(\d+) 单测）/, actual.unitTests, '技术栈单测数')
  claim(/Playwright（(\d+) specs/, actual.e2eSpecs, 'Playwright spec 数')
  // dd-P3（E-P3-3）：锚定完整短语——裸 `(\d+) 用例）` 会命中 README 里任何以"用例）"结尾的数字
  claim(/Playwright（\d+ specs \/ (\d+) 用例）/, actual.e2eCases, 'Playwright 用例数')
  // P-11（第十四轮）：开发节 e2e 行此前是盲区——「Playwright e2e（mock 驱动，28 specs / 41 用例）」
  // 中间夹了「e2e（mock 驱动，」，不匹配上面的「Playwright（」模式，该行漂移时门禁仍绿
  claim(/Playwright e2e（mock 驱动，(\d+) specs \/ \d+ 用例）/, actual.e2eSpecs, '开发节 e2e spec 数')
  claim(/Playwright e2e（mock 驱动，\d+ specs \/ (\d+) 用例）/, actual.e2eCases, '开发节 e2e 用例数')
  // 「327 个测试文件 / 2937 单测全绿」
  claim(/(\d+) 个测试文件 \/ \d+ 单测全绿/, actual.unitFiles, '测试文件数')
  claim(/\d+ 个测试文件 \/ (\d+) 单测全绿/, actual.unitTests, '状态段单测数')

  console.log(`实测：${actual.unitFiles} 个测试文件 / ${actual.unitTests} 单测；${actual.e2eSpecs} e2e spec / ${actual.e2eCases} 用例`)

  if (mismatch.length > 0) {
    console.error('\ncheck:counts 失配（README 数字漂移，修 README 后再提交）：')
    for (const m of mismatch) console.error('  - ' + m)
    process.exit(1)
  }
  console.log('check:counts 通过：README 声称值与实测一致。')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
