/**
 * lead_update：生成第 N 章账本推进（write，落盘 工作区/账本推进.md）。
 * 复用 generateLeadUpdateDraft（与自愈写稿共用）。
 */
import { generateLeadUpdateDraft } from '../../process/lead-update-draft.js'
import type { ToolContext, ToolResult } from './context.js'

export async function leadUpdate(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const chapter = Number(input['chapter'])
  if (!Number.isInteger(chapter) || chapter < 1) return { ok: false, summary: '缺少合法的章号 chapter（正整数）。' }
  // Z-P1-1：chat 编排级中断信号透传——作者中断对话后账本草稿生成同步中止
  const r = await generateLeadUpdateDraft(ctx.bookRoot, chapter, ctx.userDataPath, ctx.signal)
  if (!r.ok) return { ok: false, summary: r.error }
  return { ok: true, summary: '已生成第 ' + chapter + ' 章账本推进（' + r.count + ' 条履历）。' }
}

