/**
 * 适配器公共错误处理单测（hh 评审 §八 条目 9：三份同构拷贝抽取后的单一实现钉板）。
 *
 * makeToErrorEvent 五分支 / buildDegradeAttempts 四分支 attempts 序 / isMidChain400
 * 续跑闸 / markStructuredDegrade 记忆写入——抽公共后直接钉公共实现，三线不再各测
 * 同一份拷贝（适配器侧的线级行为由 adapter.test.ts 覆盖）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import {
  makeToErrorEvent,
  buildDegradeAttempts,
  isMidChain400,
  markStructuredDegrade,
} from '../../../src/ai/provider/adapter-errors.js'
import {
  registerDegradedLookup,
  registerDegradedPersist,
  resetDegradedChannels,
  type ProviderStore,
} from '../../../src/ai/provider/store.js'
import type { GenRequest } from '../../../src/ai/provider/types.js'

const openaiToErrorEvent = makeToErrorEvent({
  APIError: OpenAI.APIError,
  APIUserAbortError: OpenAI.APIUserAbortError,
  APIConnectionError: OpenAI.APIConnectionError,
  label: 'OpenAI API',
})

const anthropicToErrorEvent = makeToErrorEvent({
  APIError: Anthropic.APIError,
  APIUserAbortError: Anthropic.APIUserAbortError,
  APIConnectionError: Anthropic.APIConnectionError,
  label: 'Anthropic API',
})

// 降级记忆的查/写是模块级通道——用例间必须清空，防泄漏串扰
beforeEach(() => { resetDegradedChannels() })
afterEach(() => { resetDegradedChannels() })

describe('makeToErrorEvent 五分支', () => {
  it('APIUserAbortError → ABORTED「已中断」（子类须先于 APIError 判定）', () => {
    expect(openaiToErrorEvent(new OpenAI.APIUserAbortError({ message: 'Request was aborted.' }))).toEqual({
      type: 'error',
      message: '已中断',
      retryable: false,
      code: 'ABORTED',
    })
  })

  it('APIConnectionError → NETWORK 可重试（Y-14：布尔与决策表对齐），message 脱敏', () => {
    const e = new OpenAI.APIConnectionError({ message: 'fetch failed: https://gw.test/v1?api_key=sk-abcdefghijklmnopqrst' })
    const ev = openaiToErrorEvent(e)
    // Y-14（第五十七轮）：retryable 改 true——failure.ts 决策表 NETWORK → 'retry'，
    // 此前 false 全靠 code 兜住，布尔兜底分支（mode:'always'）会静默翻转不重试
    expect(ev).toMatchObject({ type: 'error', retryable: true, code: 'NETWORK' })
    if (ev.type === 'error') {
      expect(ev.message).toContain('fetch failed')
      expect(ev.message).toContain('***REDACTED***')
    }
  })

  it('APIError 429 → retryable + RATE_LIMIT + status/Retry-After/request-id 提取', () => {
    const e = new OpenAI.APIError(
      429,
      { type: 'error', message: 'rate limited' },
      'rate limited',
      new Headers({ 'retry-after': '7', 'x-request-id': 'req-1' }),
    )
    expect(openaiToErrorEvent(e)).toEqual({
      type: 'error',
      // SDK makeMessage 自带 status 前缀（e.message = "429 rate limited"），label 再叠一层——历史如此
      message: 'OpenAI API 429: 429 rate limited',
      retryable: true,
      code: 'RATE_LIMIT',
      status: 429,
      retryAfterMs: 7000,
      requestId: 'req-1',
    })
  })

  it('APIError 401 → AUTH 不可重试；Anthropic 线 label 生效', () => {
    const e = new Anthropic.APIError(401, { type: 'error', message: 'invalid api key' }, 'invalid api key', undefined)
    expect(anthropicToErrorEvent(e)).toMatchObject({
      type: 'error',
      message: 'Anthropic API 401: 401 invalid api key',
      retryable: false,
      code: 'AUTH',
      status: 401,
    })
  })

  it('APIError status undefined → 无 status 键、code UNKNOWN', () => {
    const e = new OpenAI.APIError(undefined, { message: 'odd gateway' }, 'odd gateway', undefined)
    const ev = openaiToErrorEvent(e)
    expect(ev).toMatchObject({ type: 'error', retryable: false, code: 'UNKNOWN' })
    if (ev.type === 'error') expect('status' in ev).toBe(false)
  })

  it('SDK 外层 AbortError（name 判定）→ ABORTED', () => {
    const abort = new Error('The operation was aborted')
    abort.name = 'AbortError'
    expect(openaiToErrorEvent(abort)).toEqual({ type: 'error', message: '已中断', retryable: false, code: 'ABORTED' })
  })

  it('兜底：普通 Error / 非 Error → PROTOCOL，message 脱敏', () => {
    expect(openaiToErrorEvent(new Error('parse boom sk-abcdefghijklmnopqrst'))).toMatchObject({
      type: 'error',
      retryable: false,
      code: 'PROTOCOL',
    })
    expect(openaiToErrorEvent('plain string')).toEqual({
      type: 'error',
      message: 'plain string',
      retryable: false,
      code: 'PROTOCOL',
    })
  })
})

describe('buildDegradeAttempts 四分支（attempts 顺序与条件逐项保持）', () => {
  const CONF = { id: 'p1', model: 'm1' }
  const REQ_ST: GenRequest = {
    systemPrompt: '',
    messages: [{ role: 'user', content: 'hi' }],
    structured: { schema: { type: 'object' } },
    tools: [{ name: 't', input_schema: {} }],
  }

  it('structured + tools 无记忆 → [req, 剥 structured, 剥 tools]', () => {
    const plan = buildDegradeAttempts(REQ_ST, 'json_schema', CONF, undefined)
    expect(plan.attempts).toHaveLength(3)
    expect(plan.attempts[0]).toBe(REQ_ST)
    expect(plan.attempts[1]).toMatchObject({ structured: undefined, tools: REQ_ST.tools })
    expect(plan.attempts[2]).toMatchObject({ structured: REQ_ST.structured, tools: undefined, toolChoice: undefined, toolName: undefined })
  })

  it('structured + tools 记忆命中（查通道）→ 首发即剥 structured', () => {
    registerDegradedLookup(() => true)
    const plan = buildDegradeAttempts(REQ_ST, 'json_schema', CONF, undefined)
    expect(plan.attempts).toHaveLength(2)
    expect(plan.attempts[0]).toMatchObject({ structured: undefined })
    expect(plan.attempts[1]).toMatchObject({ tools: undefined })
  })

  it('structured + tools 记忆命中（store 快照回落）→ 同上', () => {
    const store: ProviderStore = {
      providers: [], currentId: null, currentModel: null,
      modelCaps: { 'p1/m1': { structured: false } },
      tiers: { creative: { model: '', effort: 'high' }, assistant: null, chat: null },
      ragProviders: [], revision: 0, vault: null, dek: null,
    }
    const plan = buildDegradeAttempts(REQ_ST, 'json_schema', CONF, store)
    expect(plan.attempts).toHaveLength(2)
    expect(plan.attempts[0]).toMatchObject({ structured: undefined })
  })

  it('仅 structured：无记忆 [req, 剥]；有记忆 [剥]', () => {
    const req: GenRequest = { ...REQ_ST, tools: undefined }
    expect(buildDegradeAttempts(req, 'json_schema', CONF, undefined).attempts).toHaveLength(2)
    registerDegradedLookup(() => true)
    expect(buildDegradeAttempts(req, 'json_schema', CONF, undefined).attempts).toHaveLength(1)
  })

  it('仅 tools → [req, 剥 tools]（记忆不作用于 tools 档）', () => {
    const req: GenRequest = { ...REQ_ST, structured: undefined }
    registerDegradedLookup(() => true)
    const plan = buildDegradeAttempts(req, 'json_schema', CONF, undefined)
    expect(plan.attempts).toHaveLength(2)
    expect(plan.attempts[0]).toBe(req)
  })

  it('structuredMode=none → structured 不入链（表已保证不发，无降级意义）', () => {
    const plan = buildDegradeAttempts(REQ_ST, 'none', CONF, undefined)
    expect(plan.attempts).toHaveLength(2)
    expect(plan.attempts[1]).toMatchObject({ tools: undefined, structured: REQ_ST.structured })
  })

  it('无可剥参数面 → [req]；未选模型 → degradedKey null（无处写记忆）', () => {
    const plain: GenRequest = { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] }
    const plan = buildDegradeAttempts(plain, 'json_schema', CONF, undefined)
    expect(plan.attempts).toEqual([plain])
    const noModel = buildDegradeAttempts(REQ_ST, 'json_schema', { id: 'p1', model: undefined }, undefined)
    expect(noModel.degradedKey).toBeNull()
    expect(noModel.attempts).toHaveLength(3) // 无 model → 无记忆 → 原样三级
  })
})

describe('isMidChain400 续跑闸', () => {
  const CONF = { id: 'p1', model: 'm1' }
  const REQ_ST: GenRequest = {
    systemPrompt: '',
    messages: [{ role: 'user', content: 'hi' }],
    structured: { schema: {} },
    tools: [{ name: 't', input_schema: {} }],
  }

  it('非最后 attempt 的 400 → true；最后 attempt 的 400 → false（透传原文）', () => {
    const plan = buildDegradeAttempts(REQ_ST, 'json_schema', CONF, undefined)
    const e400 = new OpenAI.APIError(400, { message: 'bad' }, 'bad', undefined)
    expect(isMidChain400(e400, OpenAI.APIError, plan.attempts[0]!, plan)).toBe(true)
    expect(isMidChain400(e400, OpenAI.APIError, plan.attempts[2]!, plan)).toBe(false)
  })

  it('非 400（500）与非 APIError → false（不做降级续跑）', () => {
    const plan = buildDegradeAttempts(REQ_ST, 'json_schema', CONF, undefined)
    expect(isMidChain400(new OpenAI.APIError(500, { message: 'x' }, 'x', undefined), OpenAI.APIError, plan.attempts[0]!, plan)).toBe(false)
    expect(isMidChain400(new Error('400-ish'), OpenAI.APIError, plan.attempts[0]!, plan)).toBe(false)
    // 另一家 SDK 的 APIError 不得误判（构造函数传参隔离两线）
    expect(isMidChain400(new OpenAI.APIError(400, { message: 'bad' }, 'bad', undefined), Anthropic.APIError, plan.attempts[0]!, plan)).toBe(false)
  })
})

describe('markStructuredDegrade 记忆写入', () => {
  const CONF = { id: 'p1', model: 'm1' }
  const REQ_ST: GenRequest = {
    systemPrompt: '',
    messages: [{ role: 'user', content: 'hi' }],
    structured: { schema: {} },
    tools: [{ name: 't', input_schema: {} }],
  }

  function emptyStore(): ProviderStore {
    return {
      providers: [], currentId: null, currentModel: null, modelCaps: {},
      tiers: { creative: { model: '', effort: 'high' }, assistant: null, chat: null },
      ragProviders: [], revision: 0, vault: null, dek: null,
    }
  }

  it('剥 structured 的 attempt 建流成功 → 双写（store 快照 + persist 通道）', () => {
    const persisted: string[] = []
    registerDegradedPersist((key) => { persisted.push(key) })
    const store = emptyStore()
    const plan = buildDegradeAttempts(REQ_ST, 'json_schema', CONF, store)
    markStructuredDegrade(plan, plan.attempts[1]!, store)
    expect(store.modelCaps['p1/m1']).toEqual({ structured: false })
    expect(persisted).toEqual(['p1/m1'])
  })

  it('首发原样与剥 tools 的 attempt 都不写 structured 记忆（归因不同，防污染）', () => {
    const persisted: string[] = []
    registerDegradedPersist((key) => { persisted.push(key) })
    const store = emptyStore()
    const plan = buildDegradeAttempts(REQ_ST, 'json_schema', CONF, store)
    markStructuredDegrade(plan, plan.attempts[0]!, store)
    markStructuredDegrade(plan, plan.attempts[2]!, store)
    expect(store.modelCaps['p1/m1']).toBeUndefined()
    expect(persisted).toEqual([])
  })
})
