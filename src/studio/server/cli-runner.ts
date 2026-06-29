/** Studio 后端调用 clwriting CLI 的共享入口。 */
import { spawn } from 'node:child_process'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 定位 clwriting CLI spawn 目标（studio / Electron 双模式）。 */
export function resolveSpawnTarget(
  isElectron: boolean,
  here: string,
  argv1: string,
): { cliJs: string; useRunAsNode: boolean } {
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
