/**
 * O-4（第十三轮）：bootstrap 生命周期 runner 单测——原 main.ts 内联闭包（第十轮 M-6
 * 留账「无测试基建」）抽出后的行为锚定：
 * - Y-P2-7 并发重入挡（进行中重复调用不重跑）+ 失败/完成后可重试
 * - 第九轮 L-3：上次失败滞留的旧 server 在重试前被 close 并置 null（窗口已关时）
 * - 低-8（第十轮）：beginShutdown 置位后 runBootstrap 直通；二次 quit 幂等
 */

import { describe, it, expect } from 'vitest'
import { createBootstrapRunner } from '../../src/desktop/bootstrap-runner.js'

function makeDeps() {
  const state = { mainWindow: null as unknown, server: null as { close: () => void } | null }
  const closed: string[] = []
  return {
    state,
    closed,
    deps: {
      getMainWindow: () => state.mainWindow,
      getStudioServer: () => state.server,
      setStudioServer: (s: { close: () => void } | null) => { state.server = s },
    },
    fakeServer: (id: string): { close: () => void } => ({ close: () => closed.push(id) }),
    // P3（打包修复批）：异步 close 假件——resolve 前标记「旧 server 未收口」
    fakeAsyncServer: (id: string): { close: () => Promise<void> } => ({
      close: () =>
        new Promise<void>((resolve) => {
          queueMicrotask(() => {
            closed.push(id)
            resolve()
          })
        }),
    }),
  }
}

describe('O-4 createBootstrapRunner', () => {
  it('Y-P2-7 并发重入：进行中第二次调用被挡，完成后可重跑', async () => {
    const { deps } = makeDeps()
    let runs = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const runner = createBootstrapRunner(deps, async () => { runs++; await gate })
    runner.runBootstrap()
    runner.runBootstrap() // 进行中：被挡
    expect(runs).toBe(1)
    release()
    await new Promise((r) => setTimeout(r, 0)) // 等 finally 清 bootstrapping
    runner.runBootstrap() // 完成：可重跑
    expect(runs).toBe(2)
  })

  it('失败走 onError 且不挡下一次重试（保 activate 重建语义）', async () => {
    const { deps } = makeDeps()
    const errors: unknown[] = []
    let shouldFail = true
    const runner = createBootstrapRunner(deps, async () => {
      if (shouldFail) throw new Error('loadURL fail')
    })
    runner.runBootstrap((e) => errors.push(e))
    await new Promise((r) => setTimeout(r, 0))
    expect(errors).toHaveLength(1)
    shouldFail = false
    runner.runBootstrap((e) => errors.push(e))
    await new Promise((r) => setTimeout(r, 0))
    expect(errors).toHaveLength(1) // 第二次成功：无新错误
  })

  it('第九轮 L-3：滞留旧 server 进门即 close 并置 null（含上次失败后的重试）', async () => {
    const ctx = makeDeps()
    const { deps, state, closed, fakeServer } = ctx
    let fail = true
    const runner = createBootstrapRunner(deps, async () => {
      if (fail) throw new Error('bootstrap fail after startServer')
    })
    // 第一次：startServer 之后失败（模拟）——滞留的 old server 在进门时即被清
    state.server = fakeServer('old')
    state.mainWindow = { id: 1 }
    runner.runBootstrap()
    expect(closed).toEqual(['old'])
    expect(state.server).toBeNull()
    await new Promise((r) => setTimeout(r, 0))
    // 崩溃后重试进门（再次滞留的旧 server 同样先关再跑）
    fail = false
    state.mainWindow = null
    state.server = fakeServer('old2')
    runner.runBootstrap()
    expect(closed).toEqual(['old', 'old2'])
    expect(state.server).toBeNull()
    await new Promise((r) => setTimeout(r, 0))
  })

  // R-14（第十六轮）：重试关旧 server 的判据修正——原条件叠加 mainWindow === null 自相
  // 矛盾（重试本就要重建 bootstrap，旧 server 无论窗口在否都会被新 startServer 覆盖变量
  // 而泄漏端口/连接）；条件改为「存在旧 server 即关」。
  it('R-14: 窗口仍在但存在旧 server → 进门即 close（不再要求 mainWindow === null）', async () => {
    const ctx = makeDeps()
    const { deps, state, closed, fakeServer } = ctx
    const runner = createBootstrapRunner(deps, async () => {})
    state.server = fakeServer('live')
    state.mainWindow = { id: 1 } // 修复前：窗口在 → 不关旧 server（泄漏）
    runner.runBootstrap()
    expect(closed).toEqual(['live'])
    expect(state.server).toBeNull()
    await new Promise((r) => setTimeout(r, 0))
  })

  it('低-8：beginShutdown 置位后 runBootstrap 直通；二次置位返回 false（二次 quit 直通）', async () => {
    const { deps } = makeDeps()
    let runs = 0
    const runner = createBootstrapRunner(deps, async () => { runs++ })
    expect(runner.beginShutdown()).toBe(true) // 首次：进入优雅退出
    expect(runner.beginShutdown()).toBe(false) // 二次 quit：直通不再 preventDefault
    expect(runner.shuttingDown).toBe(true)
    runner.runBootstrap() // 退出途中 activate：直通
    await new Promise((r) => setTimeout(r, 0))
    expect(runs).toBe(0)
  })

  // P3（打包修复批）：close() 返回 Promise 时 runner 必须等其落定再开跑——原
  // fire-and-forget 会在旧 server 未收口（端口/连接未清）时就 fork 新 child
  it('P3：异步 close——bootstrap 等 close 落定后才开跑（不再 fire-and-forget）', async () => {
    const ctx = makeDeps()
    const { deps, state } = ctx
    const order: string[] = []
    state.server = {
      close: () =>
        new Promise<void>((resolve) => {
          queueMicrotask(() => {
            order.push('closed')
            resolve()
          })
        }),
    }
    const runner = createBootstrapRunner(deps, async () => {
      order.push('bootstrap')
    })
    runner.runBootstrap()
    // close 已同步发起但未落定：bootstrap 不得先跑（微任务序：close resolve 先于 bootstrap）
    expect(order).toEqual([])
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual(['closed', 'bootstrap']) // 收口先于开跑
    expect(state.server).toBeNull()
  })

  it('P3：异步 close 在途期间并发 runBootstrap 被重入门挡住（不双跑 bootstrap）', async () => {
    const ctx = makeDeps()
    const { deps, state } = ctx
    let runs = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    state.server = { close: () => gate }
    const runner = createBootstrapRunner(deps, async () => { runs++ })
    runner.runBootstrap()
    runner.runBootstrap() // close 在途（bootstrapping 已占门）：被挡
    expect(runs).toBe(0)
    release()
    await new Promise((r) => setTimeout(r, 0))
    expect(runs).toBe(1)
  })
})
