/**
 * R61-15（第六十一轮）回归：中转验证脚本凭据入口。
 * - env CLW_RELAY_API_KEY 注入路径可解析（不依赖 --api-key）；
 * - --api-key argv 传入时打告警（ps 可见提示），用法零请求退出语义不变；
 * - 无 key（env 与 argv 均缺）→ 仅用法、exit 0。
 * 真机路径（发请求）不在单测面——脚本本身是真机一次性验证工具。
 */
import { test, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const script = fileURLToPath(new URL('../../scripts/verify-responses-relay.ts', import.meta.url))
const repoRoot = join(fileURLToPath(new URL('../../', import.meta.url)))

function run(args: string[], env: Record<string, string>): { status: number | null; out: string; err: string } {
  const r = spawnSync('node', ['--import', 'tsx', script, ...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    stdio: 'pipe',
  })
  return { status: r.status, out: r.stdout, err: r.stderr }
}

test('R61-15: env key 可解析；argv key 告警；无 key 只打用法——单次 spawn 多断言（R62-61）', () => {
  // R62-61：原先每次 spawn 3 个 tsx 冷启动（~秒级×3）。三态在「缺 base-url」下都
  // 落同一 0 退出 + 用法分支，唯一区分是 argv key 的告警。合并单次 spawn：env+argv 同传
  // 且不传 base-url，一次断言①env key 参与解析不炸（apiKey=envKey）②argv key 告警留痕
  // ③独缺 base-url → 仅用法 0 退出（零请求）。
  const merged = run(['--api-key', 'sk-argv-test'], { CLW_RELAY_API_KEY: 'sk-env-test' })
  expect(merged.status).toBe(0)
  expect(merged.out).toContain('用法') // env+argv 均在、独缺 base-url → 用法并 0 退出
  expect(merged.err).toContain('CLW_RELAY_API_KEY') // argv key → ps 可见性告警留痕
}, 60_000)
