/**
 * 编辑器 AI 辅助动作（巨石批 7b 拆分自 EditorView）：扩写/缩写/润色/续写指令表 + 执行器。
 * 顶栏按钮组（EditorDocHead）与右键菜单 AI 子菜单（EditorView）双消费，单一真相源。
 */
import { useDocStore } from '../stores/doc'
import { useWorkspaceStore } from '../stores/workspace'
import { useUiStore } from '../stores/ui'
import { useRewriteStore } from '../stores/rewrite'

const AI_ACTIONS = [
  { key: 'expand', label: '扩写', instruction: '扩写选中段落，增加场景细节、感官描写和角色心理活动' },
  { key: 'condense', label: '缩写', instruction: '压缩选中段落，去掉冗余对话和描写，保留核心信息和情节走向' },
  { key: 'polish', label: '润色', instruction: '润色选中段落的文风和用词，提升文学性，不改变情节走向' },
  { key: 'continue', label: '续写', instruction: '保留原文不变，在后面续写200-500字，延续当前风格和情节' },
] as const

export function useAiAssist() {
  const doc = useDocStore()
  const ws = useWorkspaceStore()
  const ui = useUiStore()
  const rewrite = useRewriteStore()

  async function runAiAssist(action: { key: string; instruction: string }): Promise<void> {
    const sel = ws.editorGetSelection?.() ?? ''
    // M2 续写解选区：无选区的续写走 append（空白页/卡壳时刻）；其余动作仍需选区靶点
    const isAppend = action.key === 'continue' && !sel
    if (!sel && !isAppend) {
      ui.toast('请先选中要操作的文字', 'info')
      return
    }
    if (!ws.activeDocId || !doc.bookName) return
    ws.setRightTab('review')
    await rewrite.run(doc.bookName, ws.activeDocId, action.instruction, sel, isAppend)
  }

  return { aiActions: AI_ACTIONS, runAiAssist }
}
