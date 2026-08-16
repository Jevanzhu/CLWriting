/**
 * RB-SV-P2-6 回归：优雅退出清理（src/desktop/graceful-shutdown.ts）。
 *
 * - 书库内每本书的中断入口（abortSelfHeal/abortChat）都被调用（vi.mock 隔离记录，
 *   与 self-heal-f2 的 mock 风格一致）
 * - 无残留连接：server 正常 close 完成
 * - 有 SSE/keep-alive 残留连接：close 回调悬置 → 按超时上限放行（不卡死退出）
 */
import http from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest'
import { shutdownStudio } from '../../src/desktop/graceful-shutdown.js'
import { abortSelfHeal } from '../../src/ai/orchestrate/self-heal.js'
import { abortChat } from '../../src/ai/orchestrate/chat.js'

vi.mock('../../src/ai/orchestrate/self-heal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ai/orchestrate/self-heal.js')>()
  return { ...actual, abortSelfHeal: vi.fn(actual.abortSelfHeal) }
})
vi.mock('../../src/ai/orchestrate/chat.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ai/orchestrate/chat.js')>()
  return { ...actual, abortChat: vi.fn(actual.abortChat) }
})

let workDir = ''

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-shutdown-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: '书甲', path: '书甲', kind: 'long' }) + '\n' +
      JSON.stringify({ name: '书乙', path: '书乙', kind: 'long' }) + '\n',
  )
})

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

/** 起一个挂起响应的 server（模拟 SSE：连接建立后不结束）。 */
function makeHangServer(): Promise<http.Server> {
  return new Promise((resolveP) => {
    const s = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': hold\n\n') // 挂起不 end——close 回调将等待该连接
    })
    s.listen(0, '127.0.0.1', () => resolveP(s))
  })
}

describe('RB-SV-P2-6 shutdownStudio', () => {
  it('书库内每本书的中断入口都被调用；server 为 null 时安全跳过', async () => {
    vi.mocked(abortSelfHeal).mockClear()
    vi.mocked(abortChat).mockClear()
    await shutdownStudio(() => workDir, null)
    const names = vi.mocked(abortSelfHeal).mock.calls.map((c) => c[0])
    expect(names).toContain('书甲')
    expect(names).toContain('书乙')
    expect(vi.mocked(abortChat).mock.calls.map((c) => c[0])).toEqual(names)
  })

  it('无残留连接：close 正常完成，此后连接被拒', async () => {
    const server = http.createServer((_req, res) => res.end('ok'))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    await shutdownStudio(() => null, server)
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
  })

  it('有挂起连接：close 回调悬置 → 按超时上限放行，不卡死', async () => {
    const server = await makeHangServer()
    const port = (server.address() as { port: number }).port
    // 建立一条不读不停的连接（模拟 SSE 客户端在退出时未及断开）
    const conn = http.get({ host: '127.0.0.1', port, path: '/hold' }, () => {})
    await new Promise((r) => setTimeout(r, 100))
    const start = Date.now()
    await shutdownStudio(() => null, server, { closeTimeoutMs: 150 })
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(120) // 确实走了超时放行而非秒回
    expect(elapsed).toBeLessThan(3_000) // 且被上限兜住
    conn.destroy()
  })
})
