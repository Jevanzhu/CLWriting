/**
 * 适配器单测共享装置（R0916-5b 拆分件，2026-09-16）。
 *
 * 拆分来源：test/ai/provider/adapter.test.ts 原顶部共享装置原样抽出——CONF / REQ /
 * collect / fakeSend 供 adapter*.test.ts 各件共用；除 export 前缀与 collect 形参
 * 注解（ReturnType<typeof createAnthropicProvider> → 等价类型 ModelProvider，三个
 * adapter 工厂签名均返回 ModelProvider）外逐字节原样。
 */
import type { GenEvent, GenRequest, ModelProvider, ProviderConf } from '../../../src/ai/provider/index.js'

export const CONF = {
  id: 't1',
  name: 't',
  protocol: 'anthropic' as const,
  auth: 'anthropic' as const,
  baseUrl: 'https://example.local',
  model: 'test-model',
  apiKey: 'sk-secret-key',
  caps: null,
} as ProviderConf

export const REQ: GenRequest = { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] }

export async function collect(prov: ModelProvider, req: GenRequest): Promise<GenEvent[]> {
  const out: GenEvent[] = []
  for await (const ev of prov.stream(req, new AbortController().signal)) out.push(ev)
  return out
}

// 假事件流：客户端返回 async generator（as unknown 削减 SDK 类型）
export function fakeSend(events: unknown[]): () => AsyncGenerator<unknown> {
  return async function* () {
    for (const e of events) yield e
  }
}
