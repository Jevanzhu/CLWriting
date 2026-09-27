/**
 * embed 降级原因分流回归：异常（网络/解析）与超时（abort）走不同留痕文案。
 *
 * 此前一律「网络/解析异常」——端点只是慢（未坏）时作者无从判断该调大书级
 * rag.embed_timeout_ms 还是查网络。判据：fetch 拒绝 / 响应体非 JSON 等异常落
 * 「网络/解析异常」；超时定时器 abort 路径落「embedding 请求超时（N）」，且 N ≥ 1000ms
 * 按秒格式化（配置项单位是毫秒，秒读起来更贴人）。两路都返回 null（降级不抛）。
 */
import { afterEach, expect, test, vi } from 'vitest'
import { embed } from '../../src/rag/embed.js'
import { log } from '../../src/log/index.js'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 代理环境变量清空——免旁生 warn 干扰文案断言 */
function clearProxyEnvs(): void {
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) vi.stubEnv(k, '')
}

/** 本次调用落下的 rag 留痕文案（按 tag 取） */
function ragWarn(warn: { mock: { calls: unknown[][] } }): string[] {
  return warn.mock.calls.filter((c) => c[0] === 'rag').map((c) => String(c[1]))
}

test('fetch 拒绝（网络不可达/连接被断）→ null + 留痕「网络/解析异常」，不误报超时', async () => {
  clearProxyEnvs()
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('fetch failed')
    }),
  )

  await expect(embed('https://net-down.example/embeddings', 'm', 'k', ['正文'])).resolves.toBeNull()

  const msgs = ragWarn(warn)
  expect(msgs.some((m) => m.includes('网络/解析异常'))).toBe(true)
  expect(msgs.some((m) => m.includes('请求超时'))).toBe(false)
})

test('200 但响应体非 JSON（解析抛）→ null + 留痕「网络/解析异常」', async () => {
  clearProxyEnvs()
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{ 这不是 JSON', { status: 200, headers: { 'Content-Type': 'application/json' } })),
  )

  await expect(embed('https://bad-json.example/embeddings', 'm', 'k', ['正文'])).resolves.toBeNull()

  const msgs = ragWarn(warn)
  expect(msgs.some((m) => m.includes('网络/解析异常'))).toBe(true)
  expect(msgs.some((m) => m.includes('请求超时'))).toBe(false)
})

test('超时 abort（2000ms ≥ 1s）→ null + 留痕「请求超时（2s）」并指路 rag.embed_timeout_ms', async () => {
  clearProxyEnvs()
  vi.useFakeTimers()
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_endpoint: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        }),
    ),
  )

  const pending = embed('https://slow-endpoint.example/embeddings', 'm', 'k', ['正文'], { timeoutMs: 2000 })
  await vi.advanceTimersByTimeAsync(2000)

  await expect(pending).resolves.toBeNull()
  const msgs = ragWarn(warn)
  expect(msgs.some((m) => m.includes('embedding 请求超时（2s）'))).toBe(true)
  expect(msgs.some((m) => m.includes('rag.embed_timeout_ms'))).toBe(true)
  expect(msgs.some((m) => m.includes('网络/解析异常'))).toBe(false)
})
