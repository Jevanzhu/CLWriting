/**
 * R26（二十六轮）批 A 回归：AI 链路正确性四件（gen 截断判据 / 记账 NaN / 空产出
 * 误判 / self-heal 落盘收编）。
 *
 * R26-1：generateTool 截断判据只认「无 tool」——tool_use 在场但 input 携带 `_raw`
 * （adapter JSON.parse 失败的残参标记）且 stop_reason=max_tokens 时，残缺 input 按
 * 成功入账并落稿（半截 JSON 进 decode 链）。修复后残参 + 截断 → GenError MAX_TOKENS，
 * usage 随错误上抛（R61-6 记账口径不回退）。
 *
 * R26-2：anthropic message_start 缺 input_tokens（非标网关形态）→ `?? 0` 终兜底。
 * 修复后原样赋 undefined 覆盖 0 初值，TokenUsage.inputTokens=undefined → calls 记账
 * NaN → checkAiCallBudget 对 NaN 恒 false，token/成本预算闸静默失效。
 *
 * R26-4：Responses completed 的 output 数组被网关省略（响应缺字段形态）但 delta 已
 * 流出正文/工具参数时，原「空产出」判据误判且 retryable:false 不重试，token 白烧。
 * 修复后补本流实际流出判据（toolYielded || outText 非空）。
 *
 * R26-5：self-heal 首稿 ctx.save 抛错（磁盘满/EACCES）原样上抛穿出 runChapter/
 * orchestrateBatch，批量侧不落暂停记录。修复后收编为 error 出口走既有 failed 链。
 */
import { describe, expect, it, test } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { generateTool, GenError } from '../../src/ai/gen.js'
import { createAnthropicProvider } from '../../src/ai/provider/anthropic-adapter.js'
import { createOpenAIResponsesProvider } from '../../src/ai/provider/responses-adapter.js'
import type { GenEvent, GenRequest, ModelProvider, ProviderConf } from '../../src/ai/provider/index.js'
import { runSelfHeal, type SelfHealOpts } from '../../src/ai/orchestrate/self-heal.js'
import { makeDualTrackWorkdir, tempUserData, SHORT_BOOK } from '../studio/fixtures.js'
import type { CheckOutcome } from '../../src/studio/server/api/check.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/index.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { saveDraft } from '../../src/studio/server/api/draft.js'

const CONF = { name: 'fake' } as ProviderConf

function signal(): AbortSignal {
  return new AbortController().signal
}

const USAGE = { inputTokens: 10, outputTokens: 3 }

/** r74-usage-fixes.test.ts fakeSend 同款：伪网关流（客户端返回 async generator） */
function fakeSend(events: unknown[]): () => AsyncGenerator<unknown> {
  return async function* () {
    for (const e of events) yield e
  }
}

async function collect(prov: ModelProvider, req: GenRequest): Promise<GenEvent[]> {
  const out: GenEvent[] = []
  for await (const ev of prov.stream(req, new AbortController().signal)) out.push(ev)
  return out
}

describe('R26-1: generateTool 残参（_raw）+ 截断 → MAX_TOKENS 不按成功入账', () => {
  it('tool_use input 带 _raw 且 stopReason=max_tokens → 抛 GenError 且 usage 随行', async () => {
    const p: ModelProvider = {
      conf: CONF,
      async *stream() {
        yield { type: 'tool', id: 't1', name: 'submit_x', input: { _raw: '{"标题":"写到一半被截' } }
        yield { type: 'done', usage: USAGE, stopReason: 'max_tokens' }
      },
    }
    // 修复前：残缺 input 按「有 tool 即成功」返回，半截 JSON 进下游 decode 链
    const err = await generateTool(p, { systemPrompt: '', messages: [] }, signal()).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(GenError)
    expect(err).toMatchObject({ code: 'MAX_TOKENS', usage: USAGE })
  })

  it('对照：残参但正常收尾（end_turn）不误伤——判据只在截断态收紧', async () => {
    const raw = '{"标题":"完整JSON但解析失败的原文形态"}'
    const p: ModelProvider = {
      conf: CONF,
      async *stream() {
        yield { type: 'tool', id: 't1', name: 'submit_x', input: { _raw: raw } }
        yield { type: 'done', usage: USAGE, stopReason: 'end_turn' }
      },
    }
    const r = await generateTool(p, { systemPrompt: '', messages: [] }, signal())
    expect(r.input).toEqual({ _raw: raw })
    expect(r.stopReason).toBe('end_turn')
  })

  it('对照：完整 input + 截断（原 R61-6 形态）仍走既有路径', async () => {
    const p: ModelProvider = {
      conf: CONF,
      async *stream() {
        yield { type: 'tool', id: 't1', name: 'submit_x', input: { 标题: '完整' } }
        yield { type: 'done', usage: USAGE, stopReason: 'max_tokens' }
      },
    }
    // 完整 tool input 在场：截断只影响产出完整性承诺，不否定已收全的结构化结果
    const r = await generateTool(p, { systemPrompt: '', messages: [] }, signal())
    expect(r.input).toEqual({ 标题: '完整' })
    expect(r.stopReason).toBe('max_tokens')
  })
})

describe('R26-2: anthropic message_start 缺 input_tokens → 0 兜底（NaN 防线）', () => {
  const ACONF = { ...CONF, protocol: 'anthropic' as const, auth: 'anthropic' as const } as ProviderConf

  it('message_start usage 为空对象 + message_delta 补 usage → inputTokens=0（非 undefined）', async () => {
    const client = {
      messages: {
        create: fakeSend([
          // 非标网关：message_start 的 usage 缺 input_tokens 键
          { type: 'message_start', message: { usage: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正文产出' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(ACONF, client), { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] })
    const done = evs.find((e) => e.type === 'done')
    expect(done).toBeDefined()
    if (done?.type !== 'done') return
    // 修复前：inputTokensFromStart 被赋 undefined → done.usage.inputTokens=undefined
    // → calls 记账 NaN → 预算闸对 NaN 恒 false
    expect(done.usage.inputTokens).toBe(0)
    expect(done.usage.outputTokens).toBe(5)
  })

  it('message_start 缺 input_tokens + message_delta 也无 usage → 兜底估计路径同样不产 NaN', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'message_start', message: { usage: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正文产出' } },
          // 网关完成不回 usage → H-2 兜底估计（inputTokensFromStart=0 → 按请求折算）
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(ACONF, client), { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] })
    const done = evs.find((e) => e.type === 'done')
    expect(done).toBeDefined()
    if (done?.type !== 'done') return
    // 折算锚定同 r74 口径：input = 'hi' 2 码位 → 2；output = '正文产出' 4 码位 → 3
    expect(done.usage.inputTokens).toBe(2)
    expect(done.usage.outputTokens).toBe(3)
    expect(done.usage.estimated).toBe(true)
  })
})

describe('R26-4: Responses completed 缺 output 数组但本流已流出内容 → 不误判空产出', () => {
  const RCONF = { ...CONF, protocol: 'openai-responses' as const } as ProviderConf

  it('工具参数已流出 + completed output 缺字段 → done(tool_use)，不再报不可重试空产出', async () => {
    const client = {
      responses: {
        create: fakeSend([
          { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'submit_x', arguments: '{"正文":"完整"}' } },
          // 网关省略 output 数组的缺字段形态（文件头缺口 18 自认）
          { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 2 } } },
        ]),
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] })
    expect(evs.some((e) => e.type === 'tool')).toBe(true)
    const done = evs.find((e) => e.type === 'done')
    expect(done, '修复前此处是 retryable:false 的「空产出」error，token 白烧').toBeDefined()
    if (done?.type !== 'done') return
    expect(done.stopReason).toBe('tool_use')
    expect(done.usage).toMatchObject({ inputTokens: 3, outputTokens: 2 })
  })

  it('正文 delta 已流出 + completed output 缺字段 → done(stop)，同样不误判', async () => {
    const client = {
      responses: {
        create: fakeSend([
          { type: 'response.output_text.delta', delta: '正文已经流出' },
          { type: 'response.completed', response: {} },
        ]),
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] })
    const done = evs.find((e) => e.type === 'done')
    expect(done).toBeDefined()
    if (done?.type !== 'done') return
    expect(done.stopReason).toBe('stop')
    expect(done.usage.estimated).toBe(true) // 无 usage → R74-1 估计入账口径不变
  })

  it('真·零产出（无 delta 无 output）仍判空产出错误——判据不放松', async () => {
    const client = {
      responses: {
        create: fakeSend([{ type: 'response.completed', response: { output: [] } }]),
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] })
    const err = evs.find((e) => e.type === 'error')
    expect(err).toMatchObject({ retryable: false })
    expect(evs.find((e) => e.type === 'done')).toBeUndefined()
  })
})

// ── R26-5：self-heal 首稿落盘抛错收编（self-heal-mock-chain.test.ts 同款脚手架）──

const META: ChapterMeta = {
  章号: 1,
  标题: '测试章',
  钩子类型: '悬念钩',
  钩子强弱: '中',
  情绪定位: '铺垫',
}

function makeEmitDriver(_emitted: DriverEvent[]): StudioDriver {
  return {
    async startSession(cwd: string): Promise<Session> {
      return { id: 'mock', cwd, closed: false }
    },
    async *stream(): AsyncGenerator<DriverEvent> {},
    dispose(): void {},
    emit(_s, _ev): void {},
  }
}

test('R26-5: 首稿 ctx.save 抛错 → error 出口（failed 链收口），不裸穿', async () => {
  const workDir = makeDualTrackWorkdir()
  const ud = tempUserData()
  const bookRoot = join(workDir, '短篇', SHORT_BOOK)
  const save: typeof saveDraft = () => {
    throw new Error('disk full (mock)')
  }
  const check = (): CheckOutcome => ({ ok: true, report: { sections: [] }, hasRed: false, chapter: META, body: '正文' })

  process.env['CLWRITING_DRIVER'] = 'mock'
  try {
    const opts: SelfHealOpts = {
      driver: makeEmitDriver([]),
      mainSession: { id: 'main', cwd: bookRoot, closed: false },
      userDataPath: ud,
      cwd: bookRoot,
      bookRoot,
      bookName: SHORT_BOOK,
      chapter: 1,
      check,
      save,
    }
    const r = await runSelfHeal(opts)
    // 修复前：save 裸穿出 runChapter/orchestrateBatch——批量侧 recordPause 不落暂停
    // 记录，链路以未捕获异常终止。修复后 error 出口走既有 failed 链。
    expect(r.outcome).toBe('failed')
    if (r.outcome === 'failed') expect(r.error).toContain('首稿落盘失败')
  } finally {
    delete process.env['CLWRITING_DRIVER']
    rmSync(workDir, { recursive: true, force: true })
    rmSync(ud, { recursive: true, force: true })
  }
})
