/**
 * anthropic 线请求体与降级记忆守卫（R30-4 / R30-10 / R30-12）：
 * - R30-4：降级记忆显式 path 贯穿——双 userDataPath 并存时，A 库 provider 的降级
 *   持久化/新鲜读按来源 path 路由（旧实现按「最近 resolve 的活跃 path」，后库劫持先库）。
 * - R30-10：仅含 reasoning block 的 assistant 消息不出现在 Anthropic 序列化请求体中。
 * - R30-12：max_tokens 协议兜底值钉在 16384（与 MAX_TOKENS/注释同步，防再漂移）。
 *
 * 档源：r30-batch-a.test.ts（三十轮批 A）拆分——R30-4/10/12 provider 半（本文件）
 * 与 R30-3 写锁半（ai-calls-lock-async.test.ts）按被测域分家。断言逐条保留、去重 0 条。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import Anthropic from '@anthropic-ai/sdk'
import { resolveProvider } from '../../src/ai/runner.js'
import { createAnthropicProvider } from '../../src/ai/provider/anthropic-adapter.js'
import type { GenEvent, GenRequest, ProviderConf } from '../../src/ai/provider/index.js'

const workDirs: string[] = []
function tempDir(prefix: string): string {
  const d = mkdtempTracked(join(tmpdir(), prefix))
  workDirs.push(d)
  return d
}

afterEach(() => {
  for (const d of workDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// ── R30-4：降级记忆显式 path 贯穿 ───────────────────────────────────────

/** 写最小 providers.json（anthropic 协议 + claude 模型——structuredMode json_schema，降级链可达） */
function writeUdProviders(ud: string, modelCaps?: Record<string, { structured: false }>): void {
  writeFileSync(
    join(ud, 'providers.json'),
    JSON.stringify({
      providers: [
        {
          id: 'prov-a',
          name: 'A',
          protocol: 'anthropic',
          auth: 'anthropic',
          baseUrl: 'https://a.local',
          apiKey: 'sk-ud-secret',
          caps: { connected: true, streaming: true },
        },
      ],
      currentId: 'prov-a',
      currentModel: 'claude-sonnet-5',
      ...(modelCaps ? { modelCaps } : {}),
    }),
  )
}

const CONF_A: ProviderConf = {
  id: 'prov-a',
  name: 'A',
  protocol: 'anthropic',
  auth: 'anthropic',
  baseUrl: 'https://a.local',
  model: 'claude-sonnet-5',
  apiKey: 'sk-a-secret',
  caps: null,
}

const REQ_STRUCTURED: GenRequest = {
  systemPrompt: '',
  messages: [{ role: 'user', content: 'hi' }],
  structured: { schema: {} },
}

/** 假客户端：首发带 output_config.format → 400；剥除版成功建流（registry.test.ts 同款） */
function fakeDegradeClient(): { client: Anthropic; calls: () => number } {
  let n = 0
  const client = {
    messages: {
      create: async (params: unknown) => {
        n++
        const p = params as Record<string, unknown>
        if ((p['output_config'] as Record<string, unknown> | undefined)?.['format']) {
          throw new Anthropic.APIError(400, { type: 'error', message: 'bad request' }, 'bad request', undefined)
        }
        return (async function* () {
          yield { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, delta: { stop_reason: 'end_turn' } }
        })()
      },
    },
  } as unknown as Anthropic
  return { client, calls: () => n }
}

async function collect(prov: ReturnType<typeof createAnthropicProvider>, req: GenRequest): Promise<GenEvent[]> {
  const out: GenEvent[] = []
  for await (const ev of prov.stream(req, new AbortController().signal)) out.push(ev)
  return out
}

describe('R30-4：降级记忆显式 path 贯穿（双库并存互不劫持）', () => {
  it('resolve A 后 resolve B（活跃=B），A 的 provider 降级持久化 → 落在 A 的 providers.json', async () => {
    const udA = tempDir('r30-degrade-a-')
    const udB = tempDir('r30-degrade-b-')
    writeUdProviders(udA)
    writeUdProviders(udB)
    expect(resolveProvider(udA).ok).toBe(true) // 注册 A 回调
    expect(resolveProvider(udB).ok).toBe(true) // 活跃 path = B（旧实现按此路由 → A 的写被劫持到 B）
    const { client } = fakeDegradeClient()
    // 显式携来源 path udA（resolveProvider 经 createProvider 注入的同参形态）
    const prov = createAnthropicProvider(CONF_A, client, undefined, udA)
    const evs = await collect(prov, REQ_STRUCTURED)
    expect(evs.some((e) => e.type === 'done')).toBe(true) // 400 → 剥 structured 重试成功
    const key = 'prov-a/claude-sonnet-5'
    const capsA = (JSON.parse(readFileSync(join(udA, 'providers.json'), 'utf8')) as { modelCaps?: Record<string, unknown> }).modelCaps
    expect(capsA?.[key]).toEqual({ structured: false }) // 落在 A（旧实现落 B）
    const capsB = (JSON.parse(readFileSync(join(udB, 'providers.json'), 'utf8')) as { modelCaps?: Record<string, unknown> }).modelCaps
    expect(capsB?.[key]).toBeUndefined() // B 不被误写
  }, 15_000)

  it('降级记忆新鲜读按显式 path：记忆在 A、活跃=B，A 的 provider 首发即剥（1 次建流）', async () => {
    const udA = tempDir('r30-lookup-a-')
    const udB = tempDir('r30-lookup-b-')
    const key = 'prov-a/claude-sonnet-5'
    writeUdProviders(udA, { [key]: { structured: false } }) // A 已有降级记忆
    writeUdProviders(udB)
    expect(resolveProvider(udA).ok).toBe(true)
    expect(resolveProvider(udB).ok).toBe(true) // 活跃 path = B（旧实现按此查 → miss）
    const { client, calls } = fakeDegradeClient()
    const prov = createAnthropicProvider(CONF_A, client, undefined, udA) // 无 store 快照，全靠通道
    const evs = await collect(prov, REQ_STRUCTURED)
    expect(evs.some((e) => e.type === 'done')).toBe(true)
    expect(calls()).toBe(1) // 记忆经显式 path 命中 → 首发即剥（旧实现 miss → 400 后重试 = 2 次）
  }, 15_000)
})

// ── R30-10 / R30-12：anthropic 适配器请求体 ─────────────────────────────

function captureClient(): { client: Anthropic; paramsList: Array<Record<string, unknown>> } {
  const paramsList: Array<Record<string, unknown>> = []
  const client = {
    messages: {
      create: async (params: unknown) => {
        paramsList.push(params as Record<string, unknown>)
        return (async function* () {
          yield { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, delta: { stop_reason: 'end_turn' } }
        })()
      },
    },
  } as unknown as Anthropic
  return { client, paramsList }
}

describe('R30-10：仅 reasoning 的 assistant 消息从请求历史剔除', () => {
  it('block 全为 reasoning 的 assistant 轮不出现在序列化请求体（空 content 数组会 400）', async () => {
    const { client, paramsList } = captureClient()
    const req: GenRequest = {
      systemPrompt: '',
      messages: [
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: [{ type: 'reasoning', text: '只有推理文本的轮次' }] },
        { role: 'user', content: '第二问' },
      ],
    }
    const evs = await collect(createAnthropicProvider(CONF_A, client), req)
    expect(evs.some((e) => e.type === 'done')).toBe(true)
    expect(paramsList).toHaveLength(1)
    const messages = paramsList[0]!['messages'] as Array<{ role: string; content: unknown }>
    expect(messages).toHaveLength(2) // 仅 reasoning 的 assistant 轮被剔除
    for (const m of messages) {
      expect(m.role).toBe('user')
      expect(Array.isArray(m.content) && (m.content as unknown[]).length === 0).toBe(false)
    }
  }, 15_000)

  it('对照：reasoning + text 混合的 assistant 轮保留（只剥 reasoning block）', async () => {
    const { client, paramsList } = captureClient()
    const req: GenRequest = {
      systemPrompt: '',
      messages: [
        { role: 'user', content: '问' },
        { role: 'assistant', content: [{ type: 'reasoning', text: '推理' }, { type: 'text', text: '回答' }] },
        { role: 'user', content: '再问' },
      ],
    }
    await collect(createAnthropicProvider(CONF_A, client), req)
    const messages = paramsList[0]!['messages'] as Array<{ role: string; content: Array<{ type: string; text?: string }> }>
    expect(messages).toHaveLength(3)
    expect(messages[1]!.role).toBe('assistant')
    expect(messages[1]!.content).toEqual([{ type: 'text', text: '回答' }])
  }, 15_000)
})

describe('R30-12：max_tokens 协议兜底钉在 16384', () => {
  it('无调用方 cap / 无模型行 / quirks 无值（unknown 家族）→ 兜底 16384（与 MAX_TOKENS 同步）', async () => {
    const { client, paramsList } = captureClient()
    const conf: ProviderConf = { ...CONF_A, model: 'totally-unknown-model' } // unknown 家族 quirks 无 maxOutputTokens
    const req: GenRequest = { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] } // 无 maxTokens
    await collect(createAnthropicProvider(conf, client), req)
    expect(paramsList[0]!['max_tokens']).toBe(16_384)
  }, 15_000)
})
