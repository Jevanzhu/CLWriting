/**
 * 书库选择/切换 IPC 交互单点化（复审-0914-优化 E7，2026-09-14 修复批）。
 *
 * Welcome.vue 与 Library.vue 此前各自近逐行维护 chooseLibrary / switchTo（P5-前端
 * 捕获、P3-9 reason toast、P3-3 返回值吞没、R0912-3 #21 交互失败不顶列表——四轮
 * 修复在两页重复落地，已漂移过一次：Welcome 的取错是内联三元，Library 是
 * friendlyError 归类）。本 composable 收编两函数，历史行为差异经注入保真：
 * - formatError：Welcome 传 rawErrorMessage（原样透出，历史口径）；Library 传
 *   friendlyError（TECH_PATTERNS 归类，历史口径）。
 * - currentPath：Library 特有「切到当前书库 no-op」短路；Welcome 无 current 态不传。
 */
import { useUiStore } from '../stores/ui'

export interface UseLibraryIpcOptions {
  /** 错误 → toast 文案（两页历史口径差异注入点，见头注） */
  formatError: (e: unknown) => string
  /** 当前书库路径 getter：提供后 switchTo 对同路径 no-op（Library 口径） */
  currentPath?: () => string | null
}

export function useLibraryIpc(options: UseLibraryIpcOptions): {
  chooseLibrary: () => Promise<void>
  switchTo: (path: string) => Promise<void>
} {
  const ui = useUiStore()

  // 新建 / 打开共用同一 IPC：pickLibrary 融合逻辑（是书库→直接用；空目录→问是否新建）。
  // P5-前端（第七轮）：交互路径 IPC 捕获（原先 unhandled rejection 零反馈）。
  async function chooseLibrary(): Promise<void> {
    try {
      // P3-9（2026-09-09 全量代码重评）：openLibrary 落库失败返回 {ok:false,reason}
      // （此前类型面缺失该变体、返回值被静默吞）——reason 失败就地 toast 交代（用户
      // 取消 canceled 维持静默），对齐 switchLibrary 的 P3-3 处理写法
      const r = await window.clwritingDesktop?.openLibrary()
      if (r && !r.ok && 'reason' in r) ui.toast(r.reason, 'error')
    } catch (e) {
      // R0912-3 #21：交互失败改 toast——原先写 loadError 顶掉已加载信息（loadError 双职）
      ui.toast(options.formatError(e), 'error')
    }
  }

  // 切换到最近列表中的书库 → relaunch
  async function switchTo(path: string): Promise<void> {
    if (options.currentPath && path === options.currentPath()) return
    try {
      const r = await window.clwritingDesktop?.switchLibrary(path)
      // P3-3（评审补修）：switchLibrary 返回 {ok:false, reason}（大小写敏感卷警告选「换个
      // 目录」等）此前只 catch 抛错、返回值被静默吞掉——取消原因就地 toast 交代
      if (r && !r.ok) ui.toast(r.reason, 'error')
    } catch (e) {
      // R0912-3 #21：同 chooseLibrary——交互失败不再顶掉已加载信息
      ui.toast(options.formatError(e), 'error')
    }
  }

  return { chooseLibrary, switchTo }
}
