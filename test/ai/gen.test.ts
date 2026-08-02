/**
 * gen.ts 核心生成封装单测（审查 §七：ai/gen.ts 零单测）。
 *
 * 假 provider 事件流 → 验证 generate 收集 text/tool/usage/done、错误转 GenError、
 * generateText / generateTool 简化路径。
 */
import { describe, expect, it } from 'vitest'
import { generate, generateText, generateTool, GenError, withFirstByteTimeout } from '../../src/ai/gen.js'
import type { GenEvent, ModelProvider, ProviderConf } from '../../src/ai/provider/index.js'

const CONF = { name: 'fake' } as ProviderConf

function provider(events: GenEvent[]): ModelProvider {
  return {
    conf: CONF,
    modelCaps: null,
    async *stream() {
      for (const e of events) yield e
    },
  }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

const USAGE = { inputTokens: 10, outputTokens: 3 }

describe('generate', () => {
  it('收集 text 增量 + done 的 usage/stopReason', async () => {
    const deltas: string[] = []
    const r = await generate(
      provider([
        { type: 'text', delta: '你' },
        { type: 'text', delta: '好' },
        { type: 'done', usage: USAGE, stopReason: 'end_turn' },
      ]),
      { systemPrompt: '', messages: [], maxTokens: 100 },
      signal(),
      (d) => deltas.push(d),
    )
    expect(r.text).toBe('你好')
    expect(deltas).toEqual(['你', '好'])
    expect(r.usage).toEqual(USAGE)
    expect(r.stopReason).toBe('end_turn')
  })

  it('tool 事件收集到 toolCalls（规则：先 tool 后 done）', async () => {
    const r = await generate(
      provider([
        { type: 'tool', name: 'submit_text', input: { 正文: 'x' } },
        { type: 'done', usage: USAGE, stopReason: 'tool_use' },
      ]),
      { systemPrompt: '', messages: [], maxTokens: 100 },
      signal(),
    )
    expect(r.toolCalls).toEqual([{ name: 'submit_text', input: { 正文: 'x' } }])
  })

  it('error 事件 → 抛 GenError，retryable 透传', async () => {
    await expect(
      generate(
        provider([{ type: 'error', message: 'boom', retryable: true }]),
        { systemPrompt: '', messages: [], maxTokens: 100 },
        signal(),
      ),
    ).rejects.toMatchObject({ name: 'GenError', message: 'boom', retryable: true })
  })

  it('无 done 事件正常结束，usage 默认 0', async () => {
    const r = await generate(
      provider([{ type: 'text', delta: 'x' }]),
      { systemPrompt: '', messages: [], maxTokens: 100 },
      signal(),
    )
    expect(r.text).toBe('x')
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })
})

describe('generateText / generateTool 简化路径', () => {
  it('generateText 只取纯文本', async () => {
    const t = await generateText(
      provider([{ type: 'text', delta: '细纲' }, { type: 'done', usage: USAGE, stopReason: 'end_turn' }]),
      { systemPrompt: '', messages: [], maxTokens: 100 },
      signal(),
    )
    expect(t).toBe('细纲')
  })

  it('generateTool 取第一个 tool 的 input；无 tool 时 input=null 回退 text', async () => {
    const a = await generateTool(
      provider([{ type: 'tool', name: 'submit_chapter', input: { 正文: 'y' } }, { type: 'done', usage: USAGE, stopReason: 'tool_use' }]),
      { systemPrompt: '', messages: [], maxTokens: 100 },
      signal(),
    )
    expect(a.input).toEqual({ 正文: 'y' })

    const b = await generateTool(
      provider([{ type: 'text', delta: '自由文本' }, { type: 'done', usage: USAGE, stopReason: 'end_turn' }]),
      { systemPrompt: '', messages: [], maxTokens: 100 },
      signal(),
    )
    expect(b.input).toBeNull()
    expect(b.text).toBe('自由文本')
  })
})

describe('GenError 类型', () => {
  it('实例化携带 retryable 标记', () => {
    const e = new GenError('rate', true)
    expect(e.name).toBe('GenError')
    expect(e.retryable).toBe(true)
  })
})

describe('B-2 首字节超时', () => {
  it('首个事件前超时 → 可重试 GenError', async () => {
    const slow: AsyncIterable<GenEvent> = {
      async *[Symbol.asyncIterator]() {
        await new Promise((r) => setTimeout(r, 500))
        yield { type: 'text', delta: 'too late' }
      },
    }
    const iter = withFirstByteTimeout(slow, 10) // 10ms 超时
    await expect(iter.next()).rejects.toThrow('首字节超时')
  })

  it('首字节在超时前到达 → 正常产出（超时取消）', async () => {
    const fast: AsyncIterable<GenEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text', delta: 'fast' }
        yield { type: 'done', usage: USAGE, stopReason: 'end_turn' }
      },
    }
    const iter = withFirstByteTimeout(fast, 10_000)
    const first = await iter.next()
    expect(first.done).toBe(false)
    expect(first.value.type).toBe('text')
  })
})

describe('B-3 stopReason 传递', () => {
  it('generateTool 返回值含 stopReason（max_tokens 截断可检测）', async () => {
    const r = await generateTool(
      provider([{ type: 'tool', name: 'submit_chapter', input: { 正文: 'y' } }, { type: 'done', usage: USAGE, stopReason: 'max_tokens' }]),
      { systemPrompt: '', messages: [], maxTokens: 100 },
      signal(),
    )
    expect(r.stopReason).toBe('max_tokens')
    expect(r.input).toEqual({ 正文: 'y' })
  })
})