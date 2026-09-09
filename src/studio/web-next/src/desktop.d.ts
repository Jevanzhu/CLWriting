// Electron 桌面版 preload 注入的全局 API（src/desktop/preload.ts）。
// 浏览器版无此脚本 → window.clwritingDesktop 不存在 → 用前判空降级。
export {}

declare global {
  interface Window {
    clwritingDesktop?: {
      /** 渲染进程平台标识（win 窗控 overlay 避让等平台分支用） */
      platform: string
      /** 重评-P3-9（2026-09-09 全量代码重评）：失败面与 main 侧契约对称——canceled=用户
       *  取消；reason=落库失败（切库链 switchLibrary 同款信封） */
      openLibrary: () => Promise<{ ok: true } | { ok: false; canceled: true } | { ok: false; reason: string }>
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
      /** 运行时更新 win 窗控 overlay 颜色（主题切换驱动；非 win no-op）。
       *  dark 同步系统 nativeTheme（overlay 透明后按钮底色由系统按主题绘制）。
       *  重评2-P3-④（2026-09-09 全量重评 GLM-5.3）：失败信封类型面对齐 main 侧实况
       *  ——颜色白名单外回 {ok:false,reason}（openLibrary 失败信封同款，重评-P3-9 先例）；
       *  成功路径 main 侧无返回值（undefined），如实标 void、不虚构 {ok:true} 态 */
      setTitleBarOverlay: (o: { color?: string; symbolColor?: string; dark?: boolean }) => Promise<{ ok: false; reason: string } | void>
      /** 订阅窗口全屏态变化（系统手势退出全屏时回调 false），返回退订函数 */
      onFullScreenChange: (cb: (fullscreen: boolean) => void) => () => void
      /** 订阅「写作服务已自动重启/自愈成功」广播（参数=恢复的钉住端口；渲染层
       *  sse.resync() 主动重连），返回退订函数 */
      onServerRestarted: (cb: (port: number) => void) => () => void
      /** 弹原生右键菜单（items=菜单项定义；cb=选择回调，取消收到 null）。
       *  重评2-P3-③（2026-09-09 全量重评 GLM-5.3）：key 实际可选——净化器仅在
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
