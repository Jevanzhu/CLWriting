#!/usr/bin/env node
/**
 * RC 全项目重审（GLM-5.3，2026-09-20）P3：test:related 防呆 wrapper。
 *
 * 背景：`vitest related --run <路径>` 在路径写错/文件与测试图无关时打印
 * "No test files found" 后**退出码 0**（静默空跑假绿）——CLAUDE.md L1 纪律此前只有
 * 一句括号警示，无机械防呆，错路径 = 相关面测试面以为跑了实际零跑。本 wrapper 三闸：
 *   ① 零参数即红（用法错误不该静默）；
 *   ② 参数中的路径（非选项）不存在即红（最常见形态：路径写错）；
 *   ③ 输出扫描 "No test files found" 终态即红（路径存在但与测试图无关的形态）。
 * 用法不变：`npm run test:related -- <改动文件>…`。透传 vitest 退出码。
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('[test-related] 未传改动文件——用法：npm run test:related -- <改动文件>…（零参数是用法错误，不静默空跑）')
  process.exit(1)
}
const missing = args.filter((a) => !a.startsWith('-') && !existsSync(resolve(process.cwd(), a)))
if (missing.length > 0) {
  console.error(`[test-related] 参数路径不存在（静默空跑防呆，先核对路径）：${missing.join('、')}`)
  process.exit(1)
}

// 直驱 vitest.mjs（避免 npx/shell 的跨平台与路径含空格引号问题）
const vitestMjs = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
if (!existsSync(vitestMjs)) {
  console.error(`[test-related] 找不到 vitest 入口：${vitestMjs}（依赖未装齐？先 npm install）`)
  process.exit(1)
}
const r = spawnSync(process.execPath, [vitestMjs, 'related', '--run', ...args], {
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
})
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
process.stdout.write(r.stdout ?? '')
process.stderr.write(r.stderr ?? '')
const code = r.status ?? 1
// ③ 路径存在但与测试图无关 → vitest 仍可能退出 0（静默空跑根形态），输出扫描兜底
if (code === 0 && /no test files found/i.test(out)) {
  console.error('[test-related] vitest 报 "No test files found" 且退出 0——路径与测试图无关（静默空跑），按失败处理；如确要跑请核对文件或直接用 npm test')
  process.exit(1)
}
process.exit(code)
