/**
 * gen.ts 核心生成封装单测（审查 §七：ai/gen.ts 零单测）。
 *
 * 假 provider 事件流 → 验证 generate 收集 text/tool/usage/done、错误转 GenError、
 * generateText / generateTool 简化路径。
 */
import { describe, expect, it } from 'vitest'
import { generate, generateText, generateTool, GenError, withFirstByteTimeout } from '../../src/ai/gen.js'
import type { GenEvent, GenRequest, ModelProvider, ProviderConf } from '../../src/ai/provider/index.js'

const CONF = { name: 'fake' } as ProviderConf

function provider(events: GenEvent[]): ModelProvider {
  return {
    conf: CONF,
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
      { systemPrompt: '', messages: [] },
      signal(),
      (d) => deltas.push(d),
    )
    expect(r.text).toBe('你好')
    expect(deltas).toEqual(['你', '好'])
    expect(r.usage).toEqual(USAGE)
    expect(r.stopReason).toBe('end_turn')
  })

  it('reasoning 事件收集到 reasoning 字段（方案 §4.2）', async () => {
    const r = await generate(
      provider([
        { type: 'reasoning', delta: '思考' },
        { type: 'reasoning', delta: '过程' },
        { type: 'text', delta: '回答' },
        { type: 'done', usage: USAGE, stopReason: 'end_turn' },
      ]),
      { systemPrompt: '', messages: [] },
      signal(),
    )
    expect(r.reasoning).toBe('思考过程')
    expect(r.text).toBe('回答')
  })

  it('tool 事件收集到 toolCalls（规则：先 tool 后 done）', async () => {
    const r = await generate(
      provider([
        { type: 'tool', id: 't1', name: 'submit_text', input: { 正文: 'x' } },
        { type: 'done', usage: USAGE, stopReason: 'tool_use' },
      ]),
      { systemPrompt: '', messages: [] },
      signal(),
    )
    expect(r.toolCalls).toEqual([{ id: 't1', name: 'submit_text', input: { 正文: 'x' } }])
  })

  it('error 事件 → 抛 GenError，retryable 透传', async () => {
    await expect(
      generate(
        provider([{ type: 'error', message: 'boom', retryable: true }]),
        { systemPrompt: '', messages: [] },
        signal(),
      ),
    ).rejects.toMatchObject({ name: 'GenError', message: 'boom', retryable: true })
  })

  it('无 done 事件正常结束，usage 默认 0', async () => {
    const r = await generate(
      provider([{ type: 'text', delta: 'x' }]),
      { systemPrompt: '', messages: [] },
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
      { systemPrompt: '', messages: [] },
      signal(),
    )
    expect(t).toBe('细纲')
  })

  // P1-3：纯文本端点截断检查（与 generateTool 对称，覆盖 outline/onboard）
  it('generateText 在 max_tokens 截断时抛 GenError', async () => {
    const p: ModelProvider = {
      conf: CONF,
      async *stream() {
        yield { type: 'text', delta: '不完整的大纲' }
        yield { type: 'done', usage: USAGE, stopReason: 'max_tokens' }
      },
    }
    await expect(
      generateText(p, { systemPrompt: '', messages: [] }, signal()),
    ).rejects.toMatchObject({ name: 'GenError', retryable: false })
  })

  // R61-6（第六十一轮）：截断调用照样烧 token——GenError 载荷须带 usage 供记账
  it('generateText/generateTool 截断抛错时 usage 随 GenError 上抛（丢账可捕）', async () => {
    const p: ModelProvider = {
      conf: CONF,
      async *stream() {
        yield { type: 'text', delta: '不完整的大纲' }
        yield { type: 'done', usage: USAGE, stopReason: 'max_tokens' }
      },
    }
    await expect(
      generateText(p, { systemPrompt: '', messages: [] }, signal()),
    ).rejects.toMatchObject({ usage: USAGE })

    const p2: ModelProvider = {
      conf: CONF,
      async *stream() {
        yield { type: 'text', delta: '被截断的 JSON 前半' }
        yield { type: 'done', usage: USAGE, stopReason: 'max_tokens' }
      },
    }
    await expect(
      generateTool(p2, { systemPrompt: '', messages: [] }, signal()),
    ).rejects.toMatchObject({ usage: USAGE })
  })

  it('generateTool 取第一个 tool 的 input；无 tool 时 input=null 回退 text', async () => {
    const a = await generateTool(
      provider([{ type: 'tool', id: 't2', name: 'submit_chapter', input: { 正文: 'y' } }, { type: 'done', usage: USAGE, stopReason: 'tool_use' }]),
      { systemPrompt: '', messages: [] },
      signal(),
    )
    expect(a.input).toEqual({ 正文: 'y' })

    const b = await generateTool(
      provider([{ type: 'text', delta: '自由文本' }, { type: 'done', usage: USAGE, stopReason: 'end_turn' }]),
      { systemPrompt: '', messages: [] },
      signal(),
    )
    expect(b.input).toBeNull()
    expect(b.text).toBe('自由文本')
  })

  // 表驱动重构：能力判据从 modelCaps 换成静态表。unknown 系列 toolUse=true（尝试挂 tools），
  // 不拒绝；requireTool 意图按 toolChoiceMode 翻译（unknown=auto → 不发 tool_choice，prompt 引导）
  // 注：const 数组接收 req（闭包内 push）——字面量初始化的 let 变量被闭包引用时 TS 收窄成 never
  it('generateTool unknown 系列：toolUse=true 不拒绝，requireTool 意图转 auto（不发 tool_choice）', async () => {
    const sent: GenRequest[] = []
    const p: ModelProvider = {
      conf: CONF,
      async *stream(req) {
        sent.push(req)
        yield { type: 'done', usage: USAGE, stopReason: 'end_turn' }
      },
    }
    const out = await generateTool(p, { systemPrompt: '', messages: [], requireTool: true, toolName: 't' }, signal())
    expect(out.input).toBeNull()
    // unknown 系列 toolChoiceMode='auto' → requireTool 意图不落 tool_choice，prompt 引导
    expect(sent[0]?.toolChoice).toBeUndefined()
    expect(sent[0]?.toolName).toBeUndefined()
  })

  // 表驱动：named 系列（claude/gpt/grok）requireTool 意图 → toolChoice:'tool' 指名
  it('generateTool named 系列：requireTool 意图转 toolChoice=tool 指名', async () => {
    const sent: GenRequest[] = []
    const p: ModelProvider = {
      conf: { ...CONF, model: 'claude-sonnet-5' } as ProviderConf,
      async *stream(req) {
        sent.push(req)
        yield { type: 'done', usage: USAGE, stopReason: 'end_turn' }
      },
    }
    const out = await generateTool(p, { systemPrompt: '', messages: [], requireTool: true, toolName: 't' }, signal())
    expect(out.input).toBeNull()
    expect(sent[0]?.toolChoice).toBe('tool')
    expect(sent[0]?.toolName).toBe('t')
  })

  // 表驱动：deepseek 系列 toolChoiceMode='required'（官方无指名）→ requireTool 意图转 any
  //（回归：CCats 网关对 anthropic 端点发 type:'tool' 指名 400，右栏 AI 推断直接报错）
  it('generateTool deepseek 系列：requireTool 意图转 toolChoice=any 非指名', async () => {
    const sent: GenRequest[] = []
    const p: ModelProvider = {
      conf: { ...CONF, model: 'deepseek-v4-flash' } as ProviderConf,
      async *stream(req) {
        sent.push(req)
        yield { type: 'done', usage: USAGE, stopReason: 'end_turn' }
      },
    }
    const out = await generateTool(p, { systemPrompt: '', messages: [], requireTool: true, toolName: 't' }, signal())
    expect(out.input).toBeNull()
    // deepseek 只能「必须调某个」不能点名 → toolChoice=any（线格式 type:'any'）
    expect(sent[0]?.toolChoice).toBe('any')
    expect(sent[0]?.toolName).toBe('t') // toolName 保留（any 不需要，但不该被清掉）
  })

  // P1-3：输出撞顶且无 tool_use → JSON 被截断；抛明确错误而非静默降级
  it('generateTool 在 max_tokens 截断且无 tool_use 时抛 GenError', async () => {
    const p: ModelProvider = {
      conf: CONF,
      async *stream() {
        yield { type: 'text', delta: '不完整的产出' }
        yield { type: 'done', usage: USAGE, stopReason: 'max_tokens' }
      },
    }
    await expect(
      generateTool(p, { systemPrompt: '', messages: [] }, signal()),
    ).rejects.toMatchObject({ name: 'GenError', retryable: false })
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
    await expect(iter.next()).rejects.toThrow('响应超时')
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

  // P1-1：超时后必须关闭上游迭代器（释放 HTTP 连接，否则叠加重试最多 4 条悬挂连接并存）
  it('超时后调用上游 it.return() 释放连接', async () => {
    let returnCalled = false
    const slow: AsyncIterable<GenEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<GenEvent>>((r) =>
            setTimeout(() => r({ done: false, value: { type: 'text', delta: 'late' } }), 500)),
          return: () => { returnCalled = true; return Promise.resolve({ done: true, value: undefined }) },
        }
      },
    }
    const iter = withFirstByteTimeout(slow, 10)
    await expect(iter.next()).rejects.toThrow('响应超时')
    expect(returnCalled).toBe(true)
  })

  // Q2（review-q P1-Q2）：挂死流（next() 永不结算）超时后，return() 不得阻塞——
  // 旧实现 `await it.return?.()` 会排队等挂起 next() 结算 → 60s 快速失败退化成死等
  it('挂死流超时后立即抛错，不等待 return() 结算', async () => {
    let returnCalled = false
    const hung: AsyncIterable<GenEvent> = {
      [Symbol.asyncIterator]() {
        return {
          // next() 永不结算——模拟「服务器接受连接但不发数据」的半死场景
          next: () => new Promise<IteratorResult<GenEvent>>(() => {}),
          return: () => { returnCalled = true; return new Promise<IteratorResult<GenEvent>>(() => {}) },
        }
      },
    }
    const iter = withFirstByteTimeout(hung, 10)
    const start = Date.now()
    await expect(iter.next()).rejects.toThrow('响应超时')
    // 超时应立即抛错（<1s），而不是等 return() 结算
    expect(Date.now() - start).toBeLessThan(1000)
    expect(returnCalled).toBe(true) // void 调用仍触发了 return()
  })
})

// ── RB-AI-P2-3：超时 abort 底层请求（不再只放弃消费迭代器）──

describe('RB-AI-P2-3 超时 abort 底层 signal', () => {
  it('首字节超时 → 传给底层的 signal.aborted === true（在途 HTTP 被终止）', async () => {
    let seen: AbortSignal | undefined
    const p: ModelProvider = {
      conf: CONF,
      async *stream(_req, signal) {
        seen = signal
        await new Promise<never>(() => {}) // 挂死流：接受连接但不发数据
      },
    }
    process.env.CLWRITING_FIRST_BYTE_TIMEOUT_MS = '20'
    try {
      await expect(generate(p, { systemPrompt: '', messages: [] }, signal())).rejects.toThrow('响应超时')
    } finally {
      delete process.env.CLWRITING_FIRST_BYTE_TIMEOUT_MS
    }
    expect(seen).toBeDefined()
    expect(seen!.aborted).toBe(true)
  })

  it('外层用户 signal abort → 联动 abort 底层 signal（行为不回退）', async () => {
    let seen: AbortSignal | undefined
    const p: ModelProvider = {
      conf: CONF,
      async *stream(_req, signal) {
        seen = signal
        // 底层感知 abort 即报错（模拟 SDK 的 AbortError 路径）
        await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted-underlying'))))
      },
    }
    const ctrl = new AbortController()
    const genPromise = generate(p, { systemPrompt: '', messages: [] }, ctrl.signal)
    await new Promise((r) => setTimeout(r, 20)) // 等 stream 已启动（signal 已被底层捕获）
    ctrl.abort()
    await expect(genPromise).rejects.toThrow('aborted-underlying')
    expect(seen!.aborted).toBe(true)
  })
})

describe('B-3 stopReason 传递', () => {
  it('generateTool 返回值含 stopReason（max_tokens 截断可检测）', async () => {
    const r = await generateTool(
      provider([{ type: 'tool', id: 't3', name: 'submit_chapter', input: { 正文: 'y' } }, { type: 'done', usage: USAGE, stopReason: 'max_tokens' }]),
      { systemPrompt: '', messages: [] },
      signal(),
    )
    expect(r.stopReason).toBe('max_tokens')
    expect(r.input).toEqual({ 正文: 'y' })
  })
})