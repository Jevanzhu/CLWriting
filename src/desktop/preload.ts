/**
 * Electron 预加载脚本（桌面化工作目录管理）。
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

/** 待选监听清场（幂等）——主进程因拒绝/不可信 sender/窗口销毁而未回执
 *  desktop:context-menu 时，once 监听与 pendingMenuSelect 原样常驻到下一次
 *  showContextMenu。窗口 unload 一次性清场兜底；正常回执路径 handler 已自摘，清场为
 *  无害 no-op（正常路径行为完全不变）。 */
function clearPendingMenuSelect(): void {
  if (pendingMenuSelect) {
    ipcRenderer.removeListener('desktop:context-menu-select', pendingMenuSelect)
    pendingMenuSelect = null
  }
}
// globalThis 与渲染层 window 同一（isolated world）；ES2023 lib 无 DOM 类型，用最小结构
// 型表达。同函数引用重复 addEventListener 被浏览器去重，无需额外「只挂一次」旗。
const unloadHost = globalThis as { addEventListener?: (type: string, listener: () => void) => void }
if (typeof unloadHost.addEventListener === 'function') {
  unloadHost.addEventListener('unload', clearPendingMenuSelect)
}

contextBridge.exposeInMainWorld('clwritingDesktop', {
  /** 渲染进程平台标识（win 窗控 overlay 避让等平台分支用；浏览器版无此对象）。 */
  platform: process.platform,
  /**
   * 弹原生目录选择器选书库 → 选定则切换（relaunch）。取消返回 { ok:false, canceled:true }。
   * -（全量代码）：落库失败（saveCurrent 写盘错等）返回
   * { ok:false, reason }——与 switchLibrary 的失败信封对称（main.ts open-library
   * handler 起契约化失败，此前类型声明漏该变体）。
   */
  openLibrary: (): Promise<{ ok: true } | { ok: false; canceled: true } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('desktop:open-library'),
  /** 切换到指定书库路径（来自最近列表）→ relaunch。 */
  switchLibrary: (path: string): Promise<{ ok: true } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('desktop:switch-library', path),
  /** 在**新窗口**中打开指定书库（多库多窗）——spawn 新实例，本窗口不动。
   *  目标库已开在别的窗口时，那个窗口被聚焦（新实例拿不到单实例锁后自行退出）。 */
  openLibraryInNewWindow: (path: string): Promise<{ ok: true } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('desktop:open-library-in-new-window', path),
  /** 读最近书库列表。 */
  getRecentLibraries: (): Promise<{ path: string; label: string }[]> => ipcRenderer.invoke('desktop:get-recent'),
  /** 读当前书库目录（null = 未选）。 */
  getCurrentLibrary: (): Promise<string | null> => ipcRenderer.invoke('desktop:get-current'),
  /** 在系统文件管理器中显示文档（仅桌面版；浏览器版此函数不存在，前端据此隐藏入口）。 */
  showInFolder: (bookName: string, relPath: string): Promise<void> =>
    ipcRenderer.invoke('desktop:show-in-folder', bookName, relPath),
  /** 在系统文件管理器中打开书库根目录（仅桌面版）。 */
  openBookDir: (bookName: string): Promise<void> => ipcRenderer.invoke('desktop:open-book-dir', bookName),
  /** 枚举系统已装字体名（设置弹窗字体下拉；失败返回空数组）。 */
  getSystemFonts: (): Promise<string[]> => ipcRenderer.invoke('desktop:get-system-fonts'),
  /** 打开独立书架窗口（桌面版；工作区时管理/切换/建书，单例聚焦）。 */
  openShelf: (): Promise<void> => ipcRenderer.invoke('desktop:open-shelf'),
  /** 打开独立书库管理窗口（切换/最近/新建书库，单例聚焦）。 */
  openLibraryWindow: (): Promise<void> => ipcRenderer.invoke('desktop:open-library-window'),
  /** 在系统文件管理器中打开当前书库根目录。 */
  openLibraryDir: (): Promise<void> => ipcRenderer.invoke('desktop:open-library-dir'),
  /** 打开诊断包所在目录（设置 → 诊断入口）。目录由主进程自行推导（不接受渲染层
   *  传路径，同三入口口径）；未生成过包时主进程静默返回（无物可开）。 */
  revealDiagnostics: (): Promise<void> => ipcRenderer.invoke('desktop:reveal-diagnostics'),
  /** 阶段 53：用系统浏览器打开外部链接（更新提示面「去下载」用）。
   *  主进程侧白名单只放行本项目 GitHub 发布页——白名单外回 { ok:false, reason }，
   *  前端据此降级「复制链接」。 */
  openExternal: (url: string): Promise<{ ok: true } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('desktop:open-external', url),
  /** 阶段 55：自更新能力闸（canDownload = 应用内下载；canInstall = 自动安装并重启）。
   *  两者都是主进程按「平台 + 打包态（+ 开发态显式开关）」判定的产物——渲染层不自行
   *  推平台结论（mac/linux 形态下载与安装面各自独立）。 */
  updateCapability: (): Promise<{ canDownload: boolean; canInstall: boolean }> =>
    ipcRenderer.invoke('desktop:update-capability'),
  /** 立即跑一次更新检查（手动入口）。检查在主进程出站（net.fetch 受系统代理，与下载腿
   *  同通道）；结果不下浮——渲染层收到回执后重读 `/api/app-info` 取正式结论。
   *  `reason` 区分检查中 / 距上次过近 / 已禁用 / 宿主未就绪，前端据此给回执。 */
  updateCheck: (): Promise<
    | { ok: true; hasUpdate: boolean; error: string | null }
    | { ok: false; reason: 'checking' | 'tooSoon' | 'disabled' | 'unavailable' }
  > => ipcRenderer.invoke('desktop:update-check'),
  /** 阶段 55：下载便携包并校验（就绪后主进程持有「更新包就绪态」，供 updateApply 兑现）。
   *  进度经 onUpdateProgress 推送；返回值 = 本次下载的终态契约。 */
  updateDownload: (version: string): Promise<{ ok: true } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('desktop:update-download', version),
  /** 阶段 55：取消在途下载（无在途时 no-op）。 */
  updateCancel: (): Promise<{ ok: true }> => ipcRenderer.invoke('desktop:update-cancel'),
  /** 阶段 55：带更新意图退出并重启（主进程在退出链不可回头点拉起更新助手完成换目录）。
   *  形态不支持/包未就绪/其他窗口在跑等一律回 { ok:false, reason }（人话，界面上屏）。 */
  updateApply: (version: string): Promise<{ ok: true } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('desktop:update-apply', version),
  /** 阶段 55：在文件管理器中显示已下载的更新包（开发态只有下载没有安装时的出口）。 */
  updateReveal: (): Promise<void> => ipcRenderer.invoke('desktop:update-reveal'),
  /** 阶段 55：订阅下载进度（received/total 字节；total 为 null 表示服务端未报总长）。
   *  返回退订函数。 */
  onUpdateProgress: (cb: (p: { received: number; total: number | null }) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, p: { received: number; total: number | null }): void => cb(p)
    ipcRenderer.on('desktop:update-progress', handler)
    return () => {
      ipcRenderer.removeListener('desktop:update-progress', handler)
    }
  },
  /** 阶段 55：订阅「退出被取消、更新意图作废」（flush 冲突/失败确认后用户选了取消）——
   *  界面据此把「正在退出并更新…」态撤回。返回退订函数。 */
  onUpdateApplyCancelled: (cb: () => void): (() => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('desktop:update-apply-cancelled', handler)
    return () => {
      ipcRenderer.removeListener('desktop:update-apply-cancelled', handler)
    }
  },
  /** 书架窗口选书 → 通知主窗口打开该工作区并聚焦，关闭书架窗口。 */
  openBook: (name: string): Promise<void> => ipcRenderer.invoke('desktop:open-book', name),
  /** 订阅主窗口导航事件（书架窗口选书时主进程转发到此，主窗口 router.push）。返回退订函数。 */
  onNavigate: (cb: (path: string) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, path: string): void => cb(path)
    ipcRenderer.on('desktop:navigate', handler)
    return () => {
      ipcRenderer.removeListener('desktop:navigate', handler)
    }
  },
  /** 订阅系统菜单动作（菜单 click → 主进程转发 actionKey → 前端 dispatch）。返回退订函数。 */
  onMenuAction: (cb: (key: string) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, key: string): void => cb(key)
    ipcRenderer.on('desktop:menu-action', handler)
    return () => {
      ipcRenderer.removeListener('desktop:menu-action', handler)
    }
  },
  /** 进入/退出窗口原生全屏（专注模式驱动；HTML5 Fullscreen API 无手势会被拒，走主进程无此限制）。 */
  setFullScreen: (flag: boolean): Promise<void> => ipcRenderer.invoke('desktop:set-fullscreen', flag),
  /** 运行时更新 win 窗控 overlay 颜色（主题切换驱动；非 win 主进程 no-op）。
   *  dark 额外同步 nativeTheme.themeSource——overlay 透明后按钮底色由系统按主题绘制。
   * 清偿-titlebar注解对齐：对齐 desktop.d.ts 正本（2--④）
   *  ——main 侧颜色白名单外回 {ok:false,reason}（openLibrary 失败信封同款）；成功/非 win
   *  路径无返回值（undefined），如实标 void、不虚构 {ok:true} 态。 */
  setTitleBarOverlay: (o: {
    color?: string
    symbolColor?: string
    dark?: boolean
  }): Promise<{ ok: false; reason: string } | void> => ipcRenderer.invoke('desktop:set-titlebar-overlay', o),
  /** 订阅窗口全屏态变化（系统手势退出全屏时回调 false）。返回退订函数。 */
  onFullScreenChange: (cb: (fullscreen: boolean) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, fullscreen: boolean): void => cb(fullscreen)
    ipcRenderer.on('desktop:fullscreen-change', handler)
    return () => {
      ipcRenderer.removeListener('desktop:fullscreen-change', handler)
    }
  },
  /** 订阅「写作服务已自动重启/自愈成功」广播（-3：child 进程换代后渲染层
   *  sse.resync 主动重连续用钉住端口；参数=恢复的端口）。返回退订函数。 */
  onServerRestarted: (cb: (port: number) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, port: number): void => cb(port)
    ipcRenderer.on('desktop:server-restarted', handler)
    return () => {
      ipcRenderer.removeListener('desktop:server-restarted', handler)
    }
  },
  /** 弹出原生右键菜单（macOS 原生外观）；选择时回调收到 key，取消收到 null。
   * （低级）：连开第二份菜单前摘掉上一份的 pending once 监听——channel 是
   *  窗口级广播，残留监听会收到新菜单的选择串到旧回调（首条消息双投递） */
  showContextMenu: (items: Array<Record<string, unknown>>, cb: (key: string | null) => void): void => {
    clearPendingMenuSelect() // 复用清场（摘旧 + 置空），行为同原内联摘除
    const handler = (_e: IpcRendererEvent, key: string | null): void => {
      pendingMenuSelect = null
      cb(key)
    }
    pendingMenuSelect = handler
    ipcRenderer.once('desktop:context-menu-select', handler)
    ipcRenderer.send('desktop:context-menu', items)
  },
})
