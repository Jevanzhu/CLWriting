/**
 * P5-AI（第七轮）回归：listModels OpenAI 线 404/405 宽降。
 *
 * 修复背景：anthropic 分支 404/405 回落空列表（官方无 /v1/models、网关不实现也回退），
 * OpenAI 分支直接上抛——不实现 /models 的兼容网关被「测试连接」误报「连通失败」
 * （chat 生成可能实际可用）。404/405 → []；其余（401/500/网络）照旧上抛。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { listModels } from '../../../src/ai/provider/models.js'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env['CLWRITING_DRIVER']
})

function stubFetch(status: number): void {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ error: { message: 'no such route' } }), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch
}

describe('P5-AI: listModels OpenAI 线 404/405 宽降', () => {
  it('404 → 空列表（网关不实现 /models，chat 端点可用不被误报不通）', async () => {
    stubFetch(404)
    expect(await listModels('openai', 'https://gw.example/v1', 'sk-test')).toEqual([])
  })

  it('405 → 空列表（同口径）', async () => {
    stubFetch(405)
    expect(await listModels('openai', 'https://gw.example/v1', 'sk-test')).toEqual([])
  })

  it('500 → 上抛（真故障不吞，调用方区分「不通」与「通但服务错」）', async () => {
    stubFetch(500)
    await expect(listModels('openai', 'https://gw.example/v1', 'sk-test')).rejects.toThrow()
  })
})
