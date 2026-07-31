/** Studio 后端调用 clwriting CLI 的共享入口。 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 定位 clwriting CLI spawn 目标（studio / Electron 双模式）。
 *  dev(here=src/studio/server/)与 prod 都优先向上查找 dist/cli.js（tsup 产物），
 *  避免 dev:api 模式下 process.argv[1] 误指向 scripts/dev-api.ts（server 脚本，非 CLI）。 */
export function resolveSpawnTarget(
  isElectron: boolean,
  here: string,
  argv1: string,
): { cliJs: string; useRunAsNode: boolean } {
  // 从 here 逐级向上查找 dist/cli.js（dev: src/studio/server → 3 层到根; prod: 可能已在 dist/ 内）
  let dir = here
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(dir, 'dist', 'cli.js')
    if (existsSync(candidate)) return { cliJs: candidate, useRunAsNode: isElectron }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // 回退：Electron 用 here 推导；非 Electron 用 argv1（prod 直接 CLI 运行时已是 dist/cli.js）
  if (!isElectron) return { cliJs: argv1, useRunAsNode: false }
  const cliJs = basename(here) === 'dist'
    ? resolve(here, 'cli.js')
    : resolve(here, '..', 'cli.js')
  return { cliJs, useRunAsNode: true }
}

/** spawn clwriting CLI 跑确定性命令。Electron 下必须打开 ELECTRON_RUN_AS_NODE。 */
export function runClwritingCli(
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
  const { cliJs, useRunAsNode } = resolveSpawnTarget(
    !!process.versions.electron,
    here,
    process.argv[1] as string,
  )
  const env = useRunAsNode ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [cliJs, ...args], { cwd, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => {
      stdout += c.toString()
    })
    child.stderr.on('data', (c) => {
      stderr += c.toString()
    })
    child.on('error', (e) => resolveP({ ok: false, code: -1, stdout, stderr: e.message }))
    child.on('close', (code) => resolveP({ ok: code === 0, code: code ?? 0, stdout, stderr }))
  })
}
