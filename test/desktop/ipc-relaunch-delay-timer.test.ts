/**
 * 0918四轮修复批（C405）回归：open-library / switch-library 的延迟重启 timer 句柄单槽。
 *
 * 缺陷形态：两 handler 内裸排 `setTimeout(relaunch, RELAUNCH_DELAY_MS)` 不留句柄——
 * 不可清、不可 unref，违 ipc.ts timer 纪律（R46-19 / R54-A-5，对齐 contextMenuCancelTimers
 * 的 R1010b-DSK-P3-6 句柄登记口径）。修复 = 模块级单槽（armRelaunchDelayTimer）：排新清旧
 * （回程窗内重复触发 = 前次响应已废，不叠加）、触发后自清、unref。
 *
 * 手法：electron / windows.js / workdir-controller 假件直驱 ipc.ts 注册面（relaunch 计数
 * 捕获），fake timers 精确控制回程窗（O-11 的 100ms）时序。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/** mock 状态（vi.hoisted 保证 vi.mock 工厂可见） */
const M = vi.hoisted(() => ({
  relaunchCalls: 0,
  ipcHandle: {} as Record<string, (e: unknown, ...a: unknown[]) => unknown>,
}))

vi.mock('electron', () => ({
  app: {
    quit: (): void => {},
    getPath: (k: string) => `/fake/${k}`,
  },
  BrowserWindow: Object.assign(
    class {
      isDestroyed(): boolean {
        return false
      }
    },
    { fromWebContents: () => null, getAllWindows: () => [] },
  ),
  Menu: { buildFromTemplate: () => ({ popup: (): void => {} }), setApplicationMenu: (): void => {} },
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => {
      M.ipcHandle[ch] = fn
    },
    on: (): void => {},
  },
  nativeTheme: { themeSource: 'light' },
  shell: { showItemInFolder: (): void => {}, openPath: async () => '' },
  dialog: {},
}))
// ipc.ts 的窗工厂/受信判定面——本组用例只驱动 switch-library 延迟重启，全部假件
vi.mock('../../src/desktop/windows.js', () => ({
  wins: {},
  isTrustedSender: () => true,
  openShelfWindow: async (): Promise<unknown> => null,
  openLibraryWindow: async (): Promise<unknown> => null,
}))
// workdir-controller 假件：switch-library 守卫链全放行；relaunch 换计数捕获
//（ipc.ts 只经 armRelaunchDelayTimer 间接触达 relaunch——计数即 timer 行为的观测面）
vi.mock('../../src/desktop/workdir-controller.js', () => ({
  canSwitchLibraryDir: () => true,
  currentWorkDir: () => null,
  findBookEntry: () => undefined,
  pickLibrary: async () => null,
  probeDirReachable: async () => 'ok',
  readStore: () => ({ current: null, recent: [] }),
  relaunch: () => {
    M.relaunchCalls++
  },
  resolveReachableWorkDir: async () => null,
  saveCurrentArmingRollback: () => null,
  warnIfCaseSensitive: async () => false,
}))
vi.mock('font-list', () => ({ getFonts: async () => [] }))

import { registerIpc } from '../../src/desktop/ipc.js'

/** 跨平台绝对路径（switch-library 入口 isAbsolute 守卫按宿主平台判定） */
function absLib(name: string): string {
  return process.platform === 'win32' ? `C:\\lib\\${name}` : `/lib/${name}`
}

beforeEach(() => {
  vi.useFakeTimers()
  M.relaunchCalls = 0
  registerIpc()
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('C405: relaunch 延迟 timer 单槽句柄', () => {
  it('switch-library 成功 → 回程窗（100ms）内不重启，到点恰好一次 relaunch', async () => {
    const r = (await M.ipcHandle['desktop:switch-library']!({}, absLib('a'))) as { ok: boolean }
    expect(r).toEqual({ ok: true })
    vi.advanceTimersByTime(99)
    expect(M.relaunchCalls, '回程窗内响应先回渲染进程（O-11），不重启').toBe(0)
    vi.advanceTimersByTime(1)
    expect(M.relaunchCalls).toBe(1)
  })

  it('重复触发不叠加：回程窗内二次成功 → 旧句柄被清，最终 relaunch 仍只一次', async () => {
    await M.ipcHandle['desktop:switch-library']!({}, absLib('a'))
    vi.advanceTimersByTime(50)
    await M.ipcHandle['desktop:switch-library']!({}, absLib('b')) // 排新清旧（单槽）
    vi.advanceTimersByTime(50) // 第一次排程本应到点的时刻（句柄已被清，不触发）
    expect(M.relaunchCalls, '旧句柄已清：首个 100ms 到点不重启').toBe(0)
    vi.advanceTimersByTime(50) // 第二次排程到点
    expect(M.relaunchCalls).toBe(1)
  })
})
