/**
 * agent 工具执行注册表（工具面扩展全量）。
 * chat.ts 的 executeChatTool 按 call.name 分派；read_chapter 由批次 C 落地（B3 spill 取回），
 * 不在本注册表——executeChatTool 已有分支。
 */
import type { ToolExecutor } from './context.js'
import { bookSearch } from './search.js'
import { chapterStatus } from './status.js'
import { moveChapter, renameChapter, copyChapter, deleteChapter } from './tree.js'
import { rewriteChapter, rewriteSelection } from './rewrite.js'
import { leadUpdate } from './leads.js'
import { harvestStyle } from './style.js'

export type { ToolContext, ToolResult, ToolExecutor } from './context.js'

export const TOOL_EXECUTORS: Record<string, ToolExecutor> = {
  book_search: bookSearch,
  chapter_status: chapterStatus,
  move_chapter: moveChapter,
  rename_chapter: renameChapter,
  copy_chapter: copyChapter,
  delete_chapter: deleteChapter,
  rewrite_chapter: rewriteChapter,
  rewrite_selection: rewriteSelection,
  lead_update: leadUpdate,
  harvest_style: harvestStyle,
}

