// Electron 桌面版 preload 注入的全局 API（src/desktop/preload.ts）。
// 浏览器版无此脚本 → window.clwritingDesktop 不存在 → 用前判空降级。
// （isTrustedSender 拒绝路径 undefined 类型契约对账）：handleTrusted
// （src/desktop/ipc.ts）对 untrusted sender 静默返回 undefined——该拒绝态正常形态
// 不可达（三窗白名单恒过），本文件刻意不做全量 `| undefined` widen（牵连前端判空
// 面）。无值成功路径如实标 void 即天然吸收该 undefined（setTitleBarOverlay 先例）；
// 带值 channel（openLibrary/switchLibrary/getRecentLibraries/getCurrentLibrary/
// getSystemFonts）逐 channel 对照 ipc.ts handler 收窄为精确 union，勿再加宽。
export {}

declare global {
  interface Window {
    clwritingDesktop?: {
      /** 渲染进程平台标识（win 窗控 overlay 避让等平台分支用） */
      platform: string
      /** 失败面与 main 侧契约对称——canceled=用户
       *  取消；reason=落库失败（切库链 switchLibrary 同款信封） */
      openLibrary: () => Promise<{ ok: true } | { ok: false; canceled: true } | { ok: false; reason: string }>
      switchLibrary: (path: string) => Promise<{ ok: true } | { ok: false; reason: string }>
      /** 多库多窗·新窗入口：在新窗口中打开书库（spawn 新实例，本窗口不动）；失败信封同 switchLibrary */
      openLibraryInNewWindow: (path: string) => Promise<{ ok: true } | { ok: false; reason: string }>
      getRecentLibraries: () => Promise<{ path: string; label: string }[]>
      getCurrentLibrary: () => Promise<string | null>
      showInFolder: (bookName: string, relPath: string) => Promise<void>
      openBookDir: (bookName: string) => Promise<void>
      getSystemFonts: () => Promise<string[]>
      openShelf: () => Promise<void>
      openLibraryWindow: () => Promise<void>
      openLibraryDir: () => Promise<void>
      /** 阶段 53：用系统浏览器打开外部链接（更新提示面「去下载」用）。
       *  主进程侧白名单（仅本项目 GitHub 发布页）——白名单外/打开失败回 {ok:false,reason}
       *  （带值 channel 精确 union 口径，token 面 openLibrary 信封同款）。 */
      openExternal: (url: string) => Promise<{ ok: true } | { ok: false; reason: string }>
      /** 阶段 55：自更新能力闸（主进程按平台 + 打包态判定；渲染层不自行推平台结论）。
       *  canDownload = 应用内下载；canInstall = 换目录并重启（Windows 便携版专属）。 */
      updateCapability: () => Promise<{ canDownload: boolean; canInstall: boolean }>
      /** 阶段 55：下载便携包（进度经 onUpdateProgress 推送，返回值只给终态契约） */
      updateDownload: (version: string) => Promise<{ ok: true } | { ok: false; reason: string }>
      /** 阶段 55：取消在途下载（无在途时 no-op） */
      updateCancel: () => Promise<{ ok: true }>
      /** 阶段 55：带更新意图退出并重启；形态不支持/包未就绪等回 {ok:false,reason}（人话） */
      updateApply: (version: string) => Promise<{ ok: true } | { ok: false; reason: string }>
      /** 阶段 55：在文件管理器中显示已下载的更新包（成功路径 main 侧无返回值） */
      updateReveal: () => Promise<void>
      /** 阶段 55：订阅下载进度（total 为 null = 服务端未报总长），返回退订函数 */
      onUpdateProgress: (cb: (p: { received: number; total: number | null }) => void) => () => void
      /** 阶段 55：订阅「退出被取消、更新意图作废」，返回退订函数 */
      onUpdateApplyCancelled: (cb: () => void) => () => void
      openBook: (name: string) => Promise<void>
      /** 打开诊断包所在目录（设置 → 诊断入口；目录由主进程推导，未生成过包时静默
       *  返回——成功路径 main 侧无返回值，如实标 void、不虚构 {ok:true} 态） */
      revealDiagnostics: () => Promise<void>
      /** 订阅主窗口导航事件，返回退订函数 */
      onNavigate: (cb: (path: string) => void) => () => void
      /** 订阅系统菜单动作（菜单 click → actionKey 回调），返回退订函数 */
      onMenuAction: (cb: (key: string) => void) => () => void
      /** 进入/退出窗口原生全屏（专注模式驱动） */
      setFullScreen: (flag: boolean) => Promise<void>
      /** 运行时更新 win 窗控 overlay 颜色（主题切换驱动；非 win no-op）。
       *  dark 同步系统 nativeTheme（overlay 透明后按钮底色由系统按主题绘制）。
 * 失败信封类型面对齐 main 侧实况
 * ——颜色白名单外回 {ok:false,reason}（openLibrary 失败信封同款先例）；
       *  成功路径 main 侧无返回值（undefined），如实标 void、不虚构 {ok:true} 态 */
      setTitleBarOverlay: (o: { color?: string; symbolColor?: string; dark?: boolean }) => Promise<{ ok: false; reason: string } | void>
      /** 订阅窗口全屏态变化（系统手势退出全屏时回调 false），返回退订函数 */
      onFullScreenChange: (cb: (fullscreen: boolean) => void) => () => void
      /** 订阅「写作服务已自动重启/自愈成功」广播（参数=恢复的钉住端口；渲染层
       *  sse.resync() 主动重连），返回退订函数 */
      onServerRestarted: (cb: (port: number) => void) => () => void
      /** 弹原生右键菜单（items=菜单项定义；cb=选择回调，取消收到 null）。
 * key 实际可选——净化器仅在
       *  字符串非空时落 key（context-menu.ts），main 消费端 s.key ?? null 兜底；
       *  声明必填严于运行时，报齐为可选 */
      showContextMenu: (
        items: Array<{
          key?: string
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
