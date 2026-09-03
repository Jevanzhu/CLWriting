/**
 * R40-42（四十轮）：修饰键（Cmd/Ctrl）平台文案单源——tooltip 此前 5 处写死
 * ⌘S/⌘⇧F/⌘B/⌘,，win 桌面（platform='win32'）作者看到 mac 符号但实际按键是 Ctrl。
 * 平台源复用 usePlatform（composables/usePlatform.ts，clwritingDesktop.platform 单源）；
 * 本模块只做纯文案映射，EditorDocHead/TabBar/Ribbon×2/WorkspaceShell 的 :data-tip
 * 计算绑定共用。浏览器预览（platform=null）按 win 口径显示 Ctrl+（与 ContextMenu
 * R33-83「非 mac 一律 Ctrl+」口径一致）。
 */

/** 主修饰键文案：mac ⌘（无 + 号，mac 组合键惯例），其余 Ctrl+ */
export function modKeyLabel(platform: string | null | undefined): string {
  return platform === 'darwin' ? '⌘' : 'Ctrl+'
}

/** Shift 修饰键文案：mac ⇧，其余 Shift+ */
export function shiftKeyLabel(platform: string | null | undefined): string {
  return platform === 'darwin' ? '⇧' : 'Shift+'
}

/**
 * 组合键平台文案：'Mod+S' → mac '⌘S' / win·浏览器 'Ctrl+S'；'Mod+Shift+F' →
 * '⌘⇧F' / 'Ctrl+Shift+F'。输入用 Mod 而非 CmdOrCtrl（语义归一），仅覆盖 tooltip
 * 用到的 Mod/Shift 两段；其余片段（字母/逗号）原样保留。
 */
export function modComboLabel(combo: string, platform: string | null | undefined): string {
  return combo.replace(/Mod\+/g, modKeyLabel(platform)).replace(/Shift\+/g, shiftKeyLabel(platform))
}
