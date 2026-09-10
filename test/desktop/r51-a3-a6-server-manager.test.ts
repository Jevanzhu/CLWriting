/**
 * R51-A-3 / R51-A-6（五十一轮）回归（server-manager，注入假 fork 手法同
 * server-manager.test.ts）：
 * - A-3：restartPinned 作废挂起重启（与 start() 口径对称）——崩溃退避排程在途时
 *   显式恢复不再与 doRestart 竞逐双 fork（doRestart 不查 starting 直接覆写通道）。
 * - A-6：握手超时 kill 路径改经注入 killWaitMs——kill 升级等待不再钉模块常量
 *   （默认值=常量，生产行为不变；注入口径完备）。
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { createStudioServerManager } from '../../src/desktop/server-manager.js'
import type { ServerManagerDeps } from '../../src/desktop/server-manager.js'

class FakeChild extends EventEmitter {
  posted: unknown[] = []
  killed = 0
  pid: number | undefined = 4242
  postMessage(message: unknown): void {
    this.posted.push(message)
  }
  kill(): boolean {
    this.killed++
    queueMicrotask(() => this.emit('exit', 0))
    return true
  }
}

interface ForkRecord {
  args: string[]
  options: Record<string, unknown>
  child: FakeChild
}

const tmpDirs: string[] = []
function mkUserData(): string {
  const d = mkdtempTracked(join(tmpdir(), 'r51-mgr-ud-'))
  tmpDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

function mkHarness(extra: ServerManagerDeps = {}): {
  forkRecords: ForkRecord[]
  manager: ReturnType<typeof createStudioServerManager>
} {
  const forkRecords: ForkRecord[] = []
  const manager = createStudioServerManager({
    ...extra,
    fork: (_modulePath, args, options) => {
      const child = new FakeChild()
      forkRecords.push({ args, options: options as Record<string, unknown>, child })
      return child
    },
  })
  return { forkRecords, manager }
}

/** 重审-18（2026-09-07 全量代码重审 §四.18）：墙钟越过危险窗的轮询等待——定长
 *  sleep 与真实定时竞速（慢机/事件循环停滞下排程定时迟到即漏检）；小步 poll 持续
 *  让出事件循环，迟到的定时一到期即被处理。since = 危险窗起点（崩溃/排程时刻），
 *  越过 windowMs 后由调用方断言——forkRecords 只增不减，窗内任何时刻落地的多余
 *  fork 都会被终检抓到（语义不弱化）；deadline 5s 到点未越窗即红（防假绿）。 */
function elapseBeyond(since: number, windowMs: number): Promise<void> {
  return vi.waitFor(() => expect(Date.now() - since).toBeGreaterThanOrEqual(windowMs), { timeout: 5_000, interval: 10 })
}

describe('R51-A-3: restartPinned 作废挂起重启', () => {
  it('崩溃退避排程在途时 restartPinned → 挂起重启作废 + 单轮恢复（无双 fork 竞逐）', async () => {
    // 大退避：排程后 400ms 才会触发——留足「显式恢复 vs 挂起重启」竞逐观察窗
    const { forkRecords, manager } = mkHarness({ backoffMs: [400, 800, 1200] })
    const ud = mkUserData()
    const p1 = manager.start({ workDir: '/w', userDataPath: ud })
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 47000 })
    await p1
    const crashAt = Date.now() // 危险窗起点：挂起重启自此 400ms 后触发
    forkRecords[0]!.child.emit('exit', 1) // 崩溃 → 排程挂起重启（400ms 后）
    await Promise.resolve()
    expect(manager.hasPendingRestart()).toBe(true)
    // 观察窗自愈：显式恢复必须作废挂起重启（与 start 的取消面口径对称）
    const recovered = manager.restartPinned()
    expect(manager.hasPendingRestart()).toBe(false) // 修复前挂起重启仍武装
    forkRecords[1]!.child.emit('message', { type: 'ready', port: 47000 }) // 恢复轮钉住端口
    await expect(recovered).resolves.toBe(47000)
    // 重审-18（2026-09-07 全量代码重审 §四.18）：原 sleep(600) 定长越过 400ms 触发点
    // ——改轮询越过危险窗；若未作废，doRestart 在窗内再 fork 会被终检抓到
    await elapseBeyond(crashAt, 600)
    expect(forkRecords.length).toBe(2) // 首启 + 恢复，无第 3 次 fork（修复前 3）
    await manager.stopChild()
  })
})

// R1010b-DSK-P3-2（2026-09-10 内存专项重审修复批）：doRestart 在途不覆写——R51-A-3
// 收窄的另一半：restartPinned 占住 starting（自愈握手在途）时，崩溃风暴对话框
// 「重启服务」决断触发的 0ms 退避 doRestart 不得覆写通道（原实现直接覆写
// starting/startingOpts/startingProc：finally 清错通道与 fork 句柄 + 双 fork 竞逐
// active，输者孤儿）。
describe('R1010b-DSK-P3-2: doRestart 在途检查', () => {
  it('restartPinned 握手在途时封顶决断「重启」→ doRestart 复用在途轮，不覆写不双 fork', async () => {
    // 异步决断（R1010-P3 G7-② 形态）：对话框等待期由测试手动放行
    let resolveChoice!: (v: 'restart' | 'quit') => void
    const choice = new Promise<'restart' | 'quit'>((r) => {
      resolveChoice = r
    })
    let exhaustedCalls = 0
    const { forkRecords, manager } = mkHarness({
      backoffMs: [0, 0, 0], // 决断后 0ms 退避立即触发 doRestart（竞窗最大）
      onRestartExhausted: () => {
        exhaustedCalls++
        return choice
      },
    })
    const ud = mkUserData()
    const p1 = manager.start({ workDir: '/w', userDataPath: ud })
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 47100 })
    await p1
    // 崩溃 ×3：每轮 0ms 退避自动重启（重启 child 均 ready 供握手落定，doRestart 的
    // finally 清完 starting 通道再进下一轮）
    for (let i = 0; i < 3; i++) {
      forkRecords.at(-1)!.child.emit('exit', 1)
      await vi.waitFor(() => expect(forkRecords.length).toBe(i + 2), { timeout: 300 })
      forkRecords.at(-1)!.child.emit('message', { type: 'ready', port: 47100 })
      await vi.waitFor(() => expect(manager.isRunning()).toBe(true), { timeout: 300 })
      await new Promise((r) => setTimeout(r, 10)) // doRestart finally 清通道余量
    }
    expect(forkRecords.length).toBe(4) // 首启 + 3 次自动重启
    // 第 4 次崩溃 → 封顶转决断（异步对话框挂起，无 fork）
    forkRecords.at(-1)!.child.emit('exit', 1)
    await vi.waitFor(() => expect(exhaustedCalls).toBe(1), { timeout: 300 })
    expect(forkRecords.length).toBe(4)
    // 对话框等待期并发 session-end 自愈：restartPinned 占住 starting（握手挂起——不 ready）
    const recovered = manager.restartPinned()
    await vi.waitFor(() => expect(forkRecords.length).toBe(5), { timeout: 300 })
    // 决断到达：「重启服务」→ 计数清零 → 0ms 退避 doRestart——修复后复用在途轮不覆写
    resolveChoice('restart')
    await new Promise((r) => setTimeout(r, 30)) // 0ms 退避 timer + doRestart 入口充分落地
    expect(forkRecords.length).toBe(5) // 修复点：无第 6 次 fork（修复前覆写通道双 fork）
    // 在途自愈轮照常收口：钉住端口恢复
    forkRecords.at(-1)!.child.emit('message', { type: 'ready', port: 47100 })
    await expect(recovered).resolves.toBe(47100)
    await new Promise((r) => setTimeout(r, 20)) // 复用路径（doRestart 的 await）余量落地
    expect(forkRecords.length).toBe(5) // 复用而非排队：恢复轮收口后也不补 fork
    expect(manager.hasPendingRestart()).toBe(false) // doRestart 未排新轮
    await manager.stopChild()
  })
})

describe('R51-A-6: 握手超时 kill 等待可注入', () => {
  it('握手超时 kill 路径按注入 killWaitMs 升级 SIGKILL（不再钉模块常量 2s）', async () => {
    vi.useFakeTimers()
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const KILL_WAIT = 60
      const { forkRecords, manager } = mkHarness({ killWaitMs: KILL_WAIT })
      const starting = manager.start({ workDir: '/w', userDataPath: mkUserData() })
      const child = forkRecords[0]!.child
      child.kill = () => {
        child.killed++ // SIGTERM 被吞形态：不派发 exit
        return true
      }
      // 推进到握手超时（30s 兜底）→ kill + 等退出；SIGKILL 未升级（仍在注入等待窗内）
      // 先挂 rejects 断言再推进——rejectRaw 在 advance 的微任务冲刷中落定，滞后挂
      // handler 会落进 unhandledRejection 窗口（vitest 报游离拒绝）
      const failure = expect(starting).rejects.toThrow(/握手超时/)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(killSpy).not.toHaveBeenCalled()
      // 注入等待窗结束 → 升级 SIGKILL（修复前进第二等要按常量 2000ms，此处 60ms 即升级）
      await vi.advanceTimersByTimeAsync(KILL_WAIT)
      expect(killSpy).toHaveBeenCalledWith(4242, 'SIGKILL')
      // 升级后第二等按同一注入值收口 → 启动失败（HANDSHAKE_TIMEOUT）落定
      await vi.advanceTimersByTimeAsync(KILL_WAIT)
      await failure
    } finally {
      vi.useRealTimers()
      killSpy.mockRestore()
    }
  })
})
