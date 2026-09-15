/**
 * R0916-5b（2026-09-16）：server-manager.test.ts（1430 行）按 describe 域拆分件之一——
 * 「停机基础域」：stopChild 语义（L-3 换轨先 kill 旧 child / 无 child 直通 / 幂等；
 * R28-21 SIGKILL 升级前 pid 重读）+ E-1 shutdown 总超时常量锚定 + 批 U2 shutdown
 * 指令时序（回执自然退出 / 总超时强杀 / exit 先到直通 / 幂等）。用例自原文件
 * 378-463、520-589 行整块原样搬移（describe/test 名称、断言、mock 行为零变化）；
 * 共享假件与装置见 ./server-manager-fixtures.js。
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { SHUTDOWN_TOTAL_TIMEOUT_MS } from '../../src/desktop/server-manager.js'
import {
  mkHarness,
  mkUserData,
  flushMicrotasks,
  FakeChild,
  cleanupServerManagerTmpDirs,
} from './server-manager-fixtures.js'

describe('批 U1：旧 child 清理与 stopChild（L-3 换轨）', () => {
  it('start 时旧 child 在途 → 先 kill 等退出再 fork（两轮 fork 各自 ready）', async () => {
    const { forkRecords, manager } = mkHarness()
    const ud = mkUserData()
    const p1 = manager.start({ workDir: null, userDataPath: ud })
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 11 })
    await p1
    const p2 = manager.start({ workDir: null, userDataPath: ud })
    await flushMicrotasks()
    expect(forkRecords[0]!.child.killed).toBe(1) // 旧 child 已 kill
    // 新 child 各发各的 ready（S-5：每 fork 一轮握手）
    forkRecords[1]!.child.emit('message', { type: 'ready', port: 22 })
    await expect(p2).resolves.toBe(22)
    expect(manager.isRunning()).toBe(true)
    await manager.stopChild()
  })

  it('stopChild：无 child 直通；kill + 等退出；幂等', async () => {
    const { forkRecords, manager } = mkHarness()
    await expect(manager.stopChild()).resolves.toBeUndefined()
    const p = manager.start({ workDir: null, userDataPath: mkUserData() })
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 1 })
    await p
    const child = forkRecords[0]!.child
    await manager.stopChild()
    expect(child.killed).toBe(1)
    expect(manager.isRunning()).toBe(false)
    await expect(manager.stopChild()).resolves.toBeUndefined() // 幂等
  })

  // R28-21（二十八轮）：SIGKILL 升级前重读 proc.pid——killWaitMs（2s）窗内子进程已死亡
  // 且 pid 被系统复用时，按入口快照盲杀会误伤无关进程（极窄理论窗）。Electron 退出后
  // pid 置 undefined，重读 undefined = 已退出（exit 事件竞态迟到）→ 跳过升级走「超时放行」。
  describe('R28-21：SIGKILL 升级前 pid 重读', () => {
    /** SIGTERM 被吞形态的假件：kill 只计数，不派发 exit（killWaitMs 窗口内「仍活」） */
    function swallowTerm(child: FakeChild): void {
      child.kill = () => {
        child.killed++
        return true
      }
    }

    it('killWaitMs 窗内 child 已退（pid 置 undefined）→ 不升级 SIGKILL（防 pid 复用误杀无关进程）', async () => {
      const { forkRecords, manager } = mkHarness({ killWaitMs: 40 })
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      try {
        const p = manager.start({ workDir: null, userDataPath: mkUserData() })
        const child = forkRecords[0]!.child
        child.emit('message', { type: 'ready', port: 1 })
        await p
        swallowTerm(child)
        const stopping = manager.stopChild()
        // 窗口过半后模拟 Electron 语义：进程已退，pid 置 undefined（exit 事件竞态迟到）
        await new Promise((r) => setTimeout(r, 10))
        child.pid = undefined
        await expect(stopping).resolves.toBeUndefined()
        expect(killSpy).not.toHaveBeenCalled() // 修复前按入口快照 pid=4242 盲杀
        // 竞态迟到的 exit 事件补达：active 由 exit 监听清空（停机语义收口）
        child.emit('exit', 0)
        await flushMicrotasks()
        expect(manager.isRunning()).toBe(false)
      } finally {
        killSpy.mockRestore()
      }
    })

    it('对照：窗口内 pid 仍在（真挂死）→ 照常升级 SIGKILL（修复不弱化强杀兜底）', async () => {
      const { forkRecords, manager } = mkHarness({ killWaitMs: 40 })
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      try {
        const p = manager.start({ workDir: null, userDataPath: mkUserData() })
        const child = forkRecords[0]!.child
        child.emit('message', { type: 'ready', port: 1 })
        await p
        swallowTerm(child)
        const stopping = manager.stopChild()
        await new Promise((r) => setTimeout(r, 10))
        expect(child.pid).toBe(4242) // pid 未变（真挂死形态）
        await expect(stopping).resolves.toBeUndefined()
        expect(killSpy).toHaveBeenCalledWith(4242, 'SIGKILL')
      } finally {
        killSpy.mockRestore()
      }
    })
  })
})

describe('E-1：shutdown 总超时覆盖 child 最坏预算', () => {
  it('缺省总超时 ≥ 3.5s（child 侧 close 1.5s + settle 1.5s 串行 ≈3s，main 兜底不得在收尾窗口内强杀）', () => {
    // 缺省值锚定：回归到 2s 之类会重新出现「超时强杀打断 session/end 落库」
    expect(SHUTDOWN_TOTAL_TIMEOUT_MS).toBeGreaterThanOrEqual(3_500)
  })
})

describe('批 U2：shutdown 指令（§3.4 时序 4）', () => {
  // S-5 互斥门（shutdownStarted 后 exit 不触发重启）的用例随批 U3 重启逻辑落地——
  // 门在本批只置位无消费面，单独断言无可观测行为。

  it('指令下发 → shutdown-done 回执 → 自然退出：全程不 kill', async () => {
    const { forkRecords, manager } = mkHarness({ killWaitMs: 20 })
    const p = manager.start({ workDir: null, userDataPath: mkUserData() })
    const child = forkRecords[0]!.child
    child.emit('message', { type: 'ready', port: 1 })
    await p
    const shutting = manager.shutdown()
    await flushMicrotasks(1)
    expect(child.posted).toEqual([{ type: 'shutdown' }])
    // 回执到达，exit 在途（真实 child 回执后立即 exit(0)——回执与 exit 间有异步缝）
    child.emit('message', { type: 'shutdown-done' })
    child.emit('exit', 0)
    await expect(shutting).resolves.toBeUndefined()
    expect(child.killed).toBe(0)
    expect(manager.isRunning()).toBe(false)
  })

  it('child 无响应 → 总超时强杀兜底', async () => {
    const { forkRecords, manager } = mkHarness({ shutdownTotalMs: 10, killWaitMs: 20 })
    const p = manager.start({ workDir: null, userDataPath: mkUserData() })
    const child = forkRecords[0]!.child
    child.emit('message', { type: 'ready', port: 1 })
    await p
    await expect(manager.shutdown()).resolves.toBeUndefined()
    expect(child.posted).toEqual([{ type: 'shutdown' }])
    expect(child.killed).toBe(1)
    expect(manager.isRunning()).toBe(false)
  })

  it('exit 先到（无回执退出）→ 直通不强杀', async () => {
    const { forkRecords, manager } = mkHarness()
    const p = manager.start({ workDir: null, userDataPath: mkUserData() })
    const child = forkRecords[0]!.child
    child.emit('message', { type: 'ready', port: 1 })
    await p
    const shutting = manager.shutdown()
    await flushMicrotasks(1)
    child.emit('exit', 0)
    await expect(shutting).resolves.toBeUndefined()
    expect(child.killed).toBe(0)
    expect(manager.isRunning()).toBe(false)
  })

  it('无 child 直通；二次调用幂等（不再下发指令）', async () => {
    const { forkRecords, manager } = mkHarness()
    await expect(manager.shutdown()).resolves.toBeUndefined()
    const p = manager.start({ workDir: null, userDataPath: mkUserData() })
    const child = forkRecords[0]!.child
    child.emit('message', { type: 'ready', port: 1 })
    await p
    const shutting = manager.shutdown()
    await flushMicrotasks(1)
    child.emit('message', { type: 'shutdown-done' })
    child.emit('exit', 0)
    await shutting
    await expect(manager.shutdown()).resolves.toBeUndefined() // 已停机：幂等直通
    expect(child.posted).toEqual([{ type: 'shutdown' }])
  })
})

afterAll(() => {
  cleanupServerManagerTmpDirs()
})
