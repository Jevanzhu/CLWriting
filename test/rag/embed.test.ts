import { afterEach, expect, test, vi } from 'vitest'
import { embed } from '../../src/rag/embed.js'
import { log } from '../../src/log/index.js'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
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

// ── R62-3：index 归位（OpenAI 兼容协议 data[] 数组顺序无契约，乱序端点按位对齐会错配） ──

test('R62-3：端点乱序返回（index 1 在前）→ 按 index 归位对齐输入序（修复前按位错配，向量永久配错块毒化索引）', async () => {
  const fetchMock = vi.fn(async () => new Response(
    JSON.stringify({
      data: [
        { embedding: [9, 9, 9], index: 1 },
        { embedding: [1, 1, 1], index: 0 },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ))
  vi.stubGlobal('fetch', fetchMock)

  await expect(embed('https://shuffle.example/embeddings', 'm', 'k', ['甲文', '乙文'])).resolves.toEqual([
    [1, 1, 1],
    [9, 9, 9],
  ])
})

test('R62-3：全部条目不带 index → 回落按位对齐（非标端点兼容，与旧行为一致）', async () => {
  const fetchMock = vi.fn(async () => new Response(
    JSON.stringify({ data: [{ embedding: [1, 1, 1] }, { embedding: [9, 9, 9] }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ))
  vi.stubGlobal('fetch', fetchMock)

  await expect(embed('https://no-index.example/embeddings', 'm', 'k', ['甲文', '乙文'])).resolves.toEqual([
    [1, 1, 1],
    [9, 9, 9],
  ])
})

test('R62-3：index 重复留洞 → null；index 形态混杂（部分带部分不带）→ null', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ data: [{ embedding: [1, 1, 1], index: 0 }, { embedding: [9, 9, 9], index: 0 }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )))
  await expect(embed('https://dup-index.example/embeddings', 'm', 'k', ['甲文', '乙文'])).resolves.toBeNull()

  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ data: [{ embedding: [1, 1, 1], index: 0 }, { embedding: [9, 9, 9] }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )))
  await expect(embed('https://mixed-index.example/embeddings', 'm', 'k', ['甲文', '乙文'])).resolves.toBeNull()
})

// ── R62-4：用量回报 + 失败留痕（此前全静默，作者只见「召回为空」无从定位） ──

test('R62-4：usage.prompt_tokens → onUsage 回调一次；响应无 usage 段不回调', async () => {
  const onUsage = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ data: [{ embedding: [1, 2, 3] }], usage: { prompt_tokens: 123 } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )))
  await expect(
    embed('https://usage.example/embeddings', 'm', 'k', ['正文'], { onUsage }),
  ).resolves.toEqual([[1, 2, 3]])
  expect(onUsage).toHaveBeenCalledTimes(1)
  expect(onUsage).toHaveBeenCalledWith(123)

  const onUsage2 = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )))
  await expect(
    embed('https://usage.example/embeddings', 'm', 'k', ['正文'], { onUsage: onUsage2 }),
  ).resolves.toEqual([[1, 2, 3]])
  expect(onUsage2).not.toHaveBeenCalled()
})

test('R62-4：HTTP 失败 log.warn 留痕 + 同端点 60s 去抖（两次失败只留痕一次）', async () => {
  const warn = vi.spyOn(log, 'warn')
  vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))

  await expect(embed('https://fail-dedup.example/embeddings', 'm', 'k', ['正文'])).resolves.toBeNull()
  await expect(embed('https://fail-dedup.example/embeddings', 'm', 'k', ['正文'])).resolves.toBeNull()

  expect(warn).toHaveBeenCalledTimes(1) // 第二次落在 60s 去抖窗内，不刷屏
  expect(warn.mock.calls[0]![1]).toContain('HTTP 500')
})
