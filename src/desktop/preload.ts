/**
 * Electron 预加载脚本（桌面化工作目录管理，批2）。
 *
 * contextBridge 安全暴露「书库管理」API 给渲染进程（书架页按钮 / 最近列表调用）。
 * 渲染进程不直连 Node/ipcRenderer，只经 window.clwritingDesktop。
 *
 * 浏览器版无此脚本 → window.clwritingDesktop 不存在 → 前端据此隐藏桌面入口。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

/** 右键菜单 pending 一次性监听（连开新菜单前摘旧，防 channel 广播串到旧回调） */
let pendingMenuSelect: ((_e: IpcRendererEvent, key: string | null) => void) | null = null

contextBridge.exposeInMainWorld('clwritingDesktop', {
  /** 渲染进程平台标识（win 窗控 overlay 避让等平台分支用；浏览器版无此对象）。 */
  platform: process.platform,
  /** 弹原生目录选择器选书库 → 选定则切换（relaunch）。取消返回 { ok:false, canceled:true }。 */
  openLibrary: (): Promise<{ ok: true } | { ok: false; canceled: true }> =>
    ipcRenderer.invoke('desktop:open-library'),
  /** 切换到指定书库路径（来自最近列表）→ relaunch。 */
  switchLibrary: (
    path: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('desktop:switch-library', path),
  /** 读最近书库列表。 */
  getRecentLibraries: (): Promise<{ path: string; label: string }[]> =>
    ipcRenderer.invoke('desktop:get-recent'),
  /** 读当前书库目录（null = 未选）。 */
  getCurrentLibrary: (): Promise<string | null> => ipcRenderer.invoke('desktop:get-current'),
  /** 在系统文件管理器中显示文档（仅桌面版；浏览器版此函数不存在，前端据此隐藏入口）。 */
  showInFolder: (bookName: string, relPath: string): Promise<void> =>
    ipcRenderer.invoke('desktop:show-in-folder', bookName, relPath),
  /** 在系统文件管理器中打开书库根目录（仅桌面版）。 */
  openBookDir: (bookName: string): Promise<void> =>
    ipcRenderer.invoke('desktop:open-book-dir', bookName),
  /** 枚举系统已装字体名（设置弹窗字体下拉；失败返回空数组）。 */
  getSystemFonts: (): Promise<string[]> =>
    ipcRenderer.invoke('desktop:get-system-fonts'),
  /** 打开独立书架窗口（桌面版；工作区时管理/切换/建书，单例聚焦）。 */
  openShelf: (): Promise<void> => ipcRenderer.invoke('desktop:open-shelf'),
  /** 打开独立书库管理窗口（切换/最近/新建书库，单例聚焦）。 */
  openLibraryWindow: (): Promise<void> => ipcRenderer.invoke('desktop:open-library-window'),
  /** 在系统文件管理器中打开当前书库根目录。 */
  openLibraryDir: (): Promise<void> => ipcRenderer.invoke('desktop:open-library-dir'),
  /** 书架窗口选书 → 通知主窗口打开该工作区并聚焦，关闭书架窗口。 */
  openBook: (name: string): Promise<void> =>
    ipcRenderer.invoke('desktop:open-book', name),
  /** 订阅主窗口导航事件（书架窗口选书时主进程转发到此，主窗口 router.push）。返回退订函数（Y-P2-7）。 */
  onNavigate: (cb: (path: string) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, path: string): void => cb(path)
    ipcRenderer.on('desktop:navigate', handler)
    return () => {
      ipcRenderer.removeListener('desktop:navigate', handler)
    }
  },
  /** 订阅系统菜单动作（菜单 click → 主进程转发 actionKey → 前端 dispatch）。返回退订函数（Y-P2-7）。 */
  onMenuAction: (cb: (key: string) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, key: string): void => cb(key)
    ipcRenderer.on('desktop:menu-action', handler)
    return () => {
      ipcRenderer.removeListener('desktop:menu-action', handler)
    }
  },
  /** 进入/退出窗口原生全屏（专注模式驱动；HTML5 Fullscreen API 无手势会被拒，走主进程无此限制）。 */
  setFullScreen: (flag: boolean): Promise<void> =>
    ipcRenderer.invoke('desktop:set-fullscreen', flag),
  /** 运行时更新 win 窗控 overlay 颜色（主题切换驱动；非 win 主进程 no-op）。
   *  dark 额外同步 nativeTheme.themeSource——overlay 透明后按钮底色由系统按主题绘制。 */
  setTitleBarOverlay: (o: { color?: string; symbolColor?: string; dark?: boolean }): Promise<void> =>
    ipcRenderer.invoke('desktop:set-titlebar-overlay', o),
  /** 订阅窗口全屏态变化（系统手势退出全屏时回调 false）。返回退订函数。 */
  onFullScreenChange: (cb: (fullscreen: boolean) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, fullscreen: boolean): void => cb(fullscreen)
    ipcRenderer.on('desktop:fullscreen-change', handler)
    return () => {
      ipcRenderer.removeListener('desktop:fullscreen-change', handler)
    }
  },
  /** 弹出原生右键菜单（macOS 原生外观）；选择时回调收到 key，取消收到 null。
   *  二轮复审（低级）：连开第二份菜单前摘掉上一份的 pending once 监听——channel 是
   *  窗口级广播，残留监听会收到新菜单的选择串到旧回调（首条消息双投递） */
  showContextMenu: (
    items: Array<Record<string, unknown>>,
    cb: (key: string | null) => void,
  ): void => {
    if (pendingMenuSelect) ipcRenderer.removeListener('desktop:context-menu-select', pendingMenuSelect)
    const handler = (_e: IpcRendererEvent, key: string | null): void => {
      pendingMenuSelect = null
      cb(key)
    }
    pendingMenuSelect = handler
    ipcRenderer.once('desktop:context-menu-select', handler)
    ipcRenderer.send('desktop:context-menu', items)
  },
})
