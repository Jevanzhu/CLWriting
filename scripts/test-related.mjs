#!/usr/bin/env node
/**
 * test:related wrapper：防呆三闸 + 文本引用兜底选择。
 *
 * 防呆（`vitest related --run <路径>` 在路径写错/文件与测试图无关时打印
 * "No test files found" 后**退出码 0**，静默空跑假绿）：
 *   ① 零参数即红（用法错误不该静默）；
 *   ② 参数中的路径（非选项）不存在即红（最常见形态：路径写错）；
 *   ③ 输出扫描 "No test files found" 终态即红（路径存在但与测试图无关的形态）。
 * 用法：`npm run test:related -- <改动文件>…`。透传 vitest 退出码。
 *
 * 兜底选择的理由：vitest 的 related 只认**静态 import 边**，下面两类档改了 src 也不会
 * 被选中——它们的关联只存在于**测试档正文的字符串里**：
 *   1. 按文本读 src 的形态：把源文件路径当字符串做正则/包含断言，写法既可能是仓库
 *      相对全路径，也可能是被引号逗号切开的目录段 + 文件名（`read('document', 'service.ts')`）；
 *   2. 经 spawn/子进程 eval 把 src 路径当字符串传进子进程的形态（`../../src/ai/calls.ts`）。
 * 兜底 = 扫 test 目录下全部测试档正文，把正文命中本轮任一改动文件路径的档并入本次运行。
 *
 * 匹配口径：取改动路径的**末两段**（如 `document` 与 `service.ts`），两段之间允许由
 * 非标识符字符粘连（斜杠、反斜杠、引号、逗号、空白、`)` 等不超过 8 个），故上述两种
 * 写法都命中；仓库相对全路径字面量与 `../../src/…` 前缀形态是它的子集。
 *
 * 边界（勿夸大保证）：这是**文本命中**，不是静态闭包算法——不解析 AST、不追踪动态
 * 拼接，路径由纯变量/模板串拼出且无字面量段的档仍可能漏选；反向也可能多选（同一路径
 * 出现在注释、文档串或同名声明的别处）。方向是宁多勿漏：多选只多跑几档，漏选才是
 * 「改了 src 而相关面没跑」。开销实测：读全量 1300+ 档约 0.2s，命中宽度均值 0.87 档、
 * 最大 40 档（argv 增量 < 2KB）——单次读完即判，无需缓存或上限。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const args = process.argv.slice(2)
if (args.length === 0) {
  console.error(
    '[test-related] 未传改动文件——用法：npm run test:related -- <改动文件>…（零参数是用法错误，不静默空跑）',
  )
  process.exit(1)
}
const changed = args.filter((a) => !a.startsWith('-'))
const missing = changed.filter((a) => !existsSync(resolve(root, a)))
if (missing.length > 0) {
  console.error(`[test-related] 参数路径不存在（静默空跑防呆，先核对路径）：${missing.join('、')}`)
  process.exit(1)
}

/** 改动路径 → 正文命中式（末两段、段间允许非标识符字符粘连；口径见文件头注）。
 *  无可用段（路径为 `.` / `..` 等纯占位）时返回 null，由调用方跳过。 */
function pathMatcher(relPosix) {
  const segs = relPosix.split('/').filter((s) => s !== '' && s !== '.' && s !== '..')
  if (segs.length === 0) return null
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(segs.slice(-2).map(esc).join('[^\\p{L}\\p{N}_$]{0,8}'), 'u')
}

/** 扫 test/ 下全部 `*.test.ts` 正文，返回正文命中任一改动路径的档（仓库相对 posix 路径）。 */
function scanTextReferences(changedSet) {
  const matchers = [...changedSet].map(pathMatcher).filter((m) => m !== null)
  if (matchers.length === 0) return []
  const hits = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      // `._*` 是 macOS 外置卷的 AppleDouble 伴生文件，与 vitest exclude 同口径排除
      if (e.name === 'node_modules' || e.name.startsWith('._')) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        walk(p)
        continue
      }
      if (!e.name.endsWith('.test.ts')) continue
      const rel = relative(root, p).split(sep).join('/')
      // 本就在改动清单里的档无需兜底并入（避免自指）
      if (changedSet.has(rel)) continue
      const text = readFileSync(p, 'utf8')
      if (matchers.some((m) => m.test(text))) hits.push(rel)
    }
  }
  walk(join(root, 'test'))
  return hits
}

const changedPosix = new Set(
  changed.map((a) => relative(root, resolve(root, a)).split(sep).join('/')),
)
const fallback = scanTextReferences(changedPosix)
if (fallback.length > 0) {
  process.stderr.write(
    `[test-related] 文本引用兜底并入 ${fallback.length} 档（related 静态图看不见，理由与边界见脚本头注）：${fallback.join('、')}\n`,
  )
}

// 直驱 vitest.mjs（避免 npx/shell 的跨平台与路径含空格引号问题）。
// 兜底档作为 additional positional 一并传给 related：related 的受影响集合以入参路径
// 自身为种子（再反向展开 import 边），故测试档路径入参即等于「本轮必跑该档」。
const vitestMjs = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
if (!existsSync(vitestMjs)) {
  console.error(`[test-related] 找不到 vitest 入口：${vitestMjs}（依赖未装齐？先 npm install）`)
  process.exit(1)
}
const r = spawnSync(process.execPath, [vitestMjs, 'related', '--run', ...args, ...fallback], {
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
})
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
process.stdout.write(r.stdout ?? '')
process.stderr.write(r.stderr ?? '')
const code = r.status ?? 1
// ③ 路径存在但与测试图无关 → vitest 仍可能退出 0（静默空跑根形态），输出扫描兜底
if (code === 0 && /no test files found/i.test(out)) {
  console.error(
    '[test-related] vitest 报 "No test files found" 且退出 0——路径与测试图无关（静默空跑），按失败处理；如确要跑请核对文件或直接用 npm test',
  )
  process.exit(1)
}
process.exit(code)
