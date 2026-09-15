/**
 * R0916-5b（2026-09-16）：server-manager.test.ts（1430 行）按 describe 域拆分件之一——
 * 「崩溃退避自动重启域」（批 U3 U-2/S-1/S-5/S-9：异常退出自动重启钉住端口/同 token、
 * 退避序列与封顶回调 quit/restart、R0912-A-P3-4 封顶决断 reject 兜底、S-9 稳定窗口
 * 计数清零、退避窗内 shutdown/显式 start 作废挂起重启、P3 hasPendingRestart、X-3
 * 重启在途窗口并发 start 三守卫；重评2-P3-① restartPinned 复用在途 start 失败不
 * 逃逸 reject）。用例自原文件 791-1038、1286-1317 行整块原样搬移（describe/test
 * 名称、断言、mock 行为零变化）；共享假件与装置见 ./server-manager-fixtures.js。
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { createStudioServerManager, ServerBootError } from '../../src/desktop/server-manager.js'
import { sleep } from '../helpers/wait-for.js'
import {
  mkHarness,
  mkUserData,
  mkLogCapture,
  flushMicrotasks,
  argValue,
  envToken,
  cleanupServerManagerTmpDirs,
} from './server-manager-fixtures.js'
import type { ForkRecord } from './server-manager-fixtures.js'

describe('批 U3：崩溃退避自动重启（U-2/S-1/S-5/S-9）', () => {

  /** 重审-18（2026-09-07 全量代码重审 §四.18）：墙钟越过危险窗的轮询等待——定长
   *  sleep 与真实定时竞速（慢机/事件循环停滞下排程定时迟到即漏检）；小步 poll 持续
   *  让出事件循环，迟到的定时一到期即被处理。since = 危险窗起点（崩溃/排程时刻），
   *  越过 windowMs 后由调用方断言——forkRecords 只增不减，窗内任何时刻落地的多余
   *  fork 都会被终检抓到（语义不弱化）；deadline 5s 到点未越窗即红（防假绿）。 */
  function elapseBeyond(since: number, windowMs: number): Promise<void> {
    return vi.waitFor(() => expect(Date.now() - since).toBeGreaterThanOrEqual(windowMs), { timeout: 5_000, interval: 10 })
  }

  /** 起一个 child 并完成握手（fork 在 start 调用内同步发生，取件须在 start 之后） */
  async function bootAt(
    manager: ReturnType<typeof createStudioServerManager>,
    forkRecords: ForkRecord[],
    port: number,
  ): Promise<void> {
    const p = manager.start({ workDir: '/w', userDataPath: mkUserData() })
    forkRecords[0]!.child.emit('message', { type: 'ready', port })
    await p
  }

  it('异常退出 → 自动重启：钉住原端口（S-1）+ 同 token + 原参数面复刻', async () => {
    const { forkRecords, manager } = mkHarness({ backoffMs: [0, 5000, 15000] })
    await bootAt(manager, forkRecords, 45100)
    const token1 = envToken(forkRecords[0]!)
    // 模拟崩溃（非 kill——exit 事件直接到达）
    forkRecords[0]!.child.emit('exit', 1)
    await vi.waitFor(() => expect(forkRecords.length).toBe(2), { timeout: 300 })
    const rec2 = forkRecords[1]!
    expect(argValue(rec2.args, '--port')).toBe('45100') // 钉住原端口，非 '0'
    expect(envToken(rec2)).toBe(token1) // 同一内存 token
    expect(argValue(rec2.args, '--dir')).toBe('/w')
    rec2.child.emit('message', { type: 'ready', port: 45100 })
    await flushMicrotasks()
    expect(manager.isRunning()).toBe(true)
  })

  it('S-5：shutdown / stopChild 主动停机后的 exit 不触发重启（封 fork 数锚定）', async () => {
    // shutdown 路径
    {
      const { forkRecords, manager } = mkHarness({ backoffMs: [0, 5000, 15000], killWaitMs: 20 })
      await bootAt(manager, forkRecords, 1)
      const child = forkRecords[0]!.child
      const shutting = manager.shutdown()
      await flushMicrotasks(1)
      child.emit('message', { type: 'shutdown-done' })
      child.emit('exit', 0)
      await shutting
      await sleep(40) // backoff[0]=0：若门失效，新 fork 早已出现
      expect(forkRecords.length).toBe(1)
    }
    // stopChild 路径
    {
      const { forkRecords, manager } = mkHarness({ backoffMs: [0, 5000, 15000] })
      await bootAt(manager, forkRecords, 2)
      await manager.stopChild() // kill → exit（主动）
      await sleep(40)
      expect(forkRecords.length).toBe(1)
    }
  })

  it('退避序列 10/20/30ms 三次自动重启，第 4 次崩溃转封顶回调（quit 不再重启）', async () => {
    let exhausted = 0
    const { forkRecords, manager } = mkHarness({
      backoffMs: [10, 20, 30],
      onRestartExhausted: () => {
        exhausted++
        return 'quit'
      },
    })
    await bootAt(manager, forkRecords, 1)
    for (let i = 0; i < 4; i++) {
      forkRecords[i]!.child.emit('exit', 1)
      if (i < 3) {
        await vi.waitFor(() => expect(forkRecords.length).toBe(i + 2), { timeout: 300 })
        forkRecords[i + 1]!.child.emit('message', { type: 'ready', port: 1 })
        await flushMicrotasks()
      }
    }
    await vi.waitFor(() => expect(exhausted).toBe(1), { timeout: 300 })
    await sleep(80) // 若封顶失效会继续 fork
    expect(forkRecords.length).toBe(4) // 首启 1 + 自动重启 3，无第 5 次
  })

  it('封顶回调选 restart：计数清零立即开新周期', async () => {
    let exhausted = 0
    const { forkRecords, manager } = mkHarness({
      backoffMs: [10, 20, 30],
      onRestartExhausted: () => {
        exhausted++
        return 'restart'
      },
    })
    await bootAt(manager, forkRecords, 1)
    for (let i = 0; i < 4; i++) {
      forkRecords[i]!.child.emit('exit', 1)
      await vi.waitFor(() => expect(forkRecords.length).toBe(i + 2), { timeout: 300 })
      forkRecords[i + 1]!.child.emit('message', { type: 'ready', port: 1 })
      await flushMicrotasks()
    }
    expect(exhausted).toBe(1)
    // 第 4 次崩溃后封顶 → restart 决断 → 新周期第 1 次重启（fork#5）
    await vi.waitFor(() => expect(forkRecords.length).toBe(5), { timeout: 300 })
  })

  // R0912-A-P3-4（2026-09-12 独立重评修复批）：异步决断 reject（对话框链异常等）此前
  // 无接手 → unhandledRejection。修复后 catch 记 error 日志并按兜底 quit 语义收口
  //（不再自动重启）；无第 5 次 fork、无未处理拒绝外溢。
  it('R0912-A-P3-4：封顶决断回调 reject → error 留痕 + 兜底不重启 + 无未处理拒绝', async () => {
    const cap = mkLogCapture()
    const { forkRecords, manager } = mkHarness({
      backoffMs: [10, 20, 30],
      logger: cap.logger,
      onRestartExhausted: () => Promise.reject(new Error('对话框链崩了')),
    })
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      await bootAt(manager, forkRecords, 1)
      for (let i = 0; i < 4; i++) {
        forkRecords[i]!.child.emit('exit', 1)
        if (i < 3) {
          await vi.waitFor(() => expect(forkRecords.length).toBe(i + 2), { timeout: 300 })
          forkRecords[i + 1]!.child.emit('message', { type: 'ready', port: 1 })
          await flushMicrotasks()
        }
      }
      await vi.waitFor(
        () => expect(cap.lines.some((l) => l.level === 'error' && l.msg.includes('崩溃封顶决断回调失败'))).toBe(true),
        { timeout: 300 },
      )
      await sleep(80)
      expect(forkRecords.length).toBe(4) // 兜底 quit 语义：封顶后无第 5 次 fork
      await new Promise((r) => setTimeout(r, 30)) // 给潜在未处理拒绝一个落地窗
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      await manager.stopChild() // 显式收口（无 active 直通），不留挂起重启外溢
    }
  })

  it('S-9：ready 后稳定过窗口计数清零——后续崩溃回退避第 1 档而非第 2 档', async () => {
    // backoff[1]=2000ms：若计数未清零，第二次崩溃后的重启要等 2s（用例 1000ms 内必超时）
    const { forkRecords, manager } = mkHarness({ backoffMs: [10, 2000, 3000], stabilityResetMs: 40 })
    await bootAt(manager, forkRecords, 1)
    forkRecords[0]!.child.emit('exit', 1)
    await vi.waitFor(() => expect(forkRecords.length).toBe(2), { timeout: 300 })
    forkRecords[1]!.child.emit('message', { type: 'ready', port: 1 })
    await flushMicrotasks()
    // R63-16：80ms 是「越过 40ms 稳定窗口」的下界等待——停顿只会更稳（定时器不早
    // 触发），无需加宽；判别力在下方 waitFor：预期 10ms 档重启，若误用第 2 档
    // 2000ms 则 1000ms 内必红（原 300ms 停顿余量薄，放至 1000ms 仍保有判别）
    await sleep(80) // 稳定窗口 40ms 已过（child 存活）
    forkRecords[1]!.child.emit('exit', 1) // 计数已清零 → 仍按第 1 档 10ms 重启
    await vi.waitFor(() => expect(forkRecords.length).toBe(3), { timeout: 1000 })
  })

  it('退避等待窗口内 shutdown：挂起重启作废（退出途中不 fork 孤儿）', async () => {
    const { forkRecords, manager } = mkHarness({ backoffMs: [80, 80, 80] })
    await bootAt(manager, forkRecords, 1)
    const crashAt = Date.now() // 危险窗起点：挂起重启自此 80ms 后触发
    forkRecords[0]!.child.emit('exit', 1)
    await flushMicrotasks(2) // 排程已挂（80ms 后）
    await manager.shutdown() // active 已空：置门 + 取消挂起重启直通
    // 重审-18（2026-09-07 全量代码重审 §四.18）：原 sleep(200) 定长越过 80ms 退避窗
    // ——改轮询越过危险窗；若作废失效，窗内 fork 会被终检抓到
    await elapseBeyond(crashAt, 200)
    expect(forkRecords.length).toBe(1)
  })

  it('重启握手失败（boot-error/EADDRINUSE 残留）按退避继续', async () => {
    const { forkRecords, manager } = mkHarness({ backoffMs: [10, 20, 30] })
    await bootAt(manager, forkRecords, 1)
    forkRecords[0]!.child.emit('exit', 1)
    await vi.waitFor(() => expect(forkRecords.length).toBe(2), { timeout: 300 })
    // 重启轮握手失败：钉住端口可能仍被垂死进程占着（EADDRINUSE → boot-error）
    forkRecords[1]!.child.emit('message', { type: 'boot-error', code: 'EADDRINUSE', message: 'x' })
    await vi.waitFor(() => expect(forkRecords.length).toBe(3), { timeout: 300 }) // 按退避第 2 档继续
    forkRecords[2]!.child.emit('message', { type: 'ready', port: 1 })
    await flushMicrotasks()
    expect(manager.isRunning()).toBe(true)
  })

  it('显式 start 换轮作废挂起重启；新一轮端口回 0（非钉住）', async () => {
    const { forkRecords, manager } = mkHarness({ backoffMs: [80, 80, 80] })
    await bootAt(manager, forkRecords, 45555)
    const crashAt = Date.now() // 危险窗起点：挂起重启自此 80ms 后触发
    forkRecords[0]!.child.emit('exit', 1)
    await flushMicrotasks(2) // 挂起 80ms 重启
    const p2 = manager.start({ workDir: '/w2', userDataPath: mkUserData() })
    forkRecords[1]!.child.emit('message', { type: 'ready', port: 9 })
    await expect(p2).resolves.toBe(9)
    expect(argValue(forkRecords[1]!.args, '--port')).toBe('0') // 显式 start 永远 OS 分配
    expect(argValue(forkRecords[1]!.args, '--dir')).toBe('/w2')
    // 重审-18（2026-09-07 全量代码重审 §四.18）：原 sleep(200) 定长越过 80ms 退避窗
    // ——改轮询越过危险窗；挂起重启若未被作废，窗内 fork 会被终检抓到
    await elapseBeyond(crashAt, 200)
    expect(forkRecords.length).toBe(2)
  })

  // P3（打包修复批）：child 已崩但退避重启在途——isRunning() 为 false 而
  // hasPendingRestart() 为 true；stopChild（= legacyStopHandle.close 路径）须把
  // 挂起重启一并作废（S-5），否则 main「关旧」判据漏检、重启落地成孤儿 fork
  it('P3：挂起重启在途——hasPendingRestart 反映排程；stopChild 作废挂起重启', async () => {
    const { forkRecords, manager } = mkHarness({ backoffMs: [80, 80, 80] })
    expect(manager.hasPendingRestart()).toBe(false) // 初始无排程
    await bootAt(manager, forkRecords, 1)
    expect(manager.hasPendingRestart()).toBe(false)
    const crashAt = Date.now() // 危险窗起点：挂起重启自此 80ms 后触发
    forkRecords[0]!.child.emit('exit', 1) // 崩溃：child 没了但重启已排程（80ms 后）
    await flushMicrotasks(2)
    expect(manager.isRunning()).toBe(false) // 原判据在此返 null → 漏关漏取消
    expect(manager.hasPendingRestart()).toBe(true)
    await manager.stopChild() // 无 active child：直通但必须取消挂起重启
    expect(manager.hasPendingRestart()).toBe(false)
    // 重审-18（2026-09-07 全量代码重审 §四.18）：原 sleep(200) 定长越过 80ms 退避窗
    // ——改轮询越过危险窗；若取消失效，孤儿 fork 会被终检抓到
    await elapseBeyond(crashAt, 200)
    expect(forkRecords.length).toBe(1) // 重启未落地（无孤儿 fork）
  })

  // X-3（第五十六轮）：restartTimer 已触发、重启握手在途的窗口内 start() 三守卫
  // （starting/active/hasPendingRestart）皆空——修复前会再 fork 双 child，后完成者
  // 赢得 active、先完成者孤儿无人杀。修复后重启占 starting 通道：同参数 start 复用
  // 在途轮（含钉住端口），参数不一致沿用 E-9a fail-closed reject。
  it('X-3：重启在途窗口并发 start（同参数）→ 复用在途轮不双 fork；参数不一致 fail-closed', async () => {
    const { forkRecords, manager } = mkHarness({ backoffMs: [0, 5000, 15000] })
    const ud = mkUserData()
    const p1 = manager.start({ workDir: '/w', userDataPath: ud })
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 45300 })
    await p1
    forkRecords[0]!.child.emit('exit', 1) // 崩溃 → backoff[0]=0 立即排程重启
    await vi.waitFor(() => expect(forkRecords.length).toBe(2), { timeout: 300 })
    expect(argValue(forkRecords[1]!.args, '--port')).toBe('45300') // 重启钉住端口
    // 此刻 ready 未发（握手在途）= 三守卫皆空的窗口；并发 start 同参数必须复用在途轮
    const p2 = manager.start({ workDir: '/w', userDataPath: ud })
    await expect(manager.start({ workDir: '/other', userDataPath: ud })).rejects.toThrow(/不一致/)
    forkRecords[1]!.child.emit('message', { type: 'ready', port: 45300 })
    await expect(p2).resolves.toBe(45300) // 复用在途重启轮（钉住端口，非 OS 分配）
    await flushMicrotasks()
    expect(manager.isRunning()).toBe(true)
    expect(forkRecords.length).toBe(2) // 全程仅首启 + 重启两次 fork（无双 fork）
  })
})

// ── 重评2-P3-①（2026-09-09 全量重评 GLM-5.3）：restartPinned 复用在途 start 的
// reject 逃逸 ──
// 原实现 `if (starting) return starting` 把在途 start 的 rejection 原样透传——违反
// restartPinned「失败 resolve null」契约（其余路径均 catch 返 null），main 调用点无
// .catch 即落全局兜底日志。修复：复用值包一层 catch，失败 warn 留痕后 resolve null；
// 成功值原样透传（X-3 复用语义不变）。
describe('重评2-P3-①: restartPinned 复用在途 start 失败不逃逸 reject', () => {
  it('在途 start 握手失败（boot-error）→ restartPinned resolve null + warn 留痕（在途轮自身照常 reject）', async () => {
    const cap = mkLogCapture()
    // 大退避：start 失败后的自动重启排程不干扰断言（收尾 stopChild 一并取消）
    const { forkRecords, manager } = mkHarness({ logger: cap.logger, backoffMs: [999_000, 999_000, 999_000] })
    const ud = mkUserData()
    // 首启成功：建立钉住端口面（restartPinned 的复刻前提）
    const first = manager.start({ workDir: '/w', userDataPath: ud })
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 45200 })
    await first
    // 二次 start 在途（ready 未发）：starting 通道被占用
    const second = manager.start({ workDir: '/w', userDataPath: ud })
    await vi.waitFor(() => expect(forkRecords.length).toBe(2))
    // 自愈恢复落在在途窗口内：复用在途轮（X-3 语义）——修复前 rp 会跟着在途轮 reject
    const rp = manager.restartPinned()
    // 在途轮握手失败（boot-error 信封 reject）
    forkRecords[1]!.child.emit('message', { type: 'boot-error', code: 'EADDRINUSE', message: 'x' })
    await expect(rp).resolves.toBeNull() // 修复后：对齐「失败 resolve null」契约
    await expect(second).rejects.toBeInstanceOf(ServerBootError) // 在途轮自身 reject 语义不变
    // 失败留痕：warn 一条含「自愈恢复在途 start 失败」（reject 不静默吞没）
    const warns = cap.lines.filter((l) => l.level === 'warn' && l.msg.includes('自愈恢复在途 start 失败'))
    expect(warns).toHaveLength(1)
    // 收尾：取消失败后排程的挂起重启（timer unref 不拖 worker，显式收口保净）
    await manager.stopChild()
  })
})

afterAll(() => {
  cleanupServerManagerTmpDirs()
})
