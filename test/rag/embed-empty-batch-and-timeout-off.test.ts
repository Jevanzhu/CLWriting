/**
 * embed 空批与「关闭超时」两条边界回归。
 *
 * 1) texts 为空 → 直接返回空数组且零出站：空批不该产生网络请求，也就不该落任何留痕
 *   （含出站代理环境变量那条一次性提示——它挂在真正出站前）。
 * 2) timeoutMs ≤ 0 → 不启用超时（契约见 EmbedOptions）：请求不挂 abort 信号，端点慢也
 *    不被本函数中断，正常响应照常返回向量。
 */
import { afterEach, expect, test, vi } from 'vitest'
import { embed } from '../../src/rag/embed.js'
import { log } from '../../src/log/index.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const OK_RESP = (): Response =>
  new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

test('空 texts → 返回空数组、零出站、零留痕（代理环境变量提示也不触发）', async () => {
  // 代理环境变量非空：若空批走到出站前的检测，这里就会多一条一次性提示
  vi.stubEnv('HTTPS_PROXY', 'http://user:secret@127.0.0.1:7890')
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
  const onUsage = vi.fn()
  const fetchMock = vi.fn(async () => OK_RESP())
  vi.stubGlobal('fetch', fetchMock)

  await expect(embed('https://empty-batch.example/embeddings', 'm', 'k', [], { onUsage })).resolves.toEqual([])

  expect(fetchMock).not.toHaveBeenCalled()
  expect(warn).not.toHaveBeenCalled()
  expect(onUsage).not.toHaveBeenCalled()
})

test('timeoutMs ≤ 0 → 不启用超时：请求不带 abort 信号，响应照常返回向量', async () => {
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) vi.stubEnv(k, '')
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
  const signals: Array<AbortSignal | null> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_endpoint: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal ?? null)
      return OK_RESP()
    }),
  )

  await expect(embed('https://no-timeout-0.example/embeddings', 'm', 'k', ['正文'], { timeoutMs: 0 })).resolves.toEqual(
    [[1, 2, 3]],
  )
  await expect(
    embed('https://no-timeout-neg.example/embeddings', 'm', 'k', ['正文'], { timeoutMs: -1 }),
  ).resolves.toEqual([[1, 2, 3]])

  expect(signals).toEqual([null, null]) // 无超时中断源
  expect(warn).not.toHaveBeenCalled()
})
