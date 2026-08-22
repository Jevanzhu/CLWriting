/**
 * 改写工具：rewrite_chapter（整章）/ rewrite_selection（选段）/ apply_spill（确认落盘）。
 * 遵循现有提案模型：产出改写稿回填对话，不直接落盘正文（作者确认后再保存）；
 * 全文 spill 暂存（RB-AI-P1-1）——确认保存时按 spill 路径取回全文（apply_spill，
 * GG-P2-2 兑现「确认后落盘」承诺：write 级确认闸 → 按 locator 取回全文存为章草稿）。
 * 复用 buildRewritePrompt + REWRITE_SPEC（与 rewrite 端点同一链路）。
 */
import { runSpec } from '../tasks/spec.js'
import { REWRITE_SPEC } from '../tasks/specs.js'
import { buildRewritePrompt, lineDiff } from '../../process/rewrite-prompt.js'
import { readKind } from '../../format/kind.js'
import { readBookConfig } from '../../format/yaml.js'
import { applyGlobalDefaults } from '../../format/global-defaults.js'
import { writeSpillFile, readSpillFile } from '../../process/spill.js'
import { saveDraft } from '../../process/draft-pipeline.js'
import { resolveDraftPath } from '../../format/draft.js'
import { readFile, joinFrontMatter } from '../../format/frontmatter.js'
import { join } from 'node:path'
import { readChapterBody } from './shared.js'
import type { ToolContext, ToolResult } from './context.js'

/** 整章重写的字数目标（书级 book.yaml → global.json → 硬编码，与首稿链同口径）。
 *  读失败回落 undefined → wordRange 硬编码区间（与 readKind 的容错风格一致）。 */
function chapterTargetWords(ctx: ToolContext): number | undefined {
  try {
    const r = readBookConfig(join(ctx.bookRoot, 'book.yaml'))
    return applyGlobalDefaults(r.config, ctx.userDataPath).book.chapter_target_words
  } catch {
    return undefined
  }
}

/** 跑一次 writer 改写（与 rewrite 端点 runRewriter 同口径：tool_use 产出 → input.正文，降级 text）。
 *  Z-P1-1：ctx.signal（chat 编排级中断）传入 runSpec——作者中断对话后嵌套改写生成同步中止，
 *  不再跑到 runTask 10 分钟总超时白烧 token（非 chat 调用点无 signal，行为不变）。
 *  P3-8：chapter 透传 runSpec → runTask 的 chapter 记账块——对话里 AI rewrite 的
 *  token 用量归集到本章预算账（与 write_chapter 同口径，章预算熔断不再被 rewrite 绕过）。 */
async function runRewriter(
  ctx: ToolContext,
  prompt: string,
  chapter: number,
): Promise<{ ok: true; produced: string } | { ok: false; error: string }> {
  const out = await runSpec(REWRITE_SPEC, {
    userDataPath: ctx.userDataPath,
    bookRoot: ctx.bookRoot,
    chapter,
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

/** RB-AI-P1-1：「未保存」提示——全文已 spill 时给出路径 + 字数（确认保存按路径取全文）；
 *  落盘失败 best-effort 如实告知（不谎称可落盘）。GG-P2-2：确认通道 = apply_spill 工具（write 级确认闸）。 */
function unsavedNote(locator: string | null, chars: number): string {
  return locator
    ? '【未保存】改写稿全文（' + chars + ' 字）已暂存：' + locator + '。确认满意后说一声，我调 apply_spill 按此路径落盘为章草稿。'
    : '【未保存】改写稿全文暂存失败（磁盘异常），目前仅对话内有预览。'
}

/** GG-P2-2：把已确认的改写 spill 落盘为章草稿（保留原章 front matter，只替换正文）。
 *  读侧走 spill.ts 的 readSpillFile（形状校验 + isWithinRoot 双保险，null = 不存在/不合法）。 */
export async function applySpill(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const chapter = chapterInput(input)
  if (chapter === null) return { ok: false, summary: '缺少合法的章号 chapter（正整数）。' }
  const locator = String(input['locator'] ?? '').trim()
  if (!locator) return { ok: false, summary: '缺少暂存路径 locator（改写结果返回的 工作区/spills/<哈希>.md）。' }
  const produced = readSpillFile(ctx.bookRoot, locator)?.trim()
  if (!produced) {
    return { ok: false, summary: '暂存不可用：' + locator + '（不存在或路径不合法，可能已清理——请重新发起改写）。' }
  }
  // 章正文须存在（改写的前提）；定稿章由 saveDraft 的 resolveDraftPath 挡（V-P1-3 同口径）
  if (readChapterBody(ctx.bookRoot, chapter) === null) {
    return { ok: false, summary: '第 ' + chapter + ' 章正文不存在或解析失败。' }
  }
  const { relPath } = resolveDraftPath(ctx.bookRoot, chapter)
  const raw = readFile(join(ctx.bookRoot, relPath))
  if (!raw.ok) return { ok: false, summary: '第 ' + chapter + ' 章正文读取失败：' + relPath }
  // 改写稿是 body 维度产物——front matter（章号/标题/钩子等）原样保留，只换正文
  const saved = saveDraft(ctx.bookRoot, chapter, joinFrontMatter(raw.fmRaw, produced), { snapshotOrigin: 'chat-rewrite' })
  return {
    ok: true,
    summary: '已落盘：' + saved.relPath + '（' + saved.words + ' 字，改写前的旧稿已自动快照）。暂存原文保留在 ' + locator + ' 备查。',
  }
}

export async function rewriteChapter(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const chapter = chapterInput(input)
  if (chapter === null) return { ok: false, summary: '缺少合法的章号 chapter（正整数）。' }
  const instruction = String(input['instruction'] ?? '').trim()
  if (!instruction) return { ok: false, summary: '缺少改写指令 instruction。' }
  const body = readChapterBody(ctx.bookRoot, chapter)
  if (body === null) return { ok: false, summary: '第 ' + chapter + ' 章正文不存在或解析失败。' }
  const kind = readKind(ctx.bookRoot)
  const prompt = buildRewritePrompt('whole', body, '', instruction, [], chapter, kind, undefined, chapterTargetWords(ctx))
  const r = await runRewriter(ctx, prompt, chapter)
  if (!r.ok) return { ok: false, summary: '改写失败：' + r.error }
  const diff = lineDiff(body, r.produced)
  const changed = diff.filter((d) => d.type !== 'same').length
  const preview = r.produced.slice(0, 600) + (r.produced.length > 600 ? '\n……（全文共 ' + r.produced.length + ' 字）' : '')
  // RB-AI-P1-1：全文落 spill（工作区/spills/<内容哈希>.md，幂等）——此前全文不落盘不 spill，
  // 「确认满意后再说一声，我再落盘」物理不可兑现（预览外内容已丢失）；落盘后按路径可取回全文
  const locator = writeSpillFile(ctx.bookRoot, r.produced)
  return {
    ok: true,
    summary:
      '第 ' + chapter + ' 章改写完成（' + changed + ' 行有改动）。新稿开头：\n\n' + preview + '\n\n' + unsavedNote(locator, r.produced.length)
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
  // 第九轮 H-1：显式定位选区 + 唯一性校验（与 rewrite 端点 X-P2-13 同口径）——
  // local prompt 只产出选段新文本，确认落盘必须拼回全文；否则 apply_spill 会用选段稿整体替换整章正文
  const selStart = body.indexOf(selection)
  if (selStart < 0) return { ok: false, summary: '选段未在第 ' + chapter + ' 章正文中找到（请提供完整原文片段）。' }
  if (body.indexOf(selection, selStart + 1) >= 0) {
    return { ok: false, summary: '选段在第 ' + chapter + ' 章正文中出现多次，无法定位（请扩大选区带上前后文再试）。' }
  }
  const kind = readKind(ctx.bookRoot)
  const prompt = buildRewritePrompt('local', body, selection, instruction, [], chapter, kind)
  const r = await runRewriter(ctx, prompt, chapter)
  if (!r.ok) return { ok: false, summary: '改写失败：' + r.error }
  // 选段稿拼回全文（保留选区外首尾），spill/落盘均为整章维度——与端点 local 模式同语义
  const rewritten = body.slice(0, selStart) + r.produced + body.slice(selStart + selection.length)
  // RB-AI-P1-1：同 rewrite_chapter——改写后全文落 spill，确认保存按路径取回
  const locator = writeSpillFile(ctx.bookRoot, rewritten)
  return {
    ok: true,
    summary:
      '选段改写完成：\n\n' +
      r.produced.slice(0, 600) +
      (r.produced.length > 600 ? '\n……（改写稿共 ' + r.produced.length + ' 字）' : '') +
      '\n\n' +
      unsavedNote(locator, rewritten.length)
  }
}

