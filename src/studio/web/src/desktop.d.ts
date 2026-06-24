/**
 * 桌面版 preload 注入的书库管理 API 类型声明。
 *
 * 桌面版（Electron）经 preload.ts 的 contextBridge 注入 window.clwritingDesktop；
 * 浏览器版（clwriting studio）无此脚本 → window.clwritingDesktop 为 undefined
 * → 前端据此隐藏桌面专属入口（打开书库 / 最近列表）。
 */
interface Window {
  clwritingDesktop?: {
    /** 弹原生目录选择器选书库 → 选定则主进程 relaunch；取消返回 canceled。 */
    openLibrary: () => Promise<{ ok: true } | { ok: false; canceled: true }>
    /** 切换到指定书库路径（来自最近列表）→ relaunch。 */
    switchLibrary: (path: string) => Promise<{ ok: true } | { ok: false; reason: string }>
    /** 读最近书库列表。 */
    getRecentLibraries: () => Promise<{ path: string; label: string }[]>
    /** 读当前书库目录（null = 未选）。 */
    getCurrentLibrary: () => Promise<string | null>
  }
}
