/**
 * embed 响应条数校验回归：HTTP 200 但 data 段缺失 / 条数与请求不等 → 判整批失败（null）
 * 并留痕实得条数。
 *
 * 条数与请求不齐（网关截断、批次端点少回、响应缺 data 段）若按成功收口，调用方会拿到
 * 与文本块错位的向量；本出口判失败后 buildIndex 整批不入库、游标不推进。留痕文案带
 * 「实得 N ≠ 请求 M」与端点串，作者据此可判断是端点坏还是批次过大。用量回调同批不回报
 *（失败批不记账）。
 */
import { afterEach, expect, test, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { embed } from '../../src/rag/embed.js'
import { log } from '../../src/log/index.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 200 + 指定 JSON 体的桩（代理环境变量清空，免旁生 warn） */
function stubJson(body: unknown): void {
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) vi.stubEnv(k, '')
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ),
  )
}

/** 断言留痕文案（返回命中的那条，未命中即失败） */
function failureWarn(warn: MockInstance): string {
  const hit = warn.mock.calls.map((c) => String(c[1])).find((m) => m.includes('响应条数'))
  expect(hit).toBeDefined()
  return hit as string
}

test('200 但响应缺 data 段 → null + 留痕「实得 0 条」；用量不回报', async () => {
  stubJson({ usage: { prompt_tokens: 99 } })
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
  const onUsage = vi.fn()

  await expect(embed('https://count-missing.example/embeddings', 'm', 'k', ['正文'], { onUsage })).resolves.toBeNull()

  const msg = failureWarn(warn)
  expect(msg).toContain('响应条数 0 ≠ 请求 1')
  expect(msg).toContain('endpoint=https://count-missing.example/embeddings')
  expect(msg).toContain('降级')
  expect(onUsage).not.toHaveBeenCalled()
})

test('响应条数多于请求（2 ≠ 1）→ null + 留痕实得条数', async () => {
  stubJson({
    data: [{ embedding: [1, 2, 3] }, { embedding: [4, 5, 6] }],
  })
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})

  await expect(embed('https://count-over.example/embeddings', 'm', 'k', ['正文'])).resolves.toBeNull()
  expect(failureWarn(warn)).toContain('响应条数 2 ≠ 请求 1')
})

test('响应条数少于请求（1 ≠ 2）→ null + 留痕实得条数', async () => {
  stubJson({ data: [{ embedding: [1, 2, 3] }] })
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})

  await expect(embed('https://count-under.example/embeddings', 'm', 'k', ['甲文', '乙文'])).resolves.toBeNull()
  expect(failureWarn(warn)).toContain('响应条数 1 ≠ 请求 2')
})

test('data 段为空数组（0 ≠ 2）→ null（空数组是坏响应，不是「零向量合法结果」）', async () => {
  stubJson({ data: [] })
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})

  await expect(embed('https://count-empty.example/embeddings', 'm', 'k', ['甲文', '乙文'])).resolves.toBeNull()
  expect(failureWarn(warn)).toContain('响应条数 0 ≠ 请求 2')
})
