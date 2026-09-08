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
