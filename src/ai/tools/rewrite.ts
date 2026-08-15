/**
 * 改写工具：rewrite_chapter（整章）/ rewrite_selection（选段）。
 * 遵循现有提案模型：产出改写稿回填对话，不直接落盘正文（作者确认后再保存）。
 * 复用 buildRewritePrompt + REWRITE_SPEC（与 rewrite 端点同一链路）。
 */
import { runSpec } from '../tasks/spec.js'
import { REWRITE_SPEC } from '../tasks/specs.js'
import { buildRewritePrompt, lineDiff } from '../../process/rewrite-prompt.js'
import { readKind } from '../../format/kind.js'
import { readChapterBody } from './shared.js'
import type { ToolContext, ToolResult } from './context.js'

/** 跑一次 writer 改写（与 rewrite 端点 runRewriter 同口径：tool_use 产出 → input.正文，降级 text）。
 *  Z-P1-1：ctx.signal（chat 编排级中断）传入 runSpec——作者中断对话后嵌套改写生成同步中止，
 *  不再跑到 runTask 10 分钟总超时白烧 token（非 chat 调用点无 signal，行为不变）。 */
async function runRewriter(
  ctx: ToolContext,
  prompt: string,
): Promise<{ ok: true; produced: string } | { ok: false; error: string }> {
  const out = await runSpec(REWRITE_SPEC, {
    userDataPath: ctx.userDataPath,
    bookRoot: ctx.bookRoot,
    userPrompt: prompt,
    signal: ctx.signal,
  })
  if (!out.ok) return { ok: false, error: out.error }
  const { input, text } = out.data
  if (input && typeof input === 'object') {
    const produced = String((input as Record<string, unknown>)['正文'] ?? '').trim()
    if (produced) return { ok: true, produced }
  }
  if (text.trim()) return { ok: true, produced: text.trim() }
  return { ok: false, error: 'writer 产出为空' }
}

function chapterInput(input: Record<string, unknown>): number | null {
  const chapter = Number(input['chapter'])
  return Number.isInteger(chapter) && chapter >= 1 ? chapter : null
}

export async function rewriteChapter(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const chapter = chapterInput(input)
  if (chapter === null) return { ok: false, summary: '缺少合法的章号 chapter（正整数）。' }
  const instruction = String(input['instruction'] ?? '').trim()
  if (!instruction) return { ok: false, summary: '缺少改写指令 instruction。' }
  const body = readChapterBody(ctx.bookRoot, chapter)
  if (body === null) return { ok: false, summary: '第 ' + chapter + ' 章正文不存在或解析失败。' }
  const kind = readKind(ctx.bookRoot)
  const prompt = buildRewritePrompt('whole', body, '', instruction, [], chapter, kind)
  const r = await runRewriter(ctx, prompt)
  if (!r.ok) return { ok: false, summary: '改写失败：' + r.error }
  const diff = lineDiff(body, r.produced)
  const changed = diff.filter((d) => d.type !== 'same').length
  const preview = r.produced.slice(0, 600) + (r.produced.length > 600 ? '\n……（全文共 ' + r.produced.length + ' 字）' : '')
  return {
    ok: true,
    summary: '第 ' + chapter + ' 章改写完成（' + changed + ' 行有改动）。新稿开头：\n\n' + preview + '\n\n【未保存】改写稿仅在对话中，确认满意后再说一声，我再落盘。'
  }
}

export async function rewriteSelection(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const chapter = chapterInput(input)
  if (chapter === null) return { ok: false, summary: '缺少合法的章号 chapter（正整数）。' }
  const selection = String(input['selection'] ?? '').trim()
  if (!selection) return { ok: false, summary: '缺少待改写选段 selection（正文中的原文）。' }
  const instruction = String(input['instruction'] ?? '').trim()
  if (!instruction) return { ok: false, summary: '缺少改写指令 instruction。' }
  const body = readChapterBody(ctx.bookRoot, chapter)
  if (body === null) return { ok: false, summary: '第 ' + chapter + ' 章正文不存在或解析失败。' }
  if (!body.includes(selection)) return { ok: false, summary: '选段未在第 ' + chapter + ' 章正文中找到（请提供完整原文片段）。' }
  const kind = readKind(ctx.bookRoot)
  const prompt = buildRewritePrompt('local', body, selection, instruction, [], chapter, kind)
  const r = await runRewriter(ctx, prompt)
  if (!r.ok) return { ok: false, summary: '改写失败：' + r.error }
  return {
    ok: true,
    summary: '选段改写完成：\n\n' + r.produced.slice(0, 600) + (r.produced.length > 600 ? '\n……（改写稿共 ' + r.produced.length + ' 字）' : '') + '\n\n【未保存】确认满意后再说一声，我再落盘。'
  }
}

