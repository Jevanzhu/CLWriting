/**
 * kk-P2-8：Electron preload.ts 自动化（此前 68 行 0% 覆盖）。
 *
 * 手法：vi.mock('electron') 捕获 contextBridge.exposeInMainWorld 的暴露面与
 * ipcRenderer 调用，断言：
 * - 暴露键名 window.clwritingDesktop（浏览器版无此键即隐藏桌面入口的判定基础）
 * - 方法 → channel 映射与 invoke 透传实参
 * - onNavigate/onMenuAction 订阅可退订（Y-P2-7 监听器清理）
 * - showContextMenu：once 注册 + send 载荷（选择回传通道）
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'

const M = vi.hoisted(() => ({
  exposed: null as null | Record<string, (...a: unknown[]) => unknown>,
  invoke: [] as Array<[string, ...unknown[]]>,
  listeners: {} as Record<string, Array<(...a: unknown[]) => void>>,
  onceHandlers: {} as Record<string, Array<(...a: unknown[]) => void>>,
  sent: [] as Array<[string, ...unknown[]]>,
  removed: [] as Array<[string, ...unknown[]]>,
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: Record<string, (...a: unknown[]) => unknown>) => {
      if (key === 'clwritingDesktop') M.exposed = api
    },
  },
  ipcRenderer: {
    invoke: (...a: [string, ...unknown[]]) => {
      M.invoke.push(a)
      return Promise.resolve(null)
    },
    on: (ch: string, fn: (...a: unknown[]) => void) => {
      ;(M.listeners[ch] ??= []).push(fn)
    },
    removeListener: (ch: string, fn: (...a: unknown[]) => void) => {
      M.removed.push([ch, fn])
      const arr = M.listeners[ch]
      if (arr) M.listeners[ch] = arr.filter((f) => f !== fn)
    },
    once: (ch: string, fn: (...a: unknown[]) => void) => {
      ;(M.onceHandlers[ch] ??= []).push(fn)
    },
    send: (...a: [string, ...unknown[]]) => {
      M.sent.push(a)
    },
  },
}))

beforeAll(async () => {
  await import('../../src/desktop/preload.js')
  expect(M.exposed, 'contextBridge 应暴露 clwritingDesktop').toBeTruthy()
})

// R0910-W：preload 在模块加载期向 globalThis（渲染层 window 同一）挂 window unload 清场
// 监听——捕获面。必须在 import preload 前定义（beforeAll 内 import 此时已执行到此）。
const unloadListeners: Array<() => void> = []
;(globalThis as { addEventListener?: (type: string, listener: () => void) => void }).addEventListener = (
  type: string,
  listener: () => void,
): void => {
  if (type === 'unload') unloadListeners.push(listener)
}

describe('kk-P2-8：preload 暴露面 → channel 映射', () => {
  const CASES: Array<[string, string, unknown[]]> = [
    ['openLibrary', 'desktop:open-library', []],
    ['getRecentLibraries', 'desktop:get-recent', []],
    ['getCurrentLibrary', 'desktop:get-current', []],
    ['showInFolder', 'desktop:show-in-folder', ['书A', '第1章.md']],
    ['openBookDir', 'desktop:open-book-dir', ['书A']],
    ['getSystemFonts', 'desktop:get-system-fonts', []],
    ['openShelf', 'desktop:open-shelf', []],
    ['openLibraryWindow', 'desktop:open-library-window', []],
    ['openLibraryDir', 'desktop:open-library-dir', []],
    ['openBook', 'desktop:open-book', ['书A']],
  ]
  for (const [method, channel, args] of CASES) {
    it(`${method}() → invoke ${channel}${args.length ? ' ' + JSON.stringify(args) : ''}`, async () => {
      const n0 = M.invoke.length
      await (M.exposed![method]! as (...a: unknown[]) => Promise<void>)(...args)
      expect(M.invoke[n0]!).toEqual([channel, ...args])
    })
  }

  it('switchLibrary(path) → invoke desktop:switch-library 带路径', async () => {
    const n0 = M.invoke.length
    await (M.exposed!['switchLibrary']! as (...a: unknown[]) => Promise<void>)('/tmp/lib')
    expect(M.invoke[n0]!).toEqual(['desktop:switch-library', '/tmp/lib'])
  })
})

describe('kk-P2-8：preload 订阅通道', () => {
  it('onNavigate：回调收到 path，退订生效（Y-P2-7）', () => {
    const got: string[] = []
    const off = (M.exposed!['onNavigate']! as (cb: (p: string) => void) => () => void)((p) => got.push(p))
    const h = M.listeners['desktop:navigate']![0]!
    h({}, '/book/x')
    expect(got).toEqual(['/book/x'])
    off()
    expect(M.removed[0]![0]).toBe('desktop:navigate')
  })

  it('onMenuAction：回调收到 actionKey，退订生效', () => {
    const got: string[] = []
    const off = (M.exposed!['onMenuAction']! as (cb: (k: string) => void) => () => void)((k) => got.push(k))
    M.listeners['desktop:menu-action']![0]!({}, 'settings')
    expect(got).toEqual(['settings'])
    off()
    expect(M.removed.some(([ch]) => ch === 'desktop:menu-action')).toBe(true)
  })

  it('onServerRestarted：回调收到恢复端口，退订生效（重审-3）', () => {
    const got: number[] = []
    const off = (M.exposed!['onServerRestarted']! as (cb: (p: number) => void) => () => void)((p) => got.push(p))
    M.listeners['desktop:server-restarted']![0]!({}, 45678)
    expect(got).toEqual([45678])
    off()
    expect(M.removed.some(([ch]) => ch === 'desktop:server-restarted')).toBe(true)
  })

  it('showContextMenu：send 载荷 + once 回传 key', () => {
    const got: Array<string | null> = []
    ;(M.exposed!['showContextMenu']! as (
      items: Array<Record<string, unknown>>,
      cb: (k: string | null) => void,
    ) => void)([{ label: '复制', key: 'copy' }], (k) => got.push(k))
    expect(M.sent[M.sent.length - 1]!).toEqual(['desktop:context-menu', [{ label: '复制', key: 'copy' }]])
    M.onceHandlers['desktop:context-menu-select']![0]!({}, 'copy')
    expect(got).toEqual(['copy'])
  })

  // R0910-W：主进程因拒绝/不可信 sender/窗口销毁未回执 desktop:context-menu 时，once
  // 监听与 pendingMenuSelect 原样常驻到下一次 showContextMenu（泄漏）。窗口 unload 兜底清场。
  it('R0910-W: 窗口 unload 清场 pending once 监听（主进程不回执形态）', () => {
    const before = M.removed.length
    ;(M.exposed!['showContextMenu']! as (
      items: Array<Record<string, unknown>>,
      cb: (k: string | null) => void,
    ) => void)([{ label: '复制', key: 'copy' }], vi.fn())
    const handler = M.onceHandlers['desktop:context-menu-select']!.at(-1)!
    expect(unloadListeners.length, 'import 期应挂 window unload 清场监听').toBeGreaterThan(0)
    for (const fn of unloadListeners) fn() // 触发 unload
    expect(
      M.removed.slice(before).some(([ch, fn]) => ch === 'desktop:context-menu-select' && fn === handler),
      'unload 应摘除 pending once 监听',
    ).toBe(true)
    // 清场已把 pendingMenuSelect 置空：再次 showContextMenu 不再重复摘旧
    const removedAfterUnload = M.removed.length
    ;(M.exposed!['showContextMenu']! as (
      items: Array<Record<string, unknown>>,
      cb: (k: string | null) => void,
    ) => void)([{ label: '粘贴', key: 'paste' }], vi.fn())
    expect(M.removed.length).toBe(removedAfterUnload)
  })
})
