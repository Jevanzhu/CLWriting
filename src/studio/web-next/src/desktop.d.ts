// Electron 桌面版 preload 注入的全局 API（src/desktop/preload.ts）。
// 浏览器版无此脚本 → window.clwritingDesktop 不存在 → 用前判空降级。
export {}

declare global {
  interface Window {
    clwritingDesktop?: {
      openLibrary: () => Promise<{ ok: true } | { ok: false; canceled: true }>
      switchLibrary: (path: string) => Promise<{ ok: true } | { ok: false; reason: string }>
      getRecentLibraries: () => Promise<{ path: string; label: string }[]>
      getCurrentLibrary: () => Promise<string | null>
      showInFolder: (bookName: string, relPath: string) => Promise<void>
      openBookDir: (bookName: string) => Promise<void>
      getSystemFonts: () => Promise<string[]>
      openShelf: () => Promise<void>
      openLibraryWindow: () => Promise<void>
      openLibraryDir: () => Promise<void>
      openBook: (name: string) => Promise<void>
      /** 订阅主窗口导航事件，返回退订函数 */
      onNavigate: (cb: (path: string) => void) => () => void
      /** 订阅系统菜单动作（菜单 click → actionKey 回调），返回退订函数 */
      onMenuAction: (cb: (key: string) => void) => () => void
      /** 进入/退出窗口原生全屏（专注模式驱动） */
      setFullScreen: (flag: boolean) => Promise<void>
      /** 订阅窗口全屏态变化（系统手势退出全屏时回调 false），返回退订函数 */
      onFullScreenChange: (cb: (fullscreen: boolean) => void) => () => void
      /** 弹原生右键菜单（items=菜单项定义；cb=选择回调，取消收到 null） */
      showContextMenu: (
        items: Array<{
          key: string
          label?: string
          separator?: boolean
          disabled?: boolean
          accelerator?: string
          submenu?: unknown[]
        }>,
        cb: (key: string | null) => void,
      ) => void
    }
  }
}
