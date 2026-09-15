/**
 * R0916-5b（2026-09-16）：server-manager.test.ts（1430 行）按 describe 域拆分件之一——
 * 「停机竞态族」：S1 停机对在途 fork 的可见性 / B-7 停机中 start 反向窗口 fail-closed
 * 拒绝 / R44-12 shutdown 短预算放弃挂起握手 / 重评-P3-8 换轮 stopActiveChild 窗口内
 * 并发 shutdown 不清停机门 / R49-4 stopChild 短预算 / R0912-3 #34 停机期在途 fork 的
 * kill 等待/升级纪律 / R0912-3 #35 killNow 同步 kill 信号。用例自原文件 1040-1233、
 * 1235-1284、1319-1426 行整块原样搬移（describe/test 名称、断言、mock 行为零变化）；
 * 共享假件与装置见 ./server-manager-fixtures.js。
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { createStudioServerManager, ServerBootError } from '../../src/desktop/server-manager.js'
import type { ServerManagerDeps } from '../../src/desktop/server-manager.js'
import { sleep } from '../helpers/wait-for.js'
import {
  mkHarness,
  mkUserData,
  mkLogCapture,
  flushMicrotasks,
  FakeChild,
  cleanupServerManagerTmpDirs,
} from './server-manager-fixtures.js'
import type { ForkRecord } from './server-manager-fixtures.js'

// ── S1（五十九轮）：shutdown/stopChild 对「握手中的在途 fork」的停机竞态 ──
// 握手窗口内 active===null，原 shutdown 只看 active → before-quit 落在该窗口时新
// child 收不到 shutdown 指令、不走优雅停机，只能硬杀。修复：先 await starting
// （catch 握手失败）再判 active；launch fork 后检查 shutdownStarted 即杀。
describe('S1: 停机对在途 fork 的可见性', () => {
  it('shutdown 落在 start 握手窗口内 → 等 ready 后对新 child 下发 shutdown 指令（优雅停机，非硬杀）', async () => {
    const { forkRecords, manager } = mkHarness({ shutdownTotalMs: 200, killWaitMs: 50 })
    const ud = mkUserData()
    const starting = manager.start({ workDir: '/w', userDataPath: ud })
    const child = forkRecords[0]!.child
    // 握手在途（ready 未发）时 before-quit 触发——原实现此处 if (!current) return 漏停
    const shuttingDown = manager.shutdown()
    child.emit('message', { type: 'ready', port: 46000 })
    await expect(starting).resolves.toBe(46000)
    // 新 child 被优雅停机链覆盖：收到 shutdown 指令
    await flushMicrotasks()
    expect(child.posted).toContainEqual({ type: 'shutdown' })
    child.emit('message', { type: 'shutdown-done' })
    child.emit('exit', 0)
    await shuttingDown
    expect(child.killed).toBe(0) // 回执路径不 kill（优雅停机语义保留）
    expect(forkRecords.length).toBe(1)
  })

  it('stopChild 落在 start 握手窗口内 → 等 ready 后 kill 新 child（不漏杀成孤儿）', async () => {
    const { forkRecords, manager } = mkHarness()
    const ud = mkUserData()
    const starting = manager.start({ workDir: '/w', userDataPath: ud })
    const child = forkRecords[0]!.child
    const stopping = manager.stopChild()
    child.emit('message', { type: 'ready', port: 46001 })
    await expect(starting).resolves.toBe(46001)
    await stopping
    expect(child.killed).toBe(1) // 新 child 被 kill（原实现 active===null 直通漏杀）
    expect(manager.isRunning()).toBe(false)
    expect(forkRecords.length).toBe(1)
  })

  it('shutdown 等待中握手失败（boot-error）→ 吞启动失败继续停机面，不挂死不炸', async () => {
    const { forkRecords, manager } = mkHarness({ shutdownTotalMs: 200 })
    const ud = mkUserData()
    const starting = manager.start({ workDir: '/w', userDataPath: ud })
    const shuttingDown = manager.shutdown()
    forkRecords[0]!.child.emit('message', { type: 'boot-error', code: 'EADDRINUSE', message: 'x' })
    await expect(starting).rejects.toThrow(ServerBootError)
    await expect(shuttingDown).resolves.toBeUndefined() // catch 握手失败，静默收口
    expect(forkRecords.length).toBe(1) // 停机门置位后无重启 fork
  })
})

// B-7（第六十轮）：停机中 start fail-closed 拒绝——S1 只覆盖「shutdown 先于 start」
// 正向时序；反向时序（shutdown 已置位并停驻等待点、starting===null）下 start 进入
// 此前会在 IIFE 首行同步复位 shutdownStarted → 新 child 在停机流程中途存活。
// 现状唯一调用链 bootstrapRunner 有守卫挡住（不可达），本修复把调用纪律变成机制。
// 语义边界：只挡停机「进行中」窗口（独立 shuttingDown 生命周期门）——shutdownStarted
// 另承载「主动 kill 标记」（stopActiveChild 置位），stopChild 后的 start 换轮仍放行。
describe('B-7: 停机中 start 反向窗口 fail-closed 拒绝', () => {
  it('shutdown 停驻等待点时 start → reject 且不 fork；收口后 start 开新生命周期', async () => {
    const { forkRecords, manager } = mkHarness({ shutdownTotalMs: 5_000 })
    const ud = mkUserData()
    const starting = manager.start({ workDir: '/w', userDataPath: ud })
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 1 })
    await starting
    // 发起 shutdown：置位后停驻在 done/exit/timeout 等待点（FakeChild 不自退）
    const shuttingDownP = manager.shutdown()
    await flushMicrotasks(2)
    // 反向时序：停机中 start 进入——修复前 IIFE 首行复位停机门并 fork 第二个 child
    await expect(manager.start({ workDir: '/w', userDataPath: ud })).rejects.toThrow('停机流程进行中')
    expect(forkRecords).toHaveLength(1)
    // 收口停机（回执 + 退出）
    forkRecords[0]!.child.emit('message', { type: 'shutdown-done' })
    forkRecords[0]!.child.emit('exit', 0)
    await shuttingDownP
    // 停机完成后：start 开新生命周期正常放行（fork 第二个 child；shutdownStarted 的
    // 主动 kill 标记语义不复位，由新 start 的 IIFE 首行按既有语义处理）
    const second = manager.start({ workDir: '/w', userDataPath: ud })
    expect(forkRecords).toHaveLength(2)
    forkRecords[1]!.child.emit('message', { type: 'ready', port: 2 })
    await expect(second).resolves.toBe(2)
    await manager.stopChild()
  })

  it('对照：stopChild（非停机流程）后的 start 换轮照常放行（kill 标记 ≠ 停机门）', async () => {
    const { forkRecords, manager } = mkHarness()
    const ud = mkUserData()
    const first = manager.start({ workDir: '/w', userDataPath: ud })
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 1 })
    await first
    await manager.stopChild()
    const second = manager.start({ workDir: '/w', userDataPath: ud })
    expect(forkRecords).toHaveLength(2)
    forkRecords[1]!.child.emit('message', { type: 'ready', port: 2 })
    await expect(second).resolves.toBe(2)
    await manager.stopChild()
  })
})

// R44-12（四十四轮）：shutdown 等 settleStarting 的短预算——裸 await 在握手挂起时
// 最坏 30s 握手超时 + kill 升级 2s×2 才收口（用户点退出 ~41s「关不掉」）。修复后
// 预算内未收口即放弃等握手、对在途 fork 就地 kill（握手期 server 未 ready、无在途
// 编排可丢，硬杀无语义损失）；正常路径语义不变（S1 既有用例覆盖）。
describe('R44-12: shutdown 短预算放弃挂起握手', () => {
  it('握手挂起 + 预算耗尽 → 就地 kill 在途 fork（不等 30s 握手超时），无优雅指令面', async () => {
    const { forkRecords, manager } = mkHarness({
      shutdownSettleBudgetMs: 50,
      killWaitMs: 50,
      shutdownTotalMs: 200,
    })
    const ud = mkUserData()
    const starting = manager.start({ workDir: '/w', userDataPath: ud })
    const child = forkRecords[0]!.child
    // ready 永不到达（握手挂起）时触发 shutdown——修复前裸 await settleStarting 卡满
    const t0 = Date.now()
    await manager.shutdown()
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(5_000) // 修复前 ≥ HANDSHAKE_TIMEOUT_MS(30s)
    expect(child.killed).toBeGreaterThanOrEqual(1) // 在途 fork 被 kill 收口（不成孤儿）
    expect(child.posted).not.toContainEqual({ type: 'shutdown' }) // 握手未完成，无优雅指令面
    // kill 后 start 链经 exit 落定（启动途中 exit reject 形态）：接住防未处理拒绝
    await expect(starting).rejects.toThrow()
    expect(forkRecords.length).toBe(1) // 停机门置位，无重启 fork
  })

  it('对照：握手在预算内收口 → 语义不变，对 active child 走优雅停机链', async () => {
    const { forkRecords, manager } = mkHarness({
      shutdownSettleBudgetMs: 5_000,
      shutdownTotalMs: 200,
      killWaitMs: 50,
    })
    const ud = mkUserData()
    const starting = manager.start({ workDir: '/w', userDataPath: ud })
    const child = forkRecords[0]!.child
    const shuttingDown = manager.shutdown()
    child.emit('message', { type: 'ready', port: 46010 })
    await expect(starting).resolves.toBe(46010)
    await flushMicrotasks()
    expect(child.posted).toContainEqual({ type: 'shutdown' }) // 优雅指令（非 kill）
    child.emit('message', { type: 'shutdown-done' })
    child.emit('exit', 0)
    await shuttingDown
    expect(child.killed).toBe(0) // 回执路径不 kill
  })
})

// 重评-P3-8（2026-09-09 全量代码重评）：start 换轮路径的第二次 shutdownStarted = false
// 原为无条件清零——并发 shutdown 恰落在 stopActiveChild 的 kill 等待窗（置 shuttingDown +
// shutdownStarted）时门被拆，launch 的 fork 后检查失守，退出链上 fork 出存活新 child。
// 修复后复位改条件式（if (!shuttingDown)）：停机在途则保持门置位，fork 后检查即杀新
// child 按启动失败收口（S1 同款）。「shutdown 开始后绝不 fork 出存活 child」锁定。
describe('重评-P3-8: 换轮 stopActiveChild 窗口内并发 shutdown 不清停机门', () => {
  it('start-with-active 的 kill 等待窗内并发 shutdown → 新 child fork 即杀（SHUTDOWN reject），停机链上无存活 child', async () => {
    const { forkRecords, manager } = mkHarness({ shutdownSettleBudgetMs: 5_000, shutdownTotalMs: 5_000, killWaitMs: 200 })
    const ud = mkUserData()
    // 1) 首启建 active child
    const first = manager.start({ workDir: '/w', userDataPath: ud })
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 46100 })
    await first
    // 2) 换轮 start：IIFE 走到 await stopActiveChild（kill 已调，exit 待微任务）
    const second = manager.start({ workDir: '/w2', userDataPath: ud })
    expect(forkRecords).toHaveLength(1) // 尚未 fork 新 child（先停旧）
    expect(forkRecords[0]!.child.killed).toBe(1)
    // 3) 并发 shutdown 落在 kill 等待窗内（exit 尚未让渡）——置 shuttingDown + 门
    const shuttingDown = manager.shutdown()
    // 4) 旧 child 退出 → 换轮 IIFE 恢复：修复前此处无条件清门 → child2 存活挂握手，
    //    直到 shutdown 预算兜底才以 EXIT 形态收场（≥5s）；修复后 fork 后检查命中即杀，
    //    SHUTDOWN 信封微任务级 reject
    const t0 = Date.now()
    forkRecords[0]!.child.emit('exit', 0)
    await expect(second).rejects.toThrow(/停机指令/)
    expect(Date.now() - t0).toBeLessThan(2_000) // 快速收口（修复前 ≥ settle 预算 5s）
    await flushMicrotasks()
    expect(forkRecords).toHaveLength(2) // 仅换轮 fork 一次
    expect(forkRecords[1]!.child.killed).toBeGreaterThanOrEqual(1) // 新 child fork 即杀（修复前存活）
    expect(manager.isRunning()).toBe(false)
    // 5) 停机链正常收口，无重启 fork（退出链上无第三个 child）
    await expect(shuttingDown).resolves.toBeUndefined()
    await flushMicrotasks()
    expect(forkRecords).toHaveLength(2)
  })

  it('对照：无并发 shutdown 的换轮（stopChild 后 start）停机门照常复位，新 child 正常握手', async () => {
    const { forkRecords, manager } = mkHarness()
    const ud = mkUserData()
    const first = manager.start({ workDir: '/w', userDataPath: ud })
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 46101 })
    await first
    await manager.stopChild() // 主动停机门置位（无 shuttingDown 生命周期门）
    const second = manager.start({ workDir: '/w2', userDataPath: ud }) // 换轮放行（kill 标记 ≠ 停机门）
    forkRecords[1]!.child.emit('message', { type: 'ready', port: 46102 })
    await expect(second).resolves.toBe(46102) // 门已复位：fork 后检查不误杀
    expect(manager.isRunning()).toBe(true)
    await manager.stopChild()
  })
})

// R49-4（评审四十九轮）：stopChild 等 settleStarting 的短预算——与 shutdown 的 R44-12
// 形态对齐。病理链：崩溃自动重启（doRestart）的握手挂起时 bootstrap 重试触发
// stopChild，原裸 await 最坏 HANDSHAKE_TIMEOUT_MS(30s) + kill 升级 2s×2 ≈ 34s 无响应。
// 修复后预算内未收口即放弃等握手、对在途 fork 就地 kill（同 shutdown 收口原语）；
// 正常路径（握手毫秒级）语义不变（S1 既有用例覆盖）。
describe('R49-4: stopChild 短预算放弃挂起握手', () => {

  it('崩溃重启链：重启握手挂起时 stopChild 在预算内收口（kill 在途 fork，不排程新重启）', async () => {
    const { forkRecords, manager } = mkHarness({
      shutdownSettleBudgetMs: 50,
      killWaitMs: 50,
      backoffMs: [0, 5000, 15000],
    })
    const ud = mkUserData()
    // 第一轮正常起来（后续崩溃走自动重启链）
    const first = manager.start({ workDir: '/w', userDataPath: ud })
    const c1 = forkRecords[0]!.child
    c1.emit('message', { type: 'ready', port: 46100 })
    await first
    // 崩溃 → backoff[0]=0 立即 doRestart：第二轮 fork 握手挂起（ready 永不到达）
    c1.emit('exit', 1)
    await vi.waitFor(() => expect(forkRecords.length).toBe(2), { timeout: 300 })
    const c2 = forkRecords[1]!.child
    // 修复前：此处裸 await settleStarting 卡满 30s 握手超时 + kill 升级 ≈ 34s
    const t0 = Date.now()
    await manager.stopChild()
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(5_000) // 预算(50ms) + kill 收口窗内返回
    expect(c2.killed).toBeGreaterThanOrEqual(1) // 在途重启 fork 被 kill 收口（不成孤儿）
    expect(c2.posted).not.toContainEqual({ type: 'shutdown' }) // 握手未完成，无优雅指令面
    // 主动停机门（同 shutdown 先置位）：kill 的 exit 不误触新重启（封 fork 数锚定）
    await sleep(40)
    expect(forkRecords.length).toBe(2)
    expect(manager.isRunning()).toBe(false)
    expect(manager.hasPendingRestart()).toBe(false) // 挂起重启不作废外溢
  })

  it('预算耗尽 kill 在途 fork → start 链按「启动途中退出」落定（reject 可接住，无未处理拒绝面）', async () => {
    const { forkRecords, manager } = mkHarness({ shutdownSettleBudgetMs: 50, killWaitMs: 50 })
    const ud = mkUserData()
    const starting = manager.start({ workDir: '/w', userDataPath: ud })
    const child = forkRecords[0]!.child
    // 握手挂起（ready 未发）时 stopChild：预算耗尽就地 kill
    await manager.stopChild()
    expect(child.killed).toBeGreaterThanOrEqual(1)
    // kill → exit → 启动途中退出 reject 形态（settleStarting 输掉分支后台 catch，双收口）
    await expect(starting).rejects.toThrow(ServerBootError)
    expect(forkRecords.length).toBe(1) // 停机门置位，无重启 fork
  })
})

// ── R0912-3（重评-0912 P3 #34）：launch fork 后停机检查（S1）的 kill 收编
// killProcAwaitEscalating 等待/升级纪律（TERM→等 killWaitMs→SIGKILL）──
// 此路径的 kill 此前 fire-and-forget，SIGTERM 被吞时新 child 在停机链上漏杀成孤儿。
// 场景 = 重评-P3-8 同款（换轮 start 的 kill 等待窗内并发 shutdown → fork 即杀）。
describe('R0912-3 #34: 停机期在途 fork 的 kill 等待/升级纪律', () => {
  /** 自出生吞信号假件：kill 只计数、不派发 exit（SIGTERM 被吞形态，R28-21 同款） */
  function mkSwallowHarness(extra: ServerManagerDeps = {}): {
    forkRecords: ForkRecord[]
    manager: ReturnType<typeof createStudioServerManager>
  } {
    const forkRecords: ForkRecord[] = []
    const manager = createStudioServerManager({
      ...extra,
      fork: (modulePath, args, options) => {
        const child = new FakeChild()
        child.kill = () => {
          child.killed++
          return true
        }
        forkRecords.push({ modulePath, args, options: options as Record<string, unknown>, child })
        return child
      },
    })
    return { forkRecords, manager }
  }

  it('S1 fork 即杀路径 SIGTERM 被吞 → killWaitMs 后升级 SIGKILL，SHUTDOWN reject 语义保留', async () => {
    const cap = mkLogCapture()
    const { forkRecords, manager } = mkSwallowHarness({
      logger: cap.logger,
      shutdownSettleBudgetMs: 5_000,
      shutdownTotalMs: 5_000,
      killWaitMs: 60,
    })
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const ud = mkUserData()
      // 首启建 active child（吞信号假件下 ready 经 message 照常回传）
      const first = manager.start({ workDir: '/w', userDataPath: ud })
      forkRecords[0]!.child.emit('message', { type: 'ready', port: 46200 })
      await first
      // 换轮 start：旧 child kill 被吞 → IIFE 停驻 kill 等待窗；并发 shutdown 落窗内
      // （置 shuttingDown + 停机门，重评-P3-8 场景）
      const second = manager.start({ workDir: '/w2', userDataPath: ud })
      const shuttingDown = manager.shutdown()
      // 旧 child 退出 → 换轮 IIFE 恢复 → fork 新 child → fork 后检查命中即杀（TERM）
      forkRecords[0]!.child.emit('exit', 0)
      await expect(second).rejects.toThrow(/停机指令/) // 等杀链走完再按启动失败收口
      expect(forkRecords).toHaveLength(2)
      expect(forkRecords[1]!.child.killed).toBe(1) // TERM 已发（fork 即杀）
      // TERM 被吞（pid 仍在）→ killWaitMs 窗过后升级 SIGKILL（修复前 fire-and-forget 无升级）
      expect(killSpy).toHaveBeenCalledWith(4242, 'SIGKILL')
      const escalations = cap.lines.filter((l) => l.level === 'warn' && l.msg.includes('SIGKILL'))
      expect(escalations).toHaveLength(1) // 升级留痕
      await expect(shuttingDown).resolves.toBeUndefined()
      expect(forkRecords).toHaveLength(2) // 停机门置位：exit 不触发重启 fork
    } finally {
      killSpy.mockRestore()
    }
  })

  it('对照：TERM 正常收殓（exit 及时到达）→ 不升级 SIGKILL，SHUTDOWN reject 快速保留', async () => {
    const { forkRecords, manager } = mkHarness({ shutdownSettleBudgetMs: 5_000, shutdownTotalMs: 5_000, killWaitMs: 200 })
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const ud = mkUserData()
      const first = manager.start({ workDir: '/w', userDataPath: ud })
      forkRecords[0]!.child.emit('message', { type: 'ready', port: 46201 })
      await first
      // 换轮 kill → exit 微任务级到达；shutdown 恰落 kill 等待窗（门保持置位）
      const second = manager.start({ workDir: '/w2', userDataPath: ud })
      const shuttingDown = manager.shutdown()
      await expect(second).rejects.toThrow(/停机指令/)
      expect(killSpy).not.toHaveBeenCalled() // exit 竞速赢过 killWaitMs → 不升级
      expect(forkRecords[1]!.child.killed).toBeGreaterThanOrEqual(1)
      await expect(shuttingDown).resolves.toBeUndefined()
    } finally {
      killSpy.mockRestore()
    }
  })
})

// ── R0912-3（重评-0912 P3 #35）：killNow——崩溃退出兜底的同步 kill 信号面 ──
// uncaughtException 的 200ms backstop 到点时 stopChild 可能仍在 settle 竞速窗内
// （预算 2s）、kill 尚未发出，裸 process.exit 会把 child 留成孤儿——backstop 先经
// killNow 同步发 kill 再退（不等待收口：uncaughtException 后必须退出不悬挂）。
describe('R0912-3 #35: killNow 同步 kill 信号', () => {
  it('空态直通；当值 child 已清后在途 fork 同步被杀；被杀 exit 不触发自动重启', async () => {
    const { forkRecords, manager } = mkHarness({ backoffMs: [0, 5_000, 15_000] })
    expect(() => manager.killNow()).not.toThrow() // 空态直通（无 child 无在途 fork）
    const ud = mkUserData()
    const first = manager.start({ workDir: '/w', userDataPath: ud })
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 46300 })
    await first
    // 崩溃 → backoff[0]=0 自动重启 fork 握手挂起（ready 未发，startingProc 在册）
    forkRecords[0]!.child.emit('exit', 1)
    await vi.waitFor(() => expect(forkRecords.length).toBe(2), { timeout: 300 })
    const child2 = forkRecords[1]!.child
    manager.killNow()
    expect(child2.killed).toBe(1) // 在途 fork 同步收到 kill（stopChild 竞速窗内 kill 未发出时的兜底面）
    expect(manager.isRunning()).toBe(false)
    // S-5 门随 killNow 置位：被杀 child 的 exit 不触发新一轮重启（fork 数封顶）
    child2.emit('exit', 1)
    await new Promise((r) => setTimeout(r, 20))
    expect(forkRecords.length).toBe(2)
    expect(manager.hasPendingRestart()).toBe(false)
  })
})

afterAll(() => {
  cleanupServerManagerTmpDirs()
})
