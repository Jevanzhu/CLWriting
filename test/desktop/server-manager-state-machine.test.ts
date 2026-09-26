/**
 * R0916-7-P3-17（2026-09-25 全项目源码质量与优雅度评审 P3-17）：server-manager 显式
 * 状态机专项回归——转移矩阵（合法/非法单元逐格）+ 转移轨迹（deps.onTransition 观测）
 * + 原有场景回归的状态机口径（启动失败退避 / 连续崩溃封顶 / 停止幂等 / 重启打断在途
 * 启动）。
 *
 * 分层（CLAUDE.md 测试分层）：行为面（fork 参数、握手、端口钉住、kill 升级）仍由
 * server-manager*.test.ts 各件覆盖，本件只补「表契约 + 转移序列」两层断言，不重复
 * 行为断言；假件与装置复用 ./server-manager-fixtures.js（无 vi.mock 依赖注入款）。
 *
 * 相位派生口径（与源码 phaseOf 同源）：在途轮 > 挂起重启 > 当值 child > 空闲——故
 * 「为先」的读数是 child/round/timer 三载荷，本件断言用 `事件:前置相位/停机面->目标`。
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { isLegalTransition, createStudioServerManager } from '../../src/desktop/server-manager.js'
import type {
  ManagerEvent,
  ManagerPhase,
  ServerManagerDeps,
  StopMode,
  TransitionTrace,
} from '../../src/desktop/server-manager.js'
import {
  mkHarness,
  mkUserData,
  mkLogCapture,
  flushMicrotasks,
  cleanupServerManagerTmpDirs,
} from './server-manager-fixtures.js'
import type { ForkRecord } from './server-manager-fixtures.js'

const PHASES: readonly ManagerPhase[] = ['idle', 'starting', 'running', 'backoff']
const STOPS: readonly StopMode[] = ['none', 'marked', 'shutting']

/** 转移轨迹装置：mkHarness + onTransition 记录（缺省无操作钩子在此接线） */
function mkTraceHarness(extra: ServerManagerDeps = {}): {
  forkRecords: ForkRecord[]
  manager: ReturnType<typeof createStudioServerManager>
  traces: TransitionTrace[]
} {
  const traces: TransitionTrace[] = []
  const h = mkHarness({ ...extra, onTransition: (t) => traces.push(t) })
  return { ...h, traces }
}

/** 轨迹压缩成可断言串：`[!]事件:前置相位/停机面->目标相位/停机面`（! = 非法被拒） */
function traceLines(traces: TransitionTrace[]): string[] {
  return traces.map((t) => `${t.legal ? '' : '!'}${t.event}:${t.from.phase}/${t.from.stop}->${t.to.phase}/${t.to.stop}`)
}

/** 起一个 child 并完成握手（fork 在 start 调用内同步发生，取件须在 start 之后） */
async function bootAt(
  manager: ReturnType<typeof createStudioServerManager>,
  forkRecords: ForkRecord[],
  port: number,
): Promise<void> {
  const p = manager.start({ workDir: '/w', userDataPath: mkUserData() })
  const rec = forkRecords.at(-1)
  if (!rec) throw new Error('fork 记录缺失（start 未 fork）')
  rec.child.emit('message', { type: 'ready', port })
  await p
}

describe('R0916-7-P3-17: 转移表契约（合法/非法单元逐格）', () => {
  /** 表契约字面：事件 × 合法相位集 × 合法停机面集——未列组合一律非法 */
  const LEGAL_CELLS: ReadonlyArray<readonly [ManagerEvent, readonly ManagerPhase[], readonly StopMode[]]> = [
    ['round-open', ['idle', 'running', 'backoff'], STOPS],
    ['round-close', ['starting'], STOPS],
    ['child-up', ['starting'], STOPS],
    ['child-down', ['running', 'starting'], STOPS],
    ['backoff-arm', ['idle', 'starting', 'running'], ['none']],
    ['backoff-cancel', PHASES, STOPS],
    ['backoff-fire', ['backoff', 'starting'], STOPS],
    ['stop-mark', PHASES, STOPS],
    ['stop-clear', PHASES, ['none', 'marked']],
    ['shutdown-open', PHASES, ['none', 'marked']],
    ['shutdown-close', PHASES, ['shutting']],
  ]

  it('11 事件 × 4 相位 × 3 停机面 = 132 格逐格核对（表外组合即非法）', () => {
    const legal = new Set<string>()
    for (const [ev, phases, stops] of LEGAL_CELLS) {
      for (const p of phases) {
        for (const s of stops) legal.add(`${ev}|${p}|${s}`)
      }
    }
    const events = LEGAL_CELLS.map(([ev]) => ev)
    expect(new Set(events).size).toBe(11) // 事件面穷尽（新增事件必补本表）
    let checked = 0
    for (const ev of events) {
      for (const p of PHASES) {
        for (const s of STOPS) {
          expect(isLegalTransition(ev, p, s), `${ev} @ ${p}/${s}`).toBe(legal.has(`${ev}|${p}|${s}`))
          checked++
        }
      }
    }
    expect(checked).toBe(11 * 4 * 3)
  })

  it('关键非法单元逐条：双开轮 / 非轮内收口与接管 / 停机面已置位排程 / 流程内复位与重开门', () => {
    // 双开轮（X-3：在途轮已占，复用/E-9a 在入口拦下）
    expect(isLegalTransition('round-open', 'starting', 'none')).toBe(false)
    // 收口/接管只在轮内
    expect(isLegalTransition('round-close', 'running', 'none')).toBe(false)
    expect(isLegalTransition('round-close', 'idle', 'marked')).toBe(false)
    expect(isLegalTransition('round-close', 'backoff', 'none')).toBe(false)
    expect(isLegalTransition('child-up', 'idle', 'none')).toBe(false)
    expect(isLegalTransition('child-up', 'running', 'none')).toBe(false)
    expect(isLegalTransition('child-up', 'backoff', 'none')).toBe(false)
    expect(isLegalTransition('child-down', 'idle', 'none')).toBe(false)
    expect(isLegalTransition('child-down', 'backoff', 'none')).toBe(false)
    // 排程：已有挂起重启不双排 / 停机面置位不排（S-5）
    expect(isLegalTransition('backoff-arm', 'backoff', 'none')).toBe(false)
    expect(isLegalTransition('backoff-arm', 'idle', 'marked')).toBe(false)
    expect(isLegalTransition('backoff-arm', 'idle', 'shutting')).toBe(false)
    // 到点：只可能来自 backoff（或 0ms 退避与轮收口同拍的 starting）
    expect(isLegalTransition('backoff-fire', 'idle', 'none')).toBe(false)
    expect(isLegalTransition('backoff-fire', 'running', 'none')).toBe(false)
    // 流程内复位（S1/重评-P3-8：「shutdown 开始后绝不 fork 出存活 child」的挡板）
    expect(isLegalTransition('stop-clear', 'idle', 'shutting')).toBe(false)
    expect(isLegalTransition('stop-clear', 'running', 'shutting')).toBe(false)
    expect(isLegalTransition('stop-clear', 'starting', 'shutting')).toBe(false)
    // 流程双开（shutdown 入口幂等 early-return 之后的兜底）
    expect(isLegalTransition('shutdown-open', 'idle', 'shutting')).toBe(false)
    expect(isLegalTransition('shutdown-close', 'idle', 'marked')).toBe(false)
    expect(isLegalTransition('shutdown-close', 'running', 'none')).toBe(false)
  })
})

describe('R0916-7-P3-17: 转移轨迹（合法转移逐条走真码）', () => {
  it('首启：round-open(stop-clear)→child-up→round-close 全链合法，终态 running/none', async () => {
    const { forkRecords, manager, traces } = mkTraceHarness()
    await bootAt(manager, forkRecords, 47000)
    // 中间两步（backoff-cancel 无定时器 / stop-clear 无标记）是合法 no-op：状态不变但留痕
    expect(traceLines(traces)).toEqual([
      'round-open:idle/none->starting/none',
      'backoff-cancel:starting/none->starting/none',
      'stop-clear:starting/none->starting/none',
      'child-up:starting/none->starting/none',
      'round-close:starting/none->running/none',
    ])
    expect(traces.every((t) => t.legal)).toBe(true)
    expect(manager.isRunning()).toBe(true)
    await manager.stopChild()
  })

  it('崩溃退避：child-down 回 idle → backoff-arm 进 backoff（hasPendingRestart 同源）', async () => {
    const { forkRecords, manager, traces } = mkTraceHarness({ backoffMs: [50, 50, 50] })
    await bootAt(manager, forkRecords, 47001)
    traces.length = 0
    forkRecords[0]!.child.emit('exit', 1)
    await vi.waitFor(() => expect(manager.hasPendingRestart()).toBe(true), { timeout: 300 })
    expect(traceLines(traces)).toEqual(['child-down:running/none->idle/none', 'backoff-arm:idle/none->backoff/none'])
    expect(manager.isRunning()).toBe(false) // 当值位空、挂起重启在途（相位读数与两读数一致）
    await manager.stopChild()
  })

  it('退避到点→钉住端口重启→接管：backoff-fire 摘定时器，终态 running', async () => {
    const { forkRecords, manager, traces } = mkTraceHarness({ backoffMs: [10, 20, 30] })
    await bootAt(manager, forkRecords, 47002)
    forkRecords[0]!.child.emit('exit', 1)
    await vi.waitFor(() => expect(forkRecords.length).toBe(2), { timeout: 300 })
    traces.length = 0
    forkRecords[1]!.child.emit('message', { type: 'ready', port: 47002 })
    await vi.waitFor(() => expect(manager.isRunning()).toBe(true), { timeout: 300 })
    expect(traceLines(traces)).toEqual([
      'child-up:starting/none->starting/none',
      'round-close:starting/none->running/none',
    ])
    expect(manager.hasPendingRestart()).toBe(false)
    await manager.stopChild()
  })

  it('停机：shutdown-open→…→shutdown-close（终态 stop=marked，主动 kill 标记保留）', async () => {
    const { forkRecords, manager, traces } = mkTraceHarness({ shutdownTotalMs: 200, killWaitMs: 50 })
    await bootAt(manager, forkRecords, 47003)
    traces.length = 0
    const shutting = manager.shutdown()
    const child = forkRecords[0]!.child
    child.emit('message', { type: 'shutdown-done' })
    child.emit('exit', 0)
    await shutting
    expect(traceLines(traces)).toEqual([
      'shutdown-open:running/none->running/shutting',
      'child-down:running/shutting->idle/shutting',
      'backoff-cancel:idle/shutting->idle/shutting',
      'shutdown-close:idle/shutting->idle/marked',
    ])
    expect(traces.every((t) => t.legal)).toBe(true)
  })

  it('停止幂等：二次 shutdown/stopChild 零指令下发、零状态变化（步数不等于状态变化）', async () => {
    const { forkRecords, manager, traces } = mkTraceHarness({ shutdownTotalMs: 200, killWaitMs: 50 })
    await bootAt(manager, forkRecords, 47004)
    const child = forkRecords[0]!.child
    const shutting = manager.shutdown()
    child.emit('message', { type: 'shutdown-done' })
    child.emit('exit', 0)
    await shutting
    const posted = child.posted.length
    const tail = traces.at(-1)!.to
    traces.length = 0
    await manager.shutdown() // 二次：流程门未置位，但无当值 child → 无指令
    expect(child.posted.length).toBe(posted)
    expect(traces.at(-1)!.to).toEqual(tail) // 状态等值往返（idle/marked）
    traces.length = 0
    await manager.stopChild() // 空态直通
    expect(child.posted.length).toBe(posted)
    expect(traces.at(-1)!.to).toEqual(tail)
    expect(traces.every((t) => t.legal)).toBe(true)
  })

  it('killNow：退避窗内同步作废挂起重启并置标记（backoff→idle/marked）', async () => {
    const { forkRecords, manager, traces } = mkTraceHarness({ backoffMs: [999_000, 999_000, 999_000] })
    await bootAt(manager, forkRecords, 47005)
    forkRecords[0]!.child.emit('exit', 1)
    await vi.waitFor(() => expect(manager.hasPendingRestart()).toBe(true), { timeout: 300 })
    traces.length = 0
    manager.killNow()
    expect(traceLines(traces)).toEqual(['backoff-cancel:backoff/none->idle/none', 'stop-mark:idle/none->idle/marked'])
    expect(manager.hasPendingRestart()).toBe(false)
  })
})

describe('R0916-7-P3-17: 原有场景回归（状态机口径）', () => {
  it('启动失败退避：重启轮握手失败续排发生在「轮未收口」的 starting（表内合法单元），端口与轮次不变', async () => {
    const { forkRecords, manager, traces } = mkTraceHarness({ backoffMs: [10, 20, 30] })
    await bootAt(manager, forkRecords, 47006)
    forkRecords[0]!.child.emit('exit', 1)
    await vi.waitFor(() => expect(forkRecords.length).toBe(2), { timeout: 300 })
    expect(forkRecords[1]!.args).toContain('47006') // 钉住端口（S-1 同源）
    traces.length = 0
    // 重启轮握手失败（钉住端口残留 EADDRINUSE 形态）→ 按退避继续
    forkRecords[1]!.child.emit('message', { type: 'boot-error', code: 'EADDRINUSE', message: 'x' })
    await vi.waitFor(() => expect(forkRecords.length).toBe(3), { timeout: 300 })
    // 续排发生在「轮未收口」的 starting（相位读数留在途轮优先 → arm 后仍读 starting），
    // 收口后才落回 backoff，再到点开下一轮：全程无非法转移
    expect(traceLines(traces)).toEqual([
      'backoff-arm:starting/none->starting/none',
      'round-close:starting/none->backoff/none',
      'backoff-fire:backoff/none->idle/none',
      'backoff-cancel:idle/none->idle/none',
      'round-open:idle/none->starting/none',
    ])
    forkRecords[2]!.child.emit('message', { type: 'ready', port: 47006 })
    await vi.waitFor(() => expect(manager.isRunning()).toBe(true), { timeout: 300 })
    expect(traces.every((t) => t.legal)).toBe(true)
    await manager.stopChild()
  })

  it('连续崩溃封顶：backoff-arm 恰好 3 次；第 4 次崩溃只 child-down、不再排程（转决断）', async () => {
    let exhausted = 0
    const { forkRecords, manager, traces } = mkTraceHarness({
      backoffMs: [5, 5, 5],
      onRestartExhausted: () => {
        exhausted++
        return 'quit'
      },
    })
    await bootAt(manager, forkRecords, 47007)
    for (let i = 0; i < 4; i++) {
      const rec = forkRecords.at(-1)
      if (!rec) throw new Error('fork 记录缺失')
      rec.child.emit('exit', 1)
      if (i < 3) {
        await vi.waitFor(() => expect(forkRecords.length).toBe(i + 2), { timeout: 300 })
        forkRecords.at(-1)!.child.emit('message', { type: 'ready', port: 47007 })
        await vi.waitFor(() => expect(manager.isRunning()).toBe(true), { timeout: 300 })
      }
    }
    await vi.waitFor(() => expect(exhausted).toBe(1), { timeout: 300 })
    expect(traces.filter((t) => t.event === 'backoff-arm')).toHaveLength(3) // 封顶：第 4 次不再排程
    expect(traces.at(-1)!.event).toBe('child-down')
    expect(manager.hasPendingRestart()).toBe(false)
    expect(manager.isRunning()).toBe(false)
    expect(traces.every((t) => t.legal)).toBe(true)
  })

  it('重启打断在途启动（X-3）：同参数复用在途轮零转移；参数不一致 fail-closed 拒绝零转移', async () => {
    const { forkRecords, manager, traces } = mkTraceHarness({ backoffMs: [0, 5000, 15000] })
    const ud = mkUserData()
    const p1 = manager.start({ workDir: '/w', userDataPath: ud })
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 47008 })
    await p1
    forkRecords[0]!.child.emit('exit', 1) // 崩溃 → 0ms 退避重启
    await vi.waitFor(() => expect(forkRecords.length).toBe(2), { timeout: 300 })
    const n = traces.length // 此刻在途重启轮的 round-open 已落位（phase=starting）
    const p2 = manager.start({ workDir: '/w', userDataPath: ud })
    expect(traces.length).toBe(n) // 复用在途轮：不转移（不双开）
    await expect(manager.start({ workDir: '/other', userDataPath: ud })).rejects.toThrow(/不一致/)
    expect(traces.length).toBe(n) // 拒绝复用：同样不转移
    forkRecords[1]!.child.emit('message', { type: 'ready', port: 47008 })
    await expect(p2).resolves.toBe(47008)
    await flushMicrotasks()
    expect(forkRecords.length).toBe(2) // 全程仅首启 + 重启两次 fork
    expect(traces.every((t) => t.legal)).toBe(true)
    await manager.stopChild()
  })
})

describe('R0916-7-P3-17: 非法转移被拒（唯一可达路径：换轮清旧窗内并发停机）', () => {
  it('停机流程在途时的 stop-clear → error 留痕 + 状态不变（门保持置位）+ 新 child 仍被杀', async () => {
    const cap = mkLogCapture()
    const { forkRecords, manager, traces } = mkTraceHarness({
      logger: cap.logger,
      shutdownSettleBudgetMs: 5_000,
      shutdownTotalMs: 5_000,
      killWaitMs: 200,
    })
    const ud = mkUserData()
    const first = manager.start({ workDir: '/w', userDataPath: ud })
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 47009 })
    await first
    // 换轮 start：旧 child 已 kill、停在等退出窗（轮在途且当值 child 仍在）
    const second = manager.start({ workDir: '/w2', userDataPath: ud })
    expect(forkRecords).toHaveLength(1)
    // 并发 shutdown 恰落窗内：停机面 → 'shutting'
    const shuttingDown = manager.shutdown()
    forkRecords[0]!.child.emit('exit', 0)
    await expect(second).rejects.toThrow(/停机指令/) // 复位被拒 → fork 后检查照旧即杀
    expect(forkRecords[1]!.child.killed).toBeGreaterThanOrEqual(1)
    expect(manager.isRunning()).toBe(false)
    // 转移面：非法尝试一条，且状态不变（to === from）
    const illegal = traces.filter((t) => !t.legal)
    expect(illegal).toHaveLength(1)
    expect(illegal[0]!.event).toBe('stop-clear')
    expect(illegal[0]!.from).toEqual({ phase: 'starting', stop: 'shutting' })
    expect(illegal[0]!.to).toEqual(illegal[0]!.from)
    // 留痕：error 一条，指明被拒与状态不变（不静默）
    const hits = cap.lines.filter((l) => l.level === 'error' && l.msg.includes('状态机非法转移已拒绝'))
    expect(hits).toHaveLength(1)
    expect(hits[0]!.msg).toContain('stop-clear')
    await expect(shuttingDown).resolves.toBeUndefined()
    expect(traces.filter((t) => !t.legal)).toHaveLength(1) // 全程仅此一处
  })
})

afterAll(() => {
  cleanupServerManagerTmpDirs()
})
