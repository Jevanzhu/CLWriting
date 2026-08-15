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
 * 用法：npm run check:counts（退出码 1 = 失配，并列出实测值供修 README）
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath 解码百分号编码（工作区路径含 ^ 时 pathname 会带 %5E，scandir 直接 ENOENT）
const root = fileURLToPath(new URL('..', import.meta.url))

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

// e2e 用例静态计数：只数真实用例声明 test( / test.serial( / test.only(，
// 排除 hook/describe/skip（test.beforeAll( 等点后缀会虚增——曾把 37 数成 56）
let e2eCases = 0
for (const fp of e2eSpecs) {
  const src = readFileSync(fp, 'utf8')
  const m = src.match(/(^|[^.\w])(?:test|test\.serial|test\.only)\s*\(/g)
  e2eCases += m ? m.length : 0
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

// 徽章：tests-1536%20all%20green
claim(/badge\/tests-(\d+)%20all%20green/, actual.unitTests, '徽章单测数')
// 「npm test                   # 1536 单测」
claim(/npm test\s+#\s*(\d+)\s*单测/, actual.unitTests, 'npm test 单测数')
// 「vitest（1536 单测）+ Playwright（25 specs / 37 用例）」
claim(/vitest（(\d+) 单测）/, actual.unitTests, '技术栈单测数')
claim(/Playwright（(\d+) specs/, actual.e2eSpecs, 'Playwright spec 数')
claim(/(\d+) 用例）/, actual.e2eCases, 'Playwright 用例数')
// 「167 个测试文件 / 1536 单测全绿」
claim(/(\d+) 个测试文件 \/ \d+ 单测全绿/, actual.unitFiles, '测试文件数')
claim(/\d+ 个测试文件 \/ (\d+) 单测全绿/, actual.unitTests, '状态段单测数')

console.log(`实测：${actual.unitFiles} 个测试文件 / ${actual.unitTests} 单测；${actual.e2eSpecs} e2e spec / ${actual.e2eCases} 用例`)

if (mismatch.length > 0) {
  console.error('\ncheck:counts 失配（README 数字漂移，修 README 后再提交）：')
  for (const m of mismatch) console.error('  - ' + m)
  process.exit(1)
}
console.log('check:counts 通过：README 声称值与实测一致。')
