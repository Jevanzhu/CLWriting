/**
 * RB-SV-P2-3 回归：编译入口 server-main 的监听错误兜底与实际端口日志。
 *
 * 子进程方式跑真实入口（tsx 编译执行 src/desktop/server-main.ts）：
 * - 端口被占（EADDRINUSE）→ 进程退出码 1 + stderr 中文可读报错（此前未捕获异常崩溃）
 * - --port 0 随机端口 → 日志打印实际监听端口（此前打印配置值 0），且该端口真实可服务
 *
 * 注意：stdout/stderr 通过可变对象累积再返回——字符串按值快照，若直接返回
 * `let` 变量，闭包内的 `+=` 重绑定不会反映到调用方拿到的副本上。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, it, expect } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const tsxCli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const serverMainTs = join(repoRoot, 'src', 'desktop', 'server-main.ts')

const children: ChildProcess[] = []
const tmpDirs: string[] = []

afterAll(() => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL')
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

/** 起 server-main 子进程，收集 stdout/stderr（累积到可变对象，避免字符串快照失效）。 */
function spawnServerMain(args: string[]): { child: ChildProcess; out: { stdout: string; stderr: string } } {
  const child = spawn(process.execPath, [tsxCli, serverMainTs, ...args], {
    cwd: repoRoot,
    env: { ...process.env, CLWRITING_DRIVER: 'mock' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  const out = { stdout: '', stderr: '' }
  child.stdout?.on('data', (d) => (out.stdout += String(d)))
  child.stderr?.on('data', (d) => (out.stderr += String(d)))
  return { child, out }
}

function makeWorkDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'clwriting-srvmain-'))
  mkdirSync(join(dir, '.clwriting'), { recursive: true })
  tmpDirs.push(dir)
  return dir
}

describe('RB-SV-P2-3 server-main 监听错误兜底', () => {
  it('端口被占（EADDRINUSE）→ 退出码 1 + 中文报错，而非未捕获异常', async () => {
    // 先占住一个端口
    const blocker = http.createServer((_req, res) => res.end('blocker'))
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r))
    const busyPort = (blocker.address() as AddressInfo).port
    try {
      const { child, out } = spawnServerMain(['--dir', makeWorkDir(), '--port', String(busyPort)])
      const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)))
      expect(code).toBe(1)
      expect(out.stderr).toContain('EADDRINUSE')
      expect(out.stderr).toContain('端口')
      expect(out.stderr).toContain(String(busyPort))
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()))
    }
  }, 30_000)

  it('--port 0 随机端口 → 日志打印实际监听端口，该端口真实可服务', async () => {
    const { child, out } = spawnServerMain(['--dir', makeWorkDir(), '--port', '0'])
    // 等 ready 日志行（进程冷启动 + 模块加载，给足 20s）
    const line = await new Promise<string>((resolveLine, rejectLine) => {
      const timer = setTimeout(() => rejectLine(new Error(`server-main 未就绪。stdout: ${out.stdout}`)), 20_000)
      const poll = (): void => {
        const m = out.stdout.match(/\[server-main\] ready on http:\/\/127\.0\.0\.1:(\d+)/)
        if (m) {
          clearTimeout(timer)
          resolveLine(m[0])
          return
        }
        setTimeout(poll, 200)
      }
      poll()
    })
    const port = Number(line.match(/:(\d+)/)![1])
    expect(port).toBeGreaterThan(0) // 实际端口（修复前打印配置值 0）
    // 该端口真实可服务：boot 直连（无 Origin → 带 token 返回）
    const boot = await fetch(`http://127.0.0.1:${port}/api/boot`)
    expect(boot.ok).toBe(true)
    const body = (await boot.json()) as { token: string }
    expect(body.token).toBeTruthy()
    child.kill('SIGTERM')
    await new Promise<void>((r) => child.on('exit', () => r()))
  }, 30_000)
})
