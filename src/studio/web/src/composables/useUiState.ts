// 全局 UI 态（专注/折叠/详情面板/设置面板）：模块单例，AppShell 与 CommandPalette 共享。
// focus 仅编辑态生效（AppShell isFocus computed 限制 mode==='edit'）；toggleFocus 带 mode 校验给 hint。
import { ref } from 'vue'
import { useHint } from './useHint'

export type ShellMode = 'overview' | 'edit' | 'workbench'

const focus = ref(false)
const foldL = ref(false)
const panelOpen = ref(true)
const settingsOpen = ref(false)

export function useUiState() {
  const { hint } = useHint()

  /** ⤢ 专注：折叠左右栏（仅编辑态；编辑框独占） */
  function toggleFocus(mode?: ShellMode): void {
    if (mode && mode !== 'edit') {
      hint('专注模式仅编辑态可用')
      return
    }
    focus.value = !focus.value
    hint(focus.value ? '专注模式 · 编辑框独占（再按 ⤢ 或 ⌘⇧F 退出）' : '已退出专注')
  }

  /** ⌘B 折叠左栏 */
  function toggleFoldL(): void {
    foldL.value = !foldL.value
    hint(foldL.value ? '已折叠侧栏' : '已展开侧栏')
  }

  /** ◧ 详情面板（右栏）开关 */
  function togglePanel(): void {
    panelOpen.value = !panelOpen.value
    hint(panelOpen.value ? '已展开详情面板' : '已收起详情面板')
  }

  /** ⚙ 打开设置面板 */
  function openSettings(): void {
    settingsOpen.value = true
  }

  return { focus, foldL, panelOpen, settingsOpen, toggleFocus, toggleFoldL, togglePanel, openSettings }
}
