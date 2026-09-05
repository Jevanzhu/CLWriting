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

/** R30-26（三十轮）：开书对话·故事梗概草稿键前缀（冒号形态，落盘格式不变——
 *  此前写入方 OnboardPremise 与清除方 useShelf 各自硬编码同串，属 R28-3 修掉的
 *  「写入/清除键名断裂」同族隐患，收敛到本模块单一事实源杜绝再分叉） */
export const ONBOARD_PREMISE_KEY_PREFIX = 'clwriting:onboard-premise:'

/** 拼某书的开书梗概草稿完整键（写入 / 读取 / 删除共用） */
export function onboardPremiseKey(book: string): string {
  return ONBOARD_PREMISE_KEY_PREFIX + book
}

/** R48-83（四十八轮）：误报灰显键单源（原 check.ts 模块内 fpKey 收编）+ 段转义——
 *  书名/docId 含 `:` 时 `clw-fp:a:b` 段边界歧义，跨书键互相污染/误清（书名带冒号
 *  并非病态输入）。段内 `%`→`%25`、`:`→`%3A`（先转义 % 防二次解码歧义）；无此类
 *  字符的书产出键串与旧格式逐字相同，存量 localStorage 键零迁移。键只作相等/前缀
 *  比对，无解码侧。 */
function escFpSegment(s: string): string {
  return s.replace(/%/g, '%25').replace(/:/g, '%3A')
}

/** 拼某书某文档的误报灰显键（store 读写与删章清扫共用） */
export function falsePositiveKey(bookName: string, docId: string): string {
  return `clw-fp:${escFpSegment(bookName)}:${escFpSegment(docId)}`
}

/** 拼某书的误报灰显键前缀（删书清扫用——段转义后前缀匹配不串书） */
export function falsePositiveKeyPrefix(bookName: string): string {
  return `clw-fp:${escFpSegment(bookName)}:`
}
