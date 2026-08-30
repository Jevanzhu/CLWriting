/**
 * localStorage 键单一事实源（R28-3（二十八轮）新建）：
 * 同一枚键的写入方（组件）与清除方（composable/测试）必须同源拼键——
 * 此前章节树首开标记在 ChapterTreePanel 写作点号前缀、useShelf 删书清扫
 * 却硬编码冒号形态，键名断裂致标记永远清不掉（R27-79 目标落空一半），
 * 收敛到本模块杜绝再分叉。
 */

/** R26-74（二十六轮）：章节树首开标记键前缀（点号形态，落盘格式不再变更） */
export const TREE_FIRST_OPEN_KEY_PREFIX = 'clw2.tree-first-open.'

/** 拼某书的章节树首开标记完整键（写入 / 读取 / 删除共用） */
export function treeFirstOpenKey(book: string): string {
  return TREE_FIRST_OPEN_KEY_PREFIX + book
}
