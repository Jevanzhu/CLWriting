/**
 * 适配器注册表单测（批次 D2）。
 *
 * 覆盖：声明式路由（主名/别名/宁缺勿错）、settings hash 实例缓存
 * （命中/击穿/LRU 上限）、配置+适配器原子绑定（bound conf 不受调用方
 * 后续 mutate 影响）、降级记忆新鲜读通道（缓存实例读到此刻磁盘状态）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import {
  createProvider,
  resolveAdapter,
  clearProviderCache,
  providerCacheSize,
} from '../../../src/ai/provider/registry.js'
import {
  registerDegradedLookup,
  registerDegradedPersist,
  resetDegradedChannels,
} from '../../../src/ai/provider/store.js'
import { createAnthropicProvider } from '../../../src/ai/provider/anthropic-adapter.js'
import type { GenEvent, GenRequest, ProviderConf } from '../../../src/ai/provider/index.js'

const CONF = {
  id: 't1',
  name: 't',
  protocol: 'anthropic' as const,
  auth: 'anthropic' as const,
  baseUrl: 'https://example.local',
  model: 'claude-sonnet-5',
  apiKey: 'sk-secret-key',
  caps: null,
} as ProviderConf

beforeEach(() => {
  clearProviderCache()
  resetDegradedChannels()
})

afterEach(() => {
  resetDegradedChannels()
})

describe('resolveAdapter 声明式路由', () => {
  it('主名精确命中', () => {
    expect(resolveAdapter('anthropic')?.name).toBe('anthropic')
    expect(resolveAdapter('openai')?.name).toBe('openai')
  })

  it('别名命中（中转/网关 adapterFamily 叫法），大小写与空白宽容', () => {
    expect(resolveAdapter('anthropic-messages')?.name).toBe('anthropic')
    expect(resolveAdapter(' Claude ')?.name).toBe('anthropic')
    expect(resolveAdapter('chat-completions')?.name).toBe('openai')
  })

  it('未知键 → null（宁缺勿错，不猜测近邻）', () => {
    expect(resolveAdapter('grpc')).toBeNull()
    expect(resolveAdapter('')).toBeNull()
  })

  // Responses 启用批（2026-08-17）反转 Z-P2-1 拒配：主名回接注册表
  it('openai-responses 主名命中（Responses 启用批 2026-08-17 反转 Z-P2-1 拒配）', () => {
    const entry = resolveAdapter('openai-responses')
    expect(entry).not.toBeNull()
    expect(entry?.name).toBe('openai-responses')
  })

  it('别名 openai-responses-api 命中同一 entry（Responses 启用批 2026-08-17 反转 Z-P2-1 拒配）', () => {
    expect(resolveAdapter('openai-responses-api')?.name).toBe('openai-responses')
    expect(resolveAdapter('openai-responses-api')).toBe(resolveAdapter('openai-responses'))
  })
})

describe('openai-responses 存量配置创建（Responses 启用批 2026-08-17 反转 Z-P2-1 拒配）', () => {
  it('createProvider 对 openai-responses conf 返回带 stream 函数的实例（不再迁移报错）', () => {
    const provider = createProvider({
      ...CONF,
      protocol: 'openai-responses',
      auth: 'bearer',
      model: 'gpt-5',
    })
    expect(typeof provider.stream).toBe('function')
  })
})

describe('settings hash 实例缓存', () => {
  it('行为字段相同 → 复用同一实例（SDK 客户端不重建）', () => {
    const a = createProvider(CONF)
    const b = createProvider({ ...CONF })
    expect(b).toBe(a)
  })

  it('展示字段（name/notes/caps/sortIndex）不入键 → 仍命中', () => {
    const a = createProvider(CONF)
    const b = createProvider({ ...CONF, name: '改名', notes: '备注', sortIndex: 9 })
    expect(b).toBe(a)
  })

  it('任一行为字段变（apiKey/baseUrl/model…）→ 新实例', () => {
    const a = createProvider(CONF)
    const b = createProvider({ ...CONF, apiKey: 'sk-other' })
    const c = createProvider({ ...CONF, model: 'claude-opus-5' })
    expect(b).not.toBe(a)
    expect(c).not.toBe(a)
  })

  it('LRU 上限 8：第 9 个配置逐出最旧，近期访问的保留', () => {
    const providers = Array.from({ length: 9 }, (_, i) =>
      createProvider({ ...CONF, id: `p${i}`, apiKey: `sk-${i}` }),
    )
    expect(providerCacheSize()).toBe(8)
    // p0 最旧被逐出 → 再取会新建；p8 最新仍在
    expect(createProvider({ ...CONF, id: 'p0', apiKey: 'sk-0' })).not.toBe(providers[0])
    expect(createProvider({ ...CONF, id: 'p8', apiKey: 'sk-8' })).toBe(providers[8])
  })
})

describe('配置 + 适配器原子绑定（学 cherry prepareCall 防注册漂移）', () => {
  it('创建后调用方 mutate 自己的对象，不影响已绑定实例', () => {
    const mine: ProviderConf = { ...CONF }
    const provider = createProvider(mine)
    mine.model = 'gpt-5.1'
    mine.apiKey = 'sk-mutated'
    expect(provider.conf.model).toBe('claude-sonnet-5')
    expect(provider.conf.apiKey).toBe('sk-secret-key')
  })
})

describe('降级记忆新鲜读（缓存实例不读旧快照）', () => {
  it('查通道注册后，适配器读到「此刻」记忆而非创建时 store 快照', async () => {
    // 记忆存内存对象，模拟 providers.json 的读写两侧
    const memory: Record<string, { structured: false }> = {}
    registerDegradedLookup((key) => (memory[key]?.structured === false ? true : undefined))
    registerDegradedPersist((key) => {
      memory[key] = { structured: false }
    })

    let callCount = 0
    const client = {
      messages: {
        create: async (params: unknown) => {
          callCount++
          const p = params as Record<string, unknown>
          if (p['output_config'] && (p['output_config'] as Record<string, unknown>)['format']) {
            throw new Anthropic.APIError(400, { type: 'error', message: 'bad request' }, 'bad request', undefined)
          }
          return (async function* () {
            yield { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, delta: { stop_reason: 'end_turn' } }
          })()
        },
      },
    } as unknown as Parameters<typeof createAnthropicProvider>[1]

    const req: GenRequest = { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }], structured: { schema: {} } }
    const collect = async (prov: ReturnType<typeof createAnthropicProvider>): Promise<GenEvent[]> => {
      const out: GenEvent[] = []
      for await (const ev of prov.stream(req, new AbortController().signal)) out.push(ev)
      return out
    }

    // 两个「各自 loadProviders 拿到的空快照」store（D2 前缓存实例会读第一个快照的旧状态）
    const store1 = emptyStore()
    const store2 = emptyStore()
    const first = await collect(createAnthropicProvider(CONF, client, store1))
    expect(callCount).toBe(2) // 首发 400 → 剥 structured 重试 → 建流成功写记忆（经通道）
    expect(first.some((e) => e.type === 'done')).toBe(true)

    // 第二次：传入的 store2 快照仍是空（模拟新一次 loadProviders 早于落盘的竞态），
    // 但记忆经查通道命中 → 首发即剥，一次成功
    callCount = 0
    const second = await collect(createAnthropicProvider(CONF, client, store2))
    expect(callCount).toBe(1)
    expect(second.some((e) => e.type === 'done')).toBe(true)
    expect(second.some((e) => e.type === 'error')).toBe(false)
  })
})

/** 最小空 store（模拟 loadProviders 返回的 clone） */
function emptyStore() {
  return {
    providers: [],
    currentId: null,
    currentModel: null,
    modelCaps: {},
    ragProviders: [],
    tiers: { creative: { model: '', effort: 'high' as const }, assistant: null, chat: null },
    vault: null,
    dek: null,
  }
}
