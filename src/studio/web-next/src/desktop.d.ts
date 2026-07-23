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
    }
  }
}
