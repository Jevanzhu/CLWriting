/**
 * 模型列表获取——调供应商 API 拉 /v1/models。
 * 中转网关可能不支持此端点 → 调用方 fallback 手动输入。
 */
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { Protocol } from './types.js'

export async function listModels(protocol: Protocol, baseUrl: string, apiKey: string): Promise<string[]> {
  // mock 环境短路（CLWRITING_DRIVER=mock）——避免向不存在端点发真实请求导致 fetchModels 超时
  if (process.env['CLWRITING_DRIVER'] === 'mock') {
    return ['gpt-4o', 'gpt-4o-mini']
  }
  if (protocol === 'anthropic') {
    const client = new Anthropic({
      baseURL: baseUrl,
      apiKey,
      defaultHeaders: { Authorization: `Bearer ${apiKey}` },
    })
    const list = await client.models.list()
    return list.data.map((m) => m.id).sort()
  }
  const client = new OpenAI({ baseURL: baseUrl, apiKey })
  const list = await client.models.list()
  return list.data.map((m) => m.id).sort()
}
