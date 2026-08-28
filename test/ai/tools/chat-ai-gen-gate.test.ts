/**
 * M-1（第六轮）回归：chat 的嵌套 AI 生成 + 章记账工具（rewrite_chapter /
 * rewrite_selection / lead_update）与 self-heal 互斥。
 *
 * 修复背景：calls.ts 章预算块按「同书同时只有一路生成」记账，write_chapter 分支一直
 * 有 isSelfHealRunning 闸，注册表三工具漏配——并发时两编排以不同章号交替调
 * recordAiCall，章号互覆把对方账块 fresh 重置清零，used/tokens/cost 三口径全部低估，
 * 预算闸（防自动写章烧钱的那道）被绕过。
 * 本测试锁两件事：
 * 1. self-heal 运行中 → 三工具被闸（summary 明示原因，无嵌套生成副作用）；
 * 2. self-heal 空闲 → rewrite_chapter 正常放行（闸不误伤）。
 * 三工具均为 write 级确认闸工具——先 resolveChatConfirm 放行确认，闸测的是执行层互斥。
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeProvider, type FakeProvider } from '../fake-provider.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir, LONG_BOOK } from '../../studio/fixtures.js'
import { runChat, resolveChatConfirm } from '../../../src/ai/orchestrate/chat.js'
import { isSelfHealRunning, runSelfHeal, type SelfHealOutcome } from '../../../src/ai/orchestrate/self-heal.js'
import { isSpawnRunning } from '../../../src/ai/orchestrate/spawn-registry.js'
import { acquireTaskGate, isTaskGateHeld } from '../../../src/studio/server/api/task-gate.js'
import type { DriverEvent, Session, StudioDriver } from '../../../src/driver/types.js'

// R66-2（十四轮）：write_chapter 闸测需要精确控制 self-heal 在途窗口——runSelfHeal
// 一并 mock（本文件其余用例走注册表工具，不经 self-heal，mock 不影响其行为）
vi.mock('../../../src/ai/orchestrate/self-heal.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/ai/orchestrate/self-heal.js')>()
  return { ...orig, isSelfHealRunning: vi.fn(() => false), runSelfHeal: vi.fn() }
})

// M-2（第八轮）：闸补查 spawn 手动写稿——mock spawn-registry 的判定函数
vi.mock('../../../src/ai/orchestrate/spawn-registry.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/ai/orchestrate/spawn-registry.js')>()
  return { ...orig, isSpawnRunning: vi.fn(() => false) }
})

let fake: FakeProvider
const dirs: string[] = []
let workDir: string
let bookRoot: string

beforeAll(async () => {
  fake = await createFakeProvider()
})

afterAll(async () => {
  await fake.close()
})

beforeEach(() => {
  workDir = makeDualTrackWorkdir()
  bookRoot = join(workDir, '长篇', LONG_BOOK)
  dirs.push(workDir)
  vi.mocked(isSelfHealRunning).mockReturnValue(false)
  vi.mocked(isSpawnRunning).mockReturnValue(false)
})

afterEach(() => {
  delete process.env.CLWRITING_DRIVER
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(): string {
  const ud = tempUserData()
  dirs.push(ud)
  delete process.env.CLWRITING_DRIVER
  withFakeProvider(ud, fake.url)
  return ud
}

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

async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout after ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function runConfirmedToolChat(script: unknown[]): Promise<DriverEvent[]> {
  const events: DriverEvent[] = []
  const driver = makeDriver(events)
  fake.setScript(script as never)
  const chatPromise = runChat({
    driver,
    mainSession: { id: 's1', cwd: workDir, closed: false },
    userDataPath: setup(),
    bookRoot,
    bookName: 'ai-gen-gate',
    message: '执行工具',
    confirmTimeoutMs: 5000,
  })
  // write 级工具先过确认闸
  await waitFor(() => events.some((e) => e.type === 'chat_tool_pending'))
  const pending = events.find((e) => e.type === 'chat_tool_pending') as { callId: string } | undefined
  resolveChatConfirm('ai-gen-gate', pending!.callId, true)
  await chatPromise
  return events
}

describe('M-1: AI 生成类 chat 工具与 self-heal 互斥', () => {
  it('self-heal 运行中 → rewrite_chapter 被闸，无嵌套生成副作用', { timeout: 15_000 }, async () => {
    vi.mocked(isSelfHealRunning).mockReturnValue(true)
    const events = await runConfirmedToolChat([
      { type: 'tool', name: 'rewrite_chapter', input: { chapter: 1, instruction: '压缩' } },
      { type: 'text', content: '知道了。' },
    ])
    expect(events.some((e) => e.type === 'chat_tool_result')).toBe(true)
    // 闸原因可感知（AI 据此告知作者，而不是误判失败重试）
    expect(JSON.stringify(events)).toContain('无法同时改写')
    // 未发生嵌套生成：无改写 spill 产物
    expect(existsSync(join(bookRoot, '工作区', 'spills'))).toBe(false)
  })

  it('self-heal 运行中 → lead_update 同样被闸', { timeout: 15_000 }, async () => {
    vi.mocked(isSelfHealRunning).mockReturnValue(true)
    const events = await runConfirmedToolChat([
      { type: 'tool', name: 'lead_update', input: { chapter: 1 } },
      { type: 'text', content: '好的。' },
    ])
    expect(JSON.stringify(events)).toContain('无法同时改写')
    // 未生成账本推进草稿
    expect(existsSync(join(bookRoot, '工作区', '账本推进.md'))).toBe(false)
  })

  it('self-heal 空闲 → rewrite_chapter 正常放行（闸不误伤）', { timeout: 15_000 }, async () => {
    const events = await runConfirmedToolChat([
      { type: 'tool', name: 'rewrite_chapter', input: { chapter: 1, instruction: '压缩' } },
      { type: 'text', content: '改写后的全文内容。' },
      { type: 'text', content: '改完了。' },
    ])
    expect(JSON.stringify(events)).not.toContain('无法同时改写')
    // 放行后真实走到嵌套生成：spill 产物存在
    expect(existsSync(join(bookRoot, '工作区', 'spills'))).toBe(true)
  })

  it('M-2（第八轮）：spawn 手动写稿运行中 → rewrite_chapter 同样被闸', { timeout: 15_000 }, async () => {
    vi.mocked(isSpawnRunning).mockReturnValue(true)
    try {
      const events = await runConfirmedToolChat([
        { type: 'tool', name: 'rewrite_chapter', input: { chapter: 1, instruction: '压缩' } },
        { type: 'text', content: '知道了。' },
      ])
      expect(JSON.stringify(events)).toContain('无法同时改写')
      expect(existsSync(join(bookRoot, '工作区', 'spills'))).toBe(false)
    } finally {
      vi.mocked(isSpawnRunning).mockReturnValue(false)
    }
  })
})

// ── 低-2（第十轮）：chat 侧改写与 studio /rewrite 端点共闸互斥 ──
// 修复背景：端点侧有 task-gate 'rewrite'（RB-SV-P2-2），chat 工具侧的
// rewrite_chapter/rewrite_selection 不查不拿——AI 改写与编辑器端点改写并发时
// 基于同一基线各产一份全文，后写赢先写（端点 rewritten 进编辑器、chat 侧
// spill→apply_spill 落盘，两条确认通道互不知晓对方已改基线）。

describe('低-2（第十轮）：chat 改写工具与 /rewrite 端点 task-gate 互斥', () => {
  it('端点 rewrite 闸在途 → chat 侧 rewrite_chapter 被拒（fail-closed 给可读 summary）', { timeout: 15_000 }, async () => {
    const release = acquireTaskGate('ai-gen-gate', 'rewrite')
    expect(release).not.toBeNull()
    try {
      const events = await runConfirmedToolChat([
        { type: 'tool', name: 'rewrite_chapter', input: { chapter: 1, instruction: '压缩' } },
        { type: 'text', content: '知道了。' },
      ])
      const result = events.find((e) => e.type === 'chat_tool_result') as { summary?: string } | undefined
      expect(result?.summary).toContain('正在改写')
      // 未发生嵌套改写：无 spill 产物
      expect(existsSync(join(bookRoot, '工作区', 'spills'))).toBe(false)
    } finally {
      release!()
    }
    // 释放后放行（闸不残留——同书名后续用例/端点不被误伤）
    expect(isTaskGateHeld('ai-gen-gate', 'rewrite')).toBe(false)
  })

  // R69-13（十七轮）：apply_spill 并入 REWRITE_GATE_TOOLS——确认落盘通道同样写章草稿，
  // 此前只靠 sha 落盘前复验压窗（复验后 saveDraft 前的并发写仍是后写赢）。
  it('R69-13：端点 rewrite 闸在途 → chat 侧 apply_spill 同闸被拒（文案单列不误导）', { timeout: 15_000 }, async () => {
    const release = acquireTaskGate('ai-gen-gate', 'rewrite')
    expect(release).not.toBeNull()
    try {
      const events = await runConfirmedToolChat([
        { type: 'tool', name: 'apply_spill', input: { locator: '工作区/spills/不存在.md' } },
        { type: 'text', content: '知道了。' },
      ])
      const result = events.find((e) => e.type === 'chat_tool_result') as { summary?: string } | undefined
      expect(result?.summary).toContain('落盘改写稿')
      expect(result?.summary).toContain('正在改写中')
    } finally {
      release!()
    }
    expect(isTaskGateHeld('ai-gen-gate', 'rewrite')).toBe(false)
  })

  it('chat 侧改写在途 → 持有同把闸（端点/并发 chat 改写此刻 acquire 为 null）', { timeout: 15_000 }, async () => {
    const events: DriverEvent[] = []
    const driver = makeDriver(events)
    fake.setScript([
      { type: 'tool', name: 'rewrite_chapter', input: { chapter: 1, instruction: '压缩' } },
      { type: 'text', content: '改写后的全文内容。', delayMs: 300 }, // 挂住在途窗口供闸断言
      { type: 'text', content: '改完了。' },
    ])
    const chatPromise = runChat({
      driver,
      mainSession: { id: 's1', cwd: workDir, closed: false },
      userDataPath: setup(),
      bookRoot,
      bookName: 'ai-gen-gate',
      message: '执行工具',
      confirmTimeoutMs: 5000,
    })
    await waitFor(() => events.some((e) => e.type === 'chat_tool_pending'))
    const pending = events.find((e) => e.type === 'chat_tool_pending') as { callId: string } | undefined
    resolveChatConfirm('ai-gen-gate', pending!.callId, true)
    // 确认放行 → 工具执行即拿闸；改写生成挂起期间闸被 chat 侧持有
    await waitFor(() => isTaskGateHeld('ai-gen-gate', 'rewrite'))
    expect(acquireTaskGate('ai-gen-gate', 'rewrite')).toBeNull() // 端点此刻重复点击会 409
    await chatPromise
    // 工具收尾释放闸（不泄漏——后续改写不被永久卡死）
    expect(isTaskGateHeld('ai-gen-gate', 'rewrite')).toBe(false)
    expect(existsSync(join(bookRoot, '工作区', 'spills'))).toBe(true)
  })
})

// ── R66-2（十四轮）：chat write_chapter 与 /rewrite 端点跨侧共闸互斥 ──
// 修复背景：write_chapter 只查 isSelfHealRunning || isSpawnRunning、不拿 task-gate
// 'rewrite'；端点反向只持自己的闸——两侧各查各的布尔，编辑器改写在途时 chat 仍可写
// 同章（self-heal 落盘 + 改写基于过期基线，双份费用且冲突来源不可辨）。修复后
// write_chapter 全程持有同一把 'rewrite' 闸：一侧持闸另一侧 acquire 即 null。

describe('R66-2: write_chapter 与 /rewrite 端点 task-gate 跨侧互斥', () => {
  it('端点 rewrite 闸在途 → chat 侧 write_chapter 被拒（fail-closed，未触发 self-heal）', { timeout: 15_000 }, async () => {
    vi.mocked(runSelfHeal).mockClear()
    const release = acquireTaskGate('ai-gen-gate', 'rewrite') // 模拟编辑器 /rewrite 端点持闸在途
    expect(release).not.toBeNull()
    try {
      const events = await runConfirmedToolChat([
        { type: 'tool', name: 'write_chapter', input: { chapter: 1 } },
        { type: 'text', content: '知道了。' },
      ])
      const result = events.find((e) => e.type === 'chat_tool_result') as { ok?: boolean; summary?: string } | undefined
      // 拒绝原因说清另一侧在改稿（AI 据此告知作者，而非误判失败重试）
      expect(result?.ok).toBe(false)
      expect(result?.summary).toContain('正在改写')
      // fail-closed：闸被占即未起 self-heal（无写章副作用）
      expect(runSelfHeal).not.toHaveBeenCalled()
    } finally {
      release!()
    }
    // 释放后不残留（同书名后续写章/改写不被永久误伤）
    expect(isTaskGateHeld('ai-gen-gate', 'rewrite')).toBe(false)
  })

  it('chat 侧 write_chapter 在途 → 持有同把闸（端点此刻 acquire 为 null → 409；收尾释放）', { timeout: 15_000 }, async () => {
    vi.mocked(runSelfHeal).mockClear()
    // self-heal 挂起在途窗口：确认放行后 write_chapter 拿闸并进入 self-heal，手动 resolve 收尾
    let resolveHeal!: (r: SelfHealOutcome) => void
    vi.mocked(runSelfHeal).mockImplementation(
      () => new Promise<SelfHealOutcome>((res) => { resolveHeal = res }),
    )
    const events: DriverEvent[] = []
    const driver = makeDriver(events)
    fake.setScript([
      { type: 'tool', name: 'write_chapter', input: { chapter: 1 } },
      { type: 'text', content: '写好了。' },
    ])
    const chatPromise = runChat({
      driver,
      mainSession: { id: 's1', cwd: workDir, closed: false },
      userDataPath: setup(),
      bookRoot,
      bookName: 'ai-gen-gate',
      message: '执行工具',
      confirmTimeoutMs: 5000,
    })
    await waitFor(() => events.some((e) => e.type === 'chat_tool_pending'))
    const pending = events.find((e) => e.type === 'chat_tool_pending') as { callId: string } | undefined
    resolveChatConfirm('ai-gen-gate', pending!.callId, true)
    // 确认放行 → write_chapter 执行即拿闸；self-heal 挂起期间闸被 chat 侧持有
    await waitFor(() => isTaskGateHeld('ai-gen-gate', 'rewrite'))
    expect(runSelfHeal).toHaveBeenCalledTimes(1)
    // 反向对称：此刻编辑器 /rewrite 端点 acquireTaskGate 得 null（端点回 409 BUSY）
    expect(acquireTaskGate('ai-gen-gate', 'rewrite')).toBeNull()
    resolveHeal({ outcome: 'pass', chapter: 1, docId: 'doc-1', path: '工作区/草稿-1.md', attempts: 1, yellows: [] })
    await chatPromise
    // 工具收尾释放闸（不泄漏——端点/后续写章不被永久卡死）
    expect(isTaskGateHeld('ai-gen-gate', 'rewrite')).toBe(false)
    const result = events.find((e) => e.type === 'chat_tool_result') as { ok?: boolean; summary?: string } | undefined
    expect(result?.ok).toBe(true)
    expect(result?.summary).toContain('第1章已生成')
  })
})
