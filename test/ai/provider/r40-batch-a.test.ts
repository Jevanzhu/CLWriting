/**
 * R40-2（四十轮）回归：chat 适配器 assistant 消息 reasoning 块的回写按家族表档位化。
 *
 * toOpenAIMessages 消费 quirksFor(model).echoReasoning——true 族（deepseek/glm/kimi，
 * 多轮带 tools 硬要求）写回 reasoning_content；false 族（gpt/grok/claude/unknown）
 * 不写回。原 CONF 'test-model' 属 unknown 族，旧用例锚「无条件回写」已随契约演进
 * 改钉 deepseek（见 adapter.test.ts）；本文件补全家族矩阵。
 *
 * 记档：本文件曾被一次 vitest list --json 误调用覆写成 JSON 枚举输出（未入库，
 * git 无从恢复），收口前按原设计重写——用例面与本注释描述一致。
 */
import { describe, expect, it } from 'vitest'
import OpenAI from 'openai'
import { createOpenAIProvider } from '../../../src/ai/provider/openai-adapter.js'
import type { GenEvent, GenRequest, ProviderConf } from '../../../src/ai/provider/index.js'

const CONF = {
  id: 't1',
  name: 't',
  protocol: 'anthropic' as const,
  auth: 'anthropic' as const,
  baseUrl: 'https://example.local',
  model: 'test-model',
  apiKey: 'sk-secret-key',
  caps: null,
} as ProviderConf

async function collect(conf: ProviderConf, req: GenRequest): Promise<{ events: GenEvent[]; sent: Record<string, unknown> | undefined }> {
  let sent: Record<string, unknown> | undefined
  const client = {
    chat: {
      completions: {
        create: async (params: unknown) => {
          sent = params as Record<string, unknown>
          return (async function* () {
            yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }
          })()
        },
      },
    },
  } as unknown as OpenAI
  const out: GenEvent[] = []
  for await (const ev of createOpenAIProvider(conf, client).stream(req, new AbortController().signal)) out.push(ev)
  return { events: out, sent }
}

const REQ_WITH_REASONING: GenRequest = {
  systemPrompt: '',
  messages: [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '回答' },
        { type: 'reasoning', text: '推理过程' },
      ],
    },
    { role: 'user', content: '继续' },
  ],
}

describe('R40-2: reasoning_content 回写按家族表档位化', () => {
  it.each([
    ['deepseek-chat', true],
    ['deepseek-reasoner', true],
    ['glm-4.7', true],
    ['kimi-k2', true],
    ['gpt-4o', false],
    ['grok-3', false],
    ['claude-3-5-sonnet', false],
    ['custom-model', false],
  ])('%s → echoReasoning=%s', async (model, expected) => {
    const { sent } = await collect({ ...CONF, protocol: 'openai' as const, model } as ProviderConf, REQ_WITH_REASONING)
    const asst = (sent?.messages as Record<string, unknown>[])[0]
    expect(asst).toBeDefined()
    if (expected) expect(asst?.['reasoning_content']).toBe('推理过程')
    else expect('reasoning_content' in (asst ?? {})).toBe(false)
  })

  it('无 reasoning 块的 assistant 消息：true 族也不写 reasoning_content 键', async () => {
    const { sent } = await collect({ ...CONF, protocol: 'openai' as const, model: 'deepseek-chat' } as ProviderConf, {
      systemPrompt: '',
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: '纯文本回答' }] },
        { role: 'user', content: '继续' },
      ],
    })
    const asst = (sent?.messages as Record<string, unknown>[])[0]
    expect(asst?.['content']).toBe('纯文本回答')
    expect('reasoning_content' in (asst ?? {})).toBe(false)
  })
})
