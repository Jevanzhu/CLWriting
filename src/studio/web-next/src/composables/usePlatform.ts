// 统一平台判断（J5，2026-08-31）：把散落的 `hasDesktop = !!window.clwritingDesktop`
// 收敛为平台感知。区分三态：浏览器（无 clwritingDesktop）、桌面 mac（darwin）、
// 桌面 win（win32 等）。UI 主体不受影响，仅平台相关的渲染适配走这套判断。
//
// 语义要点（与旧 hasDesktop 的区别）：
// - 旧 hasDesktop =「桌面或浏览器」两态，`has-traffic`/`avoid-traffic` 用它触发
//   左侧 52px 交通灯避让，win/mac 混用（win 无左上角红绿灯，属误避让）。
// - 新 isMac（darwin）才是红绿灯语义的正确来源：mac 左上角真有红绿灯，需要 52px
//   左侧避让；win 的红绿灯是右上角 WCO（由 env(titlebar-area-*) 避让），左侧不需要。
// - isWin 供 win 专属优化（WCO 避让、密度/字号套）。

export interface PlatformInfo {
  /** 是否运行在 Electron 桌面（vs 浏览器预览） */
  isDesktop: boolean
  /** 主进程 platform：'darwin'|'win32'|…；浏览器为 null */
  platform: string | null
  /** mac 桌面（红绿灯在左上角，左侧需要交通灯避让） */
  isMac: boolean
  /** win 桌面（右上角 WCO 窗控，左侧无需红绿灯避让） */
  isWin: boolean
}

const platform = typeof window !== 'undefined' && window.clwritingDesktop?.platform
  ? window.clwritingDesktop.platform
  : null

export function usePlatform(): PlatformInfo {
  return {
    isDesktop: platform !== null,
    platform,
    isMac: platform === 'darwin',
    isWin: platform === 'win32',
  }
}