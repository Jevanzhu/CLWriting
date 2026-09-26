/**
 * Anthropic 协议真线全链测试（0918独立重评修复批 G002）。
 *
 * 背景：此前 anthropic-adapter 只经进程内假 client（adapter-fixtures 的 fakeSend）
 * 间接行使，真线面（@anthropic-ai/sdk 的 HTTP/SSE 线级解析、/v1/messages 拼接、
 * 认证头）只有源码刮取锚——实配 Claude/中转网关用户的主链路端到端不触网。
 * 本件以真实 HTTP 打到进程内 Anthropic stub（test/ai/fake-provider.ts 的
 * createFakeAnthropicProvider，POST /v1/messages 流式 SSE，事件序列合规），
 * 经真 anthropic-adapter（registry 按 conf.protocol 路由）→ runTask 全链：
 *
 * - ①纯文本流端到端：文本聚合 + usage 记账（input 记 message_start / output 记
 *   message_delta）+ 认证头（auth='anthropic' → x-api-key + anthropic-version，
 *   无 Authorization 双认证）+ 请求拼装（/v1/messages、model/stream/system、
 *   max_tokens 协议兜底 16384）断言
 * - ②tool_use 端到端：content_block_start(tool_use) + input_json_delta 两分片 →
 *   适配器 jsonBuf 增量拼 JSON → toolCalls 解析（工具名/入参/stop_reason 透传）
 * - ③stop_reason=max_tokens：generateText 抛不可重试 GenError(MAX_TOKENS) →
 *   runTask GEN_FAIL，usage 随错上抛入账（B-12）
 * - ④SSE error 事件（overloaded_error）：SDK Stream 对 event:error 直接 throw
 *   APIError(status undefined) → 适配器 toErrorEvent 码 UNKNOWN，message_start
 *   已实测 input 以 estimated usage 随错上抛（R0917-6-P3-4 通道）
 */
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest'
import {
  createFakeAnthropicProvider,
  type FakeAnthropicProvider,
  type AnthropicFakeResponse,
} from '../fake-provider.js'
import { withFakeProvider, tempUserData } from '../../studio/fixtures.js'
import { runTask } from '../../../src/ai/runner.js'
import { generateText, generateTool, generate } from '../../../src/ai/gen.js'

let fake: FakeAnthropicProvider
const dirs: string[] = []

beforeAll(async () => {
  fake = await createFakeAnthropicProvider()
})

afterAll(async () => {
  await fake.close()
})

afterEach(() => {
  delete process.env.CLWRITING_DRIVER
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** anthropic 协议 fake provider 的 userData（G002：withFakeProvider 第 4 参切协议） */
function setup(): string {
  const ud = tempUserData()
  dirs.push(ud)
  delete process.env.CLWRITING_DRIVER // 保证走非 mock 分支
  withFakeProvider(ud, fake.url, undefined, { protocol: 'anthropic' })
  return ud
}

// ─── ①纯文本流端到端：认证头 + 请求拼装 + 文本聚合 + usage 记账 ───────────

describe('Anthropic 真线：纯文本流端到端', () => {
  it('SSE 文本流 → runTask 全链：文本聚合、usage 分记、认证头与请求拼装合规', async () => {
    fake.setScript([
      { type: 'text', content: 'anthropic 真线正文', usage: { input: 123, output: 45 } },
    ] satisfies AnthropicFakeResponse[])
    const ud = setup()

    // run 回调走 generate（GenResult 载体）——generateText 只返回 string，
    // usage 记账断言需经 run 回调返回值的 { usage } 提取（runTask extractUsage 面）
    const out = await runTask<{ text: string; stopReason: string }>({
      userDataPath: ud,
      // P0-1 同款守卫：mockText 形状随泛型 T（driver 非 mock 时不短路，请求必打 stub）
      mockText: { text: '## 不该出现的 mock 文本', stopReason: 'mock' },
      run: (provider, signal) =>
        generate(provider, { systemPrompt: '测试系统提示', messages: [{ role: 'user', content: 'test' }] }, signal),
    })

    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.data.text).toBe('anthropic 真线正文')
      expect(out.data.stopReason).toBe('end_turn')
      // usage 记账：input 记 message_start、output 记 message_delta（P2-3/D4 口径）
      expect(out.usage).toEqual({ inputTokens: 123, outputTokens: 45 })
    }
    expect(fake.requestCount()).toBe(1)

    // 认证头：auth='anthropic' → 只发 x-api-key + anthropic-version（严格网关的双认证 400 防线）
    expect(fake.lastHeaders()).toEqual({ 'x-api-key': 'sk-fake-key', 'anthropic-version': '2023-06-01' })

    // 请求拼装：conf.baseUrl（…/v1）经适配器剥尾 /v1 后 SDK 自拼 /v1/messages；
    // max_tokens unknown 家族无表值 → 协议兜底 16384（R73-3）
    const body = fake.lastBody()
    expect(body).toMatchObject({ model: 'fake-model', stream: true, system: '测试系统提示' })
    expect(body?.max_tokens).toBe(16_384)
  })
})

// ─── ②tool_use 端到端：input_json_delta 分片拼 JSON → toolCalls 解析 ──────

describe('Anthropic 真线：tool_use 端到端', () => {
  it('input_json_delta 分片 → 适配器增量拼装 → generateTool 拿到工具名与入参', async () => {
    fake.setScript([
      { type: 'tool', name: 'test_tool', input: { chapter: 1, ok: true }, id: 'toolu_wire_1' },
    ] satisfies AnthropicFakeResponse[])
    const ud = setup()

    const out = await runTask<{ input: unknown; stopReason: string }>({
      userDataPath: ud,
      run: (provider, signal) =>
        generateTool(
          provider,
          {
            systemPrompt: 'test',
            messages: [{ role: 'user', content: 'test' }],
            tools: [{ name: 'test_tool', input_schema: { type: 'object', properties: {} } }],
            requireTool: true,
            toolName: 'test_tool',
          },
          signal,
        ),
    })

    expect(out.ok).toBe(true)
    if (out.ok) {
      // 两片 partial_json 经 jsonBuf 增量拼装后 JSON.parse 还原完整入参
      expect(out.data.input).toEqual({ chapter: 1, ok: true })
      // stop_reason 原生透传口径（R30-13 登记）：anthropic 线透 'tool_use'
      expect(out.data.stopReason).toBe('tool_use')
    }

    // 请求面：tools 挂载；unknown 家族 toolChoiceMode=auto + requireTool → 不发 tool_choice
    const body = fake.lastBody()
    const tools = body?.tools as Array<Record<string, unknown>> | undefined
    expect(Array.isArray(tools)).toBe(true)
    expect(tools?.[0]).toMatchObject({ name: 'test_tool' })
    expect(body?.tool_choice).toBeUndefined()
  })
})

// ─── ③stop_reason=max_tokens：GenError(MAX_TOKENS) → GEN_FAIL + usage 入账 ──

describe('Anthropic 真线：max_tokens 截断', () => {
  it('message_delta stop_reason=max_tokens → generateText 抛不可重试 MAX_TOKENS，usage 随错上抛', async () => {
    fake.setScript([
      { type: 'max_tokens', partial: '被截断的部分文本', usage: { input: 70, output: 20 } },
    ] satisfies AnthropicFakeResponse[])
    const ud = setup()

    const out = await runTask<string>({
      userDataPath: ud,
      run: (provider, signal) =>
        generateText(provider, { systemPrompt: '', messages: [{ role: 'user', content: 'test' }] }, signal),
    })

    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.code).toBe('GEN_FAIL')
      // B-12：截断时网关已下发的 usage 随错上抛入账（不按 0 丢计费）
      expect(out.attemptsUsage).toEqual({ inputTokens: 70, outputTokens: 20 })
    }
    // MAX_TOKENS 终态不可重试——单次请求（stub maxRetries=0，runner 不进重试）
    expect(fake.requestCount()).toBe(1)
  })
})

// ─── ④SSE error 事件：SDK throw APIError(status undefined) → UNKNOWN + 估计 usage ──

describe('Anthropic 真线：流中 SSE error 事件', () => {
  it('overloaded_error 事件 → SDK 抛错 → 码 UNKNOWN，message_start 实测 input 以 estimated usage 随错上抛', async () => {
    fake.setScript([
      { type: 'sse_error', errorType: 'overloaded_error', message: 'Overloaded' },
    ] satisfies AnthropicFakeResponse[])
    const ud = setup()

    const out = await runTask<string>({
      userDataPath: ud,
      run: (provider, signal) =>
        generateText(provider, { systemPrompt: '', messages: [{ role: 'user', content: 'test' }] }, signal),
    })

    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.code).toBe('GEN_FAIL')
      expect(out.error).toContain('Overloaded')
      // R0917-6-P3-4：已消费流（message_start 在位）→ 实测 input 随错上抛，
      // output 无产出按估计折算为 0，estimated 标记估计口径
      expect(out.attemptsUsage).toEqual({ inputTokens: 100, outputTokens: 0, estimated: true })
    }
    expect(fake.requestCount()).toBe(1)
  })
})
