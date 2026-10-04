/**
 * `new-instance.ts` 单测——spawn 新实例打开书库的成败落定（评审 P2-1 回归靶）。
 *
 * 回归靶：spawn 的**异步 'error' 事件**（ENOENT/EACCES 等启动失败）必须被消费——
 * 修复前不挂监听，EventEmitter 抛出升级为 uncaughtException，main 的退出链会把
 * 整个应用带走；'spawn' 成功路径返回 true、失败路径返回 false（调用方错误框 /
 * {ok:false,reason} 契约面），两路都不抛。断言只锚对外可观察面（返回布尔 + 不抛），
 * 不锚日志文本。
 *
 * 追加靶（多库多窗「父退子存」+ 新实例主窗可见）：spawn 选项 detached 必须恒为 true——
 * Windows 上非 detached 的子进程会自动加入运行时（libuv）自建的 KILL_ON_JOB_CLOSE Job
 * （句柄由本进程持有），本实例退出即连带硬杀子实例。该断言只在 win 咬合（POSIX 旧实现
 * 同为 true）。windowsHide 必须不置真——目标为 GUI 子系统程序，置真会把 STARTUPINFO
 * 的 SW_HIDE 传给 Chromium 作首个顶层窗口初始显示状态，新实例主窗出生即隐藏（win）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

const M = vi.hoisted(() => ({
  isPackaged: false,
  appPath: '/repo/app',
  /** 最近一次 spawn 的记账（期望值断言用） */
  last: { file: '', args: [] as string[], opts: undefined as unknown },
  /** 测试注入的假子进程工厂（缺省 = 立即 'spawn'） */
  makeChild: null as null | (() => EventEmitter),
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return M.isPackaged
    },
    getAppPath: () => M.appPath,
  },
}))

vi.mock('node:child_process', () => ({
  spawn: (file: string, args: string[], opts: unknown) => {
    M.last = { file, args, opts }
    const child = M.makeChild ? M.makeChild() : Object.assign(new EventEmitter(), { unref: () => {} })
    // 真 spawn 的 'spawn' 事件在下一拍到达——同形异步落定（防实现改回同步假设的假绿）
    if (!M.makeChild) setImmediate(() => child.emit('spawn'))
    return child
  },
}))

vi.mock('../../src/log/index.js', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {} },
  errMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))

import { spawnLibraryInstance } from '../../src/desktop/new-instance.js'

afterEach(() => {
  M.isPackaged = false
  M.makeChild = null
})

describe('spawnLibraryInstance：成败经 spawn/error 事件落定（不抛不反噬主进程）', () => {
  it("子进程成功拉起 → true；打包形态 argv = ['--dir', dir]", async () => {
    M.isPackaged = true
    await expect(spawnLibraryInstance('/libs/A')).resolves.toBe(true)
    expect(M.last.file).toBe(process.execPath)
    expect(M.last.args).toEqual(['--dir', '/libs/A'])
  })

  it("dev 形态 argv = [appPath, '--dir', dir]（electron 二进制 + 应用目录参数）", async () => {
    M.isPackaged = false
    await expect(spawnLibraryInstance('/libs/B')).resolves.toBe(true)
    expect(M.last.args).toEqual([M.appPath, '--dir', '/libs/B'])
  })

  it("异步 'error'（ENOENT 形态）→ false 且不抛——修复前该事件无监听会升级 uncaughtException", async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void }
    child.unref = () => {}
    M.makeChild = () => child
    const p = spawnLibraryInstance('/libs/C')
    const e = Object.assign(new Error('spawn nonexistent ENOENT'), { code: 'ENOENT' })
    // 事件带监听时 emit 不会抛——此处以「未捕获异常」兜底验证消费
    let uncaught = false
    const onUncaught = (err: unknown): void => {
      uncaught = true
      void err
    }
    process.once('uncaughtException', onUncaught)
    child.emit('error', e)
    const r = await p
    process.removeListener('uncaughtException', onUncaught)
    expect(uncaught).toBe(false)
    expect(r).toBe(false)
  })

  it("'error' 先到后 'spawn' 迟到的理论双发 → 只认先到（false），不翻转结论", async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void }
    child.unref = () => {}
    M.makeChild = () => child
    const p = spawnLibraryInstance('/libs/D')
    child.emit('error', new Error('boom'))
    child.emit('spawn') // 迟发：真 spawn 不会双发，此处守实现侧 settled 门
    await expect(p).resolves.toBe(false)
  })
})

describe('spawnLibraryInstance：spawn 选项（「父退子存」+ 主窗可见 回归靶）', () => {
  it('detached 恒为 true；stdio=ignore；windowsHide 不置真（置真即新实例主窗隐藏）', async () => {
    await expect(spawnLibraryInstance('/libs/E')).resolves.toBe(true)
    const opts = M.last.opts as { detached: boolean; stdio: string; windowsHide?: boolean }
    expect(opts.detached).toBe(true)
    expect(opts.stdio).toBe('ignore')
    expect(opts.windowsHide ?? false).toBe(false)
  })
})
