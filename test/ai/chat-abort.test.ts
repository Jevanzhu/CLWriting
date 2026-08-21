/**
 * Z-P1-1 / Z-P2-5 回归：chat 中断传播到嵌套 AI 生成 + 挂起确认即时释放。
 *
 * 用 fake-provider 跑真实 HTTP 全链路（非 mock 分支）：
 * - 嵌套 rewrite_chapter 生成在 abort 后立即中止（不再跑到 runTask 10 分钟总超时白烧 token）；
 * - signal 已 aborted 时嵌套生成根本不发请求（runSpec 提前返回中断）；
 * - waitConfirm 监听 signal abort——abort 先到后挂起的确认即时按取消处理，不空等满超时。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir, LONG_BOOK } from '../studio/fixtures.js'
import { runChat, isChatRunning, abortChat, resolveChatConfirm, waitConfirm } from '../../src/ai/orchestrate/chat.js'
import { rewriteChapter } from '../../src/ai/tools/rewrite.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/types.js'

let fake: FakeProvider
const dirs: string[] = []
let workDir: string
/** 长篇书根（有第 1 章正文，rewrite 工具可跑） */
let longRoot: string

beforeAll(async () => {
  fake = await createFakeProvider()
})

afterAll(async () => {
  await fake.close()
})

beforeEach(() => {
  workDir = makeDualTrackWorkdir()
  longRoot = join(workDir, '长篇', LONG_BOOK)
  dirs.push(workDir)
})

afterEach(() => {
  delete process.env.CLWRITING_DRIVER
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 带 fake provider 的 userData */
function setup(): string {
  const ud = tempUserData()
  dirs.push(ud)
  delete process.env.CLWRITING_DRIVER
  withFakeProvider(ud, fake.url)
  return ud
}

/** 最小 driver（捕获 emit 事件） */
function makeDriver(emitted: DriverEvent[]): StudioDriver {
  return {
    async startSession(cwd: string): Promise<Session> {
      return { id: 'mock', cwd, closed: false }
    },
    async *stream(): AsyncGenerator<DriverEvent> {},
    dispose(): void {},
    emit(_s, ev): void {
      emitted.push(ev)
    },
  }
}

/** 等条件满足（带超时） */
async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout after ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

// ─── Z-P1-1：嵌套 rewrite 生成随 chat 中止（全链路） ──────────────

describe('Z-P1-1: 嵌套 rewrite 生成随 chat 中止', () => {
  it('rewrite 生成在途时 abortChat → 请求被取消、runSpec 提前返回，不再发新请求', { timeout: 10_000 }, async () => {
    // 第 1 次请求：chat 吐 rewrite_chapter 工具调用；
    // 第 2 次请求：嵌套改写生成——delayMs 挂住在途，给 abort 留出窗口
    fake.setScript([
      { type: 'tool', name: 'rewrite_chapter', input: { chapter: 1, instruction: '压缩战斗' } },
      { type: 'tool', name: 'submit_text', input: { 正文: '改写稿' }, delayMs: 4000 },
    ])
    const events: DriverEvent[] = []
    const driver = makeDriver(events)
    const ud = setup()

    const chatPromise = runChat({
      driver,
      mainSession: { id: 's1', cwd: workDir, closed: false },
      userDataPath: ud,
      bookRoot: longRoot,
      bookName: 'abort-nested',
      message: '帮我改写第 1 章',
      confirmTimeoutMs: 5000,
    })

    // 确认闸放行 → 嵌套生成请求发出（requestCount=2 即生成在途）
    await waitFor(() => events.some((e) => e.type === 'chat_tool_pending'))
    const pending = events.find((e) => e.type === 'chat_tool_pending') as { callId: string }
    resolveChatConfirm('abort-nested', pending.callId, true)
    await waitFor(() => fake.requestCount() >= 2)

    // 中断 → 嵌套生成应立即取消（修复前会挂到 delayMs/总超时才返回）
    const abortAt = Date.now()
    abortChat('abort-nested')
    await chatPromise
    expect(Date.now() - abortAt).toBeLessThan(3000)

    // 工具结果为中断失败，循环终止于 chat_error，且不再发新 LLM 请求
    const toolResult = events.find((e) => e.type === 'chat_tool_result') as { ok: boolean; summary: string }
    expect(toolResult.ok).toBe(false)
    expect(toolResult.summary).toContain('中断')
    const err = events.find((e) => e.type === 'chat_error') as { error: string } | undefined
    expect(err?.error).toContain('中断')
    const countAfterAbort = fake.requestCount()
    await new Promise((r) => setTimeout(r, 200))
    expect(fake.requestCount()).toBe(countAfterAbort)
    expect(isChatRunning('abort-nested')).toBe(false)
  })

  it('signal 已 aborted 时工具直调 → 不发任何 LLM 请求，立即返回中断', async () => {
    const ud = setup()
    fake.setScript([{ type: 'tool', name: 'submit_text', input: { 正文: 'x' } }])
    const ctrl = new AbortController()
    ctrl.abort()

    const r = await rewriteChapter(
      { bookRoot: longRoot, bookName: LONG_BOOK, userDataPath: ud, signal: ctrl.signal },
      { chapter: 1, instruction: '压缩' },
    )

    expect(r.ok).toBe(false)
    expect(r.summary).toContain('中断')
    // 请求根本没发出（fetch 对已 aborted 的 signal 立即拒绝，不打到 stub）
    expect(fake.requestCount()).toBe(0)
  })
})

// ─── Z-P1-1：waitConfirm 监听 abort（单元） ────────────────────────

/** waitConfirm 的运行态（ChatRunState 结构等价物——接口未导出，按形状构造） */
function mkState(): { ctrl: AbortController; deadline: number; pending: Map<string, (ok: boolean) => void>; confirmTimedOut?: Set<string> } {
  return { ctrl: new AbortController(), deadline: 0, pending: new Map() }
}

describe('Z-P1-1: waitConfirm abort 即时释放', () => {
  it('挂起中 abort → 立即按取消处理并清理（不等超时）', async () => {
    const state = mkState()
    const t0 = Date.now()
    const p = waitConfirm(state, 'c1', 8000)
    state.ctrl.abort()
    const ok = await p
    expect(ok).toBe(false)
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(state.pending.size).toBe(0)
  })

  it('P5-AI（第七轮）：超时终局标记 confirmTimedOut——「确认超时」与「作者取消」分开归因', async () => {
    const state = mkState()
    const ok = await waitConfirm(state, 'c9', 5)
    expect(ok).toBe(false)
    expect(state.confirmTimedOut?.has('c9')).toBe(true)
    // 人工取消（pending 主动 resolve false）不标记
    const s2 = mkState()
    const p2 = waitConfirm(s2, 'c10', 8000)
    s2.pending.get('c10')?.(false)
    expect(await p2).toBe(false)
    expect(s2.confirmTimedOut?.has('c10')).toBeFalsy()
  })

  it('abort 先于挂起到达（signal 已 aborted）→ 挂起即拒，不空等满超时', async () => {
    // 回归场景：abortChat 只放行「当时已挂起」的确认，循环里后续工具的
    // waitConfirm 启动时 signal 已 aborted——修复前要各空等满 confirmTimeout
    const state = mkState()
    state.ctrl.abort()
    const t0 = Date.now()
    const ok = await waitConfirm(state, 'c2', 8000)
    expect(ok).toBe(false)
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(state.pending.size).toBe(0)
  })

  it('作者确认先 settle → 晚到的 abort 不再改结果（幂等）', async () => {
    const state = mkState()
    const p = waitConfirm(state, 'c3', 8000)
    state.pending.get('c3')!(true)
    state.ctrl.abort()
    await expect(p).resolves.toBe(true)
    expect(state.pending.size).toBe(0)
  })

  it('无 abort 时超时路径仍生效（既有行为回归）', async () => {
    const t0 = Date.now()
    const ok = await waitConfirm(mkState(), 'c4', 50)
    expect(ok).toBe(false)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40)
  })
})
