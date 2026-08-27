/**
 * B-2 / B-12（第六十轮）回归：degraded 与失败 usage 的 llm/call 全链贯通。
 *
 * B-2（铁律②重放口径）：Z-12 建立了 extractDegraded（run 回调壳带 degraded 则落
 * llm/call），gen 层确实产出 GenResult.degraded，但链路有两处断点——①三处 run 回调
 * 返回对象均不含该字段（spec/turns/finish，extractDegraded 恒 false）；②runner 的
 * trace() 入参带了 degraded 却没转发进 llmCallEvent（spread 绕过类型检查静默丢弃）。
 * 降级面成功（GLM/Kimi 家族 structured 剥除重试，设计内常态路径）的事件记录与真实
 * 参数面静默分叉，重放不可精确重建「一次成功调用的真实请求形态」。
 *
 * B-12：max_tokens 截断抛 GenError 时网关已返回 usage 被丢弃，runner 终态失败路径
 * recordUsageSafe(null) 记 0 token（次数口径保守正确，成本口径低估）——GenError 增
 * 可选 usage 载荷，spec 抛错前挂上，runner 按可得值入账/入 trace。
 *
 * 手法：mock gen 层产出 degraded / max_tokens → runSpec → 重开事件库读回 workspace
 * 链的 llm/call 事件，断言 degraded / usage 字段（修复前：degraded 恒缺失、失败 usage
 * 恒 {input:0, output:0}）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../../src/ai/gen.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ai/gen.js')>()
  return {
    ...actual,
    generate: vi.fn(),
  }
})

import { generate } from '../../src/ai/gen.js'
import { runSpec, type TaskSpec } from '../../src/ai/tasks/spec.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'

const generateMock = generate as unknown as ReturnType<typeof vi.fn>

const workDirs: string[] = []
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  workDirs.push(d)
  return d
}

function writeProviders(userDataPath: string): void {
  writeFileSync(
    join(userDataPath, 'providers.json'),
    JSON.stringify({
      providers: [
        {
          id: 'prov-test',
          name: 'test',
          protocol: 'openai',
          auth: 'bearer',
          baseUrl: 'http://localhost:1',
          apiKey: 'sk-test',
          caps: { connected: true, streaming: true },
        },
      ],
      currentId: 'prov-test',
      currentModel: 'gpt-4o',
    }),
  )
}

const TEXT_SPEC: TaskSpec = {
  name: 'spawn-write',
  tierKind: 'creative',
  genMode: 'text',
  systemPrompt: '你是网文写作引擎',
}

interface LlmCallEvent {
  type: 'llm/call'
  data: {
    ok: boolean
    errCode?: string
    degraded?: boolean
    usage?: { input: number; output: number }
  }
}

function readLlmCalls(ud: string, bookRoot: string): LlmCallEvent[] {
  const store = openSessionStore(ud, bookRoot)!
  return store.listEvents(bookHash(bookRoot)).filter((e) => e.type === 'llm/call') as unknown as LlmCallEvent[]
}

describe('B-2/B-12（第六十轮）：degraded 透传与失败 usage 的 llm/call 全链', () => {
  afterEach(() => {
    generateMock.mockReset()
    try { for (const d of workDirs.splice(0)) rmSync(d, { recursive: true, force: true }) } catch {
          // Windows 清理竞态（防病毒/句柄占用偶发 EPERM）——best-effort 忽略
        }
  })

  it('B-2：降级参数面成功 → runSpec 回调带 degraded → llm/call 事件带 degraded:true（三断点全闭合）', async () => {
    const ud = tempDir('clw-b2-ud-')
    writeProviders(ud)
    const bookRoot = tempDir('clw-b2-book-')
    mkdirSync(join(bookRoot, '.cache'), { recursive: true })
    generateMock.mockResolvedValue({
      text: 'ok', reasoning: '', toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 3 },
      stopReason: 'end_turn',
      degraded: true,
    })

    const out = await runSpec(TEXT_SPEC, { userDataPath: ud, userPrompt: '写第二章', bookRoot })
    expect(out.ok).toBe(true)

    const calls = readLlmCalls(ud, bookRoot)
    expect(calls).toHaveLength(1)
    // 修复前断点①：spec run 回调不带 degraded → extractDegraded 恒 false
    // 修复前断点②：trace 入参带了 degraded 却未转发进 llmCallEvent
    expect(calls[0]!.data.degraded).toBe(true)
    expect(calls[0]!.data.ok).toBe(true)
  })

  it('B-2 对照：非降级成功 → llm/call 不带 degraded 字段', async () => {
    const ud = tempDir('clw-b2c-ud-')
    writeProviders(ud)
    const bookRoot = tempDir('clw-b2c-book-')
    mkdirSync(join(bookRoot, '.cache'), { recursive: true })
    generateMock.mockResolvedValue({
      text: 'ok', reasoning: '', toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 3 },
      stopReason: 'end_turn',
    })

    const out = await runSpec(TEXT_SPEC, { userDataPath: ud, userPrompt: '写第二章', bookRoot })
    expect(out.ok).toBe(true)
    const calls = readLlmCalls(ud, bookRoot)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.data.degraded).toBeUndefined()
  })

  it('B-12：max_tokens 截断 → GenError.usage 载荷 → 失败 llm/call 事件带真实 usage（不再记 0）', async () => {
    const ud = tempDir('clw-b12-ud-')
    writeProviders(ud)
    const bookRoot = tempDir('clw-b12-book-')
    mkdirSync(join(bookRoot, '.cache'), { recursive: true })
    generateMock.mockResolvedValue({
      text: '截断的半截产出', reasoning: '', toolCalls: [],
      usage: { inputTokens: 1200, outputTokens: 4096 },
      stopReason: 'max_tokens',
    })

    const out = await runSpec(TEXT_SPEC, { userDataPath: ud, userPrompt: '写第二章', bookRoot })
    expect(out).toMatchObject({ ok: false, code: 'GEN_FAIL' })
    if (!out.ok) expect(out.error).toContain('长度上限')

    const calls = readLlmCalls(ud, bookRoot)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.data.ok).toBe(false)
    expect(calls[0]!.data.errCode).toBe('GEN_FAIL')
    // 修复前：失败路径恒 usage:null → toTraceUsage(null) = {input:0, output:0}，成本口径低估
    expect(calls[0]!.data.usage).toMatchObject({ input: 1200, output: 4096 })
  })

  it('B-12 对照：无 usage 载荷的普通失败 → 失败事件 usage 保持 0 口径不变', async () => {
    const ud = tempDir('clw-b12c-ud-')
    writeProviders(ud)
    const bookRoot = tempDir('clw-b12c-book-')
    mkdirSync(join(bookRoot, '.cache'), { recursive: true })
    // 不可重试且不带 usage/code 的 GenError（多数失败响应无 usage——口径不扩大；
    // 不用 SERVER_ERROR：该 code 命中重试决策表会走退避链，混入多次事件）
    generateMock.mockRejectedValue(new (await import('../../src/ai/gen.js')).GenError('网关坏了', false))

    const out = await runSpec(TEXT_SPEC, { userDataPath: ud, userPrompt: '写第二章', bookRoot })
    expect(out).toMatchObject({ ok: false, code: 'GEN_FAIL' })
    const calls = readLlmCalls(ud, bookRoot)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.data.errCode).toBe('GEN_FAIL')
    // 无载荷失败：usage 字段缺失（trace null → llmCallEvent 省略），口径不扩大
    expect(calls[0]!.data.usage).toBeUndefined()
  })
})
