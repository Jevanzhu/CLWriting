/**
 * probe.ts 能力探测单测（第八轮评审 P1-T2）。
 *
 * probe 发真实 HTTP（listModels 走 SDK、stream 走 SDK 客户端），测试用 vi.mock
 * 按模块替换为假实现——listModels 管 connectivity 判定，adapter 工厂注入假 provider
 * 管 stream 事件流。不碰真实端点、不泄漏 key。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenEvent, ModelProvider, ProviderConf } from '../../../src/ai/provider/types.js'
import { createProvider, probeCapabilities } from '../../../src/ai/provider/probe.js'
import { clearProviderCache } from '../../../src/ai/provider/registry.js'
import { listModels } from '../../../src/ai/provider/models.js'
import { createAnthropicProvider } from '../../../src/ai/provider/anthropic-adapter.js'
import { createOpenAIProviderChat } from '../../../src/ai/provider/openai-adapter.js'
import { createOpenAIResponsesProvider } from '../../../src/ai/provider/responses-adapter.js'

// 自动 mock：模块的导出全部替换为 vi.fn()
vi.mock('../../../src/ai/provider/models.js')
vi.mock('../../../src/ai/provider/anthropic-adapter.js')
vi.mock('../../../src/ai/provider/openai-adapter.js')
vi.mock('../../../src/ai/provider/responses-adapter.js')

const SAVE_DRIVER = process.env['CLWRITING_DRIVER']

function conf(over: Partial<ProviderConf> = {}): ProviderConf {
  return {
    id: 't1',
    name: '测试',
    protocol: 'anthropic',
    auth: 'anthropic',
    baseUrl: 'https://example.local',
    apiKey: 'sk-secret-key',
    caps: null,
    ...over,
  }
}

/** 假 provider：按 events 依次产事件，末尾补 done */
function fakeProvider(events: Array<{ type: 'text' | 'tool' | 'error'; name?: string; message?: string }>): ModelProvider {
  const stream = async function* (): AsyncGenerator<GenEvent> {
    for (const ev of events) {
      if (ev.type === 'text') yield { type: 'text', delta: 'x' }
      else if (ev.type === 'tool') yield { type: 'tool', id: 't1', name: ev.name ?? 'echo_test', input: {} }
      else if (ev.type === 'error') yield { type: 'error', message: ev.message ?? 'failed', retryable: false }
    }
    yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' }
  }
  return { conf: conf(), stream }
}

beforeEach(() => {
  vi.clearAllMocks()
  // D2：registry 按 settings hash 缓存适配器实例——同 conf 跨用例会命中旧 mock 工厂产物，逐用例清
  clearProviderCache()
  // 默认真实探测路径（不走 mock 快路）
  if (SAVE_DRIVER === undefined) delete process.env['CLWRITING_DRIVER']
  else process.env['CLWRITING_DRIVER'] = SAVE_DRIVER
})

afterEach(() => {
  if (SAVE_DRIVER === undefined) delete process.env['CLWRITING_DRIVER']
  else process.env['CLWRITING_DRIVER'] = SAVE_DRIVER
})

describe('createProvider', () => {
  it('anthropic 协议 → 走 anthropic 工厂', () => {
    vi.mocked(createAnthropicProvider).mockReturnValue(fakeProvider([]))
    createProvider(conf({ protocol: 'anthropic', auth: 'anthropic' }))
    expect(createAnthropicProvider).toHaveBeenCalledTimes(1)
    expect(createOpenAIProviderChat).not.toHaveBeenCalled()
  })

  it('openai 协议 → 走 Chat Completions 工厂', () => {
    vi.mocked(createOpenAIProviderChat).mockReturnValue(fakeProvider([]))
    createProvider(conf({ protocol: 'openai', auth: 'bearer' }))
    expect(createOpenAIProviderChat).toHaveBeenCalledTimes(1)
  })

  // Responses 启用批（2026-08-17）：openai-responses 协议回接注册表 → 走 Responses 工厂
  it('openai-responses 协议 → 走 Responses 工厂（Responses 启用批）', () => {
    vi.mocked(createOpenAIResponsesProvider).mockReturnValue(fakeProvider([]))
    createProvider(conf({ protocol: 'openai-responses', auth: 'bearer', model: 'gpt-5' }))
    expect(createOpenAIResponsesProvider).toHaveBeenCalledTimes(1)
  })
})

describe('probeCapabilities', () => {
  it('连通 + 流式正常 → connected/streaming 均 true', async () => {
    vi.mocked(listModels).mockResolvedValue(['m1'])
    vi.mocked(createAnthropicProvider).mockReturnValue(fakeProvider([{ type: 'text' }]))
    const r = await probeCapabilities(conf())
    expect(r.caps).toEqual({ connected: true, streaming: true })
    expect(r.details.join()).toContain('连通')
  })

  it('连通但流式产 error → streaming:false，不崩', async () => {
    vi.mocked(listModels).mockResolvedValue(['m1'])
    vi.mocked(createAnthropicProvider).mockReturnValue(fakeProvider([{ type: 'error', message: 'stream failed' }]))
    const r = await probeCapabilities(conf())
    expect(r.caps.connected).toBe(true)
    expect(r.caps.streaming).toBe(false)
  })

  it('listModels 失败 → 错误分类（connected:false + 诊断含失败信息）', async () => {
    vi.mocked(listModels).mockRejectedValue(new Error('conn refused'))
    const r = await probeCapabilities(conf())
    expect(r.caps).toEqual({ connected: false, streaming: false })
    expect(r.details.join()).toContain('连通失败')
  })

  // Responses 启用批（2026-08-17）：openai-responses 协议探测 → details 含 Responses 线提示
  //（提示逻辑在 probe.ts 就位前该用例红——主线程统一回归时绿）
  it('openai-responses 协议探测 → details 含「Responses 线」提示（Responses 启用批）', async () => {
    vi.mocked(listModels).mockResolvedValue(['gpt-5'])
    vi.mocked(createOpenAIResponsesProvider).mockReturnValue(fakeProvider([{ type: 'text' }]))
    const r = await probeCapabilities(conf({ protocol: 'openai-responses', auth: 'bearer', model: 'gpt-5' }))
    expect(r.caps).toEqual({ connected: true, streaming: true })
    expect(r.details.join()).toContain('Responses 线')
  })
})