/**
 * 二十七轮修复批 F 回归（R27-1 / 2 / 4 / 6）——根因-语义-测法：
 * - R27-1 llm/call durationMs 混入记账 IO：trace 内联 Date.now() 时 recordUsageSafe
 *   的记账耗时（含用量文件锁等待）被计入 attempt 时长 → mock recordTaskUsage 同步
 *   忙等 80ms，断言 durationMs 只含 run 窗口（<50ms）而墙钟 ≥80ms。
 * - R27-2 anthropic usage「首见即定」：多个 message_delta 带 usage 时 emitDone 幂等门
 *   锁首值、末 delta 完整值被丢，与 openai 线 R26-3 末见口径分叉 → 双 delta 流断言
 *   done 取末值且 done 只发一次；既有「delta 优先于 message_start」语义不回归。
 * - R27-4 generateTool 截断判据漏「tool 在场但 input 空 {}」：anthropic content_block_stop
 *   空 jsonBuf 兜成 {} 无 _raw，撞顶截断按成功出场 → max_tokens + 空 input 抛 GenError；
 *   正常 end_turn 下的合法零参调用不受影响（对照臂）。
 * - R27-6 HTTP 408 不进可重试族：此前落 UNKNOWN 终态化 author → 命名码 TIMEOUT +
 *   failureAction 判 retry。
 * R27-3（chat_done attemptsUsage 优先）为口径对齐型一行改——现网可达状态两值恒等
 * （可重试失败均无 usage 载荷），无行为差可断言，由 tsc + 既有 chat 套件覆盖，不设专测；
 * R27-5 / R27-7 登记（评估与理由见修复报告）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateTool } from '../../src/ai/gen.js'
import { runTask } from '../../src/ai/runner.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { createAnthropicProvider } from '../../src/ai/provider/anthropic-adapter.js'
import { httpStatusToCode, failureAction } from '../../src/ai/provider/failure.js'
import type { GenEvent, GenRequest, ModelProvider, ProviderConf } from '../../src/ai/provider/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

// R27-1：把记账入口换成同步忙等——runner 对 recordTaskUsage 的调用耗时可观测
vi.mock('../../src/ai/calls.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ai/calls.js')>()
  return {
    ...actual,
    recordTaskUsage: vi.fn(() => {
      const end = Date.now() + 80
      while (Date.now() < end) { /* 同步忙等：制造可断言的记账 IO 延迟 */ }
    }),
  }
})

const CONF = { name: 'fake' } as ProviderConf

function signal(): AbortSignal {
  return new AbortController().signal
}

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

// ── R27-1：durationMs 不含记账 IO ──

describe('R27-1: llm/call durationMs 排除 recordUsageSafe 记账耗时', () => {
  afterEach(() => {
    delete process.env.CLWRITING_DRIVER
  })

  it('记账忙等 80ms 不进 durationMs（墙钟 ≥80ms 而 attempt 时长 <50ms）', async () => {
    const ud = mkdtempTracked(join(tmpdir(), 'r27-runner-ud-'))
    const root = mkdtempTracked(join(tmpdir(), 'r27-runner-book-'))
    writeFileSync(
      join(ud, 'providers.json'),
      JSON.stringify({
        providers: [{ id: 'prov-test', name: 'test', protocol: 'openai', auth: 'bearer', baseUrl: 'http://localhost:1', apiKey: 'sk-test', caps: { connected: true, streaming: true } }],
        currentId: 'prov-test',
        currentModel: 'gpt-4o',
      }),
    )
    const wallStart = Date.now()
    const out = await runTask<string>({
      userDataPath: ud,
      bookRoot: root,
      task: 'self-heal',
      run: () => Promise.resolve('ok'),
    })
    const wall = Date.now() - wallStart
    expect(out.ok).toBe(true)
    // 墙钟含记账忙等；mock 生效自证
    expect(wall).toBeGreaterThanOrEqual(80)
    const store = openSessionStore(ud, root)!
    try {
      const call = store.listEvents(bookHash(root)).find((e) => e.type === 'llm/call')
      expect(call).toBeDefined()
      const data = call!.data as { ok?: boolean; durationMs: number }
      expect(data.ok).toBe(true)
      // 修复前：durationMs ≥ 80（记账忙等被计入）；修复后只含 run 窗口（即时 resolve ≈ 0）
      expect(data.durationMs).toBeLessThan(50)
    } finally {
      store.close()
    }
  }, 10_000)
})

// ── R27-2：anthropic usage 末见 wins ──

describe('R27-2: anthropic 多 message_delta usage 末见 wins', () => {
  it('两个带 usage 的 message_delta → done 取末 delta 值且 done 只发一次', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正文产出' } },
          // 首 delta：部分值（逐 chunk 回 usage 的网关形态）
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 11, output_tokens: 2 } },
          // 末 delta：完整值（修复前被 emitDone 幂等门丢弃）
          { type: 'message_delta', delta: {}, usage: { input_tokens: 12, output_tokens: 5 } },
        ]),
      },
    } as unknown as import('@anthropic-ai/sdk').default
    const evs = await collect(createAnthropicProvider(CONF, client), { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] })
    const dones = evs.filter((e) => e.type === 'done')
    expect(dones).toHaveLength(1)
    if (dones[0]?.type !== 'done') return
    expect(dones[0].usage.inputTokens).toBe(12)
    expect(dones[0].usage.outputTokens).toBe(5)
  })

  it('单 delta 既有语义不回归：delta 缺 input_tokens 时回退 message_start 实测值', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正文产出' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
        ]),
      },
    } as unknown as import('@anthropic-ai/sdk').default
    const evs = await collect(createAnthropicProvider(CONF, client), { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] })
    const done = evs.find((e) => e.type === 'done')
    if (done?.type !== 'done') return expect(done).toBeDefined()
    expect(done.usage.inputTokens).toBe(10)
    expect(done.usage.outputTokens).toBe(3)
  })

  it('无 usage 网关走估计兜底（pendingStopReason 在场）语义不回归', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正文产出' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        ]),
      },
    } as unknown as import('@anthropic-ai/sdk').default
    const evs = await collect(createAnthropicProvider(CONF, client), { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] })
    const done = evs.find((e) => e.type === 'done')
    if (done?.type !== 'done') return expect(done).toBeDefined()
    expect(done.usage.estimated).toBe(true)
    expect(done.usage.inputTokens).toBe(10) // message_start 实测值优先
  })
})

// ── R27-4：generateTool 空 {} input 截断判据 ──

describe('R27-4: generateTool 空 input + max_tokens → MAX_TOKENS', () => {
  it('tool 在场、input 为空 {}、stopReason=max_tokens → 抛 GenError（usage 随行）', async () => {
    const p: ModelProvider = {
      conf: CONF,
      async *stream() {
        yield { type: 'tool', id: 't1', name: 'fn', input: {} }
        yield { type: 'done', usage: { inputTokens: 10, outputTokens: 3 }, stopReason: 'max_tokens' }
      },
    }
    await expect(generateTool(p, { systemPrompt: '', messages: [] }, signal())).rejects.toMatchObject({
      name: 'GenError',
      code: 'MAX_TOKENS',
    })
  })

  it('对照：end_turn 下的空 {} 是合法零参调用，照常成功', async () => {
    const p: ModelProvider = {
      conf: CONF,
      async *stream() {
        yield { type: 'tool', id: 't1', name: 'fn', input: {} }
        yield { type: 'done', usage: { inputTokens: 10, outputTokens: 3 }, stopReason: 'end_turn' }
      },
    }
    const r = await generateTool(p, { systemPrompt: '', messages: [] }, signal())
    expect(r.input).toEqual({})
  })
})

// ── R27-6：408 → TIMEOUT 命名码 + 可重试 ──

describe('R27-6: HTTP 408 入可重试族', () => {
  it('httpStatusToCode(408) === TIMEOUT；failureAction(TIMEOUT) === retry', () => {
    expect(httpStatusToCode(408, 'Request Timeout')).toBe('TIMEOUT')
    expect(failureAction({ code: 'TIMEOUT' })).toBe('retry')
  })
})
