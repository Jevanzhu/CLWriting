import { afterEach, expect, test, vi } from 'vitest'
import { embed } from '../../src/rag/embed.js'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('embed: 请求超时会 abort 并返回 null（降级不抛）', async () => {
  vi.useFakeTimers()
  let signal: AbortSignal | undefined
  const fetchMock = vi.fn((_endpoint: string | URL | Request, init?: RequestInit) => {
    signal = init?.signal instanceof AbortSignal ? init.signal : undefined
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })
  })
  vi.stubGlobal('fetch', fetchMock)

  const result = embed('https://example.invalid/embeddings', 'm', 'k', ['正文'], { timeoutMs: 5 })
  await vi.advanceTimersByTimeAsync(5)

  await expect(result).resolves.toBeNull()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(signal?.aborted).toBe(true)
})

test('embed: 正常响应返回向量', async () => {
  const fetchMock = vi.fn(async () => new Response(
    JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ))
  vi.stubGlobal('fetch', fetchMock)

  await expect(embed('https://example.invalid/embeddings', 'm', 'k', ['正文'])).resolves.toEqual([[1, 2, 3]])
})
