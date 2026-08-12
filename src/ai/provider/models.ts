/**
 * 模型列表获取——调供应商 API 拉模型列表。
 *
 * 协议差异（重要）：
 * - OpenAI 兼容：GET {baseURL}/v1/models（几乎所有网关支持）
 * - Anthropic 官方：**没有** /v1/models 端点（SDK 的 models.list 打官方是 404）
 *   · 中转网关多数支持 GET {baseURL}/v1/models → 优先试
 *   · 官方 / 纯官方格式 → 无法枚举，回退 fallback（空列表，调用方手动输入模型名）
 *   · 网关也不支持 /models → 404/405，同样回退
 */
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { Protocol } from './types.js'

/** 归一化 baseUrl：去尾部斜杠 + 去尾部 v1（SDK 会拼 /v1/...，防 /v1/v1）。 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
}

export async function listModels(protocol: Protocol, baseUrl: string, apiKey: string): Promise<string[]> {
  // mock 环境短路（CLWRITING_DRIVER=mock）——避免向不存在端点发真实请求导致 fetchModels 超时
  if (process.env['CLWRITING_DRIVER'] === 'mock') {
    return ['gpt-4o', 'gpt-4o-mini']
  }
  const url = normalizeBaseUrl(baseUrl)
  if (protocol === 'anthropic') {
    // 先试 /v1/models（网关兼容），失败回退空列表（官方无此端点，模型名手动输入）
    try {
      const client = new Anthropic({
        baseURL: url,
        apiKey,
        defaultHeaders: { Authorization: `Bearer ${apiKey}` },
      })
      const list = await client.models.list()
      return list.data.map((m) => m.id).sort()
    } catch {
      return []
    }
  }
  const client = new OpenAI({ baseURL: url, apiKey })
  const list = await client.models.list()
  return list.data.map((m) => m.id).sort()
}
