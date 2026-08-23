/**
 * 全屏桥（专注模式驱动）：Electron 走 IPC 原生 setFullScreen，浏览器/dev 降级
 * HTML5 Fullscreen API，测试环境（happy-dom，两者皆缺）全部 no-op。
 *
 * 为什么不用纯 HTML5 API：菜单加速键（⌘⇧F）经主进程转发到渲染层时无用户手势，
 * requestFullscreen 会被 Chromium 拒绝；主进程 setFullScreen 无手势限制。
 */

/** 进入/退出全屏。失败静默（专注模式的 UI 隐藏态不依赖全屏成功）。 */
export function setFullScreen(on: boolean): void {
  const bridge = window.clwritingDesktop
  if (bridge?.setFullScreen) {
    void bridge.setFullScreen(on).catch(() => {})
    return
  }
  const doc = document
  if (on) {
    if (typeof doc.documentElement.requestFullscreen === 'function' && !doc.fullscreenElement) {
      void doc.documentElement.requestFullscreen().catch(() => {})
    }
  } else if (doc.fullscreenElement && typeof doc.exitFullscreen === 'function') {
    void doc.exitFullscreen().catch(() => {})
  }
}

/** 订阅全屏态变化（系统手势退出全屏 → cb(false)）。返回退订函数。 */
export function onFullScreenChange(cb: (on: boolean) => void): () => void {
  const bridge = window.clwritingDesktop
  if (bridge?.onFullScreenChange) return bridge.onFullScreenChange(cb)
  if (typeof document.addEventListener === 'function') {
    const handler = (): void => cb(document.fullscreenElement != null)
    document.addEventListener('fullscreenchange', handler)
    return () => {
      document.removeEventListener('fullscreenchange', handler)
    }
  }
  return () => {}
}
