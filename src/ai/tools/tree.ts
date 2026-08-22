/**
 * 结构写操作工具：move/rename/copy/delete_chapter（write，确认闸由调用方执行）。
 * 复用 DocumentService（与 documents API 同一服务层），操作边界由服务层既有防护保证。
 */
import { join, dirname, basename } from 'node:path'
import { DocumentService } from '../../document/service.js'
import { readChapterDir } from '../../format/chapters.js'
import { chapterToDocId, relFromBookRoot } from './shared.js'
import type { ToolContext, ToolResult } from './context.js'

/** 查章正文相对路径（不存在返回 null）。 */
function findChapterRel(ctx: ToolContext, chapter: number): string | null {
  const { chapters } = readChapterDir(join(ctx.bookRoot, '写作', '正文'))
  const hit = chapters.find((c) => c.章号 === chapter)
  if (!hit?._path) return null
  return relFromBookRoot(ctx.bookRoot, hit._path)
}

/** 标题净化（与 resolveDraftPath 同口径：路径分隔符/空字符替换为 _）。 */
function sanitizeTitle(title: string): string {
  return title.replace(/[\\/\0]/g, '_')
}

/** 校验章号入参；非法返回错误摘要。 */
function chapterInput(input: Record<string, unknown>): number | null {
  const chapter = Number(input['chapter'])
  return Number.isInteger(chapter) && chapter >= 1 ? chapter : null
}

export async function moveChapter(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const chapter = chapterInput(input)
  if (chapter === null) return { ok: false, summary: '缺少合法的章号 chapter（正整数）。' }
  const toDir = String(input['toDir'] ?? '').trim()
  if (!toDir) return { ok: false, summary: '缺少目标目录 toDir（相对书根，如 写作/正文/第二卷）。' }
  const docId = chapterToDocId(ctx.bookRoot, chapter)
  if (!docId) return { ok: false, summary: '第 ' + chapter + ' 章正文不存在，无法移动。' }
  const r = await new DocumentService({ bookRoot: ctx.bookRoot }).moveDocument({ docId, toDir })
  if (!r.ok) return { ok: false, summary: '移动失败：' + r.reason }
  return { ok: true, summary: '已把第 ' + chapter + ' 章移动到 ' + toDir + '（新路径 ' + r.path + '）。' }
}

export async function renameChapter(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const chapter = chapterInput(input)
  if (chapter === null) return { ok: false, summary: '缺少合法的章号 chapter（正整数）。' }
  const newTitle = String(input['newTitle'] ?? '').trim()
  if (!newTitle) return { ok: false, summary: '缺少新标题 newTitle。' }
  const relPath = findChapterRel(ctx, chapter)
  if (!relPath) return { ok: false, summary: '第 ' + chapter + ' 章正文不存在，无法重命名。' }
  const oldName = basename(relPath)
  const prefix = oldName.split('-')[0] ?? ''
  const newName = prefix + '-' + sanitizeTitle(newTitle) + '.md'
  const docId = chapterToDocId(ctx.bookRoot, chapter)
  if (!docId) return { ok: false, summary: '第 ' + chapter + ' 章清单登记缺失，无法重命名。' }
  const r = await new DocumentService({ bookRoot: ctx.bookRoot }).renameDocument({ docId, newName })
  if (!r.ok) return { ok: false, summary: '重命名失败：' + r.reason }
  return { ok: true, summary: '已把第 ' + chapter + ' 章重命名为「' + newTitle + '」（新路径 ' + r.path + '）。' }
}

export async function copyChapter(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const chapter = chapterInput(input)
  if (chapter === null) return { ok: false, summary: '缺少合法的章号 chapter（正整数）。' }
  const relPath = findChapterRel(ctx, chapter)
  if (!relPath) return { ok: false, summary: '第 ' + chapter + ' 章正文不存在，无法复制。' }
  const oldName = basename(relPath)
  // 低-6（第十轮）：文件名派生先剥 .md 再拼「 副本」后缀——对齐前端复制的
  // `<名> 副本.md` 惯例（useChapterTreeActions 同款）。原先按 split('-')[0] 取前缀再拼，
  // 无连字符章文件名（如「番外.md」，front matter 带章号即合法）会把整个文件名当前缀，
  // 产出「番外.md- 副本.md」双 .md 畸形名；常规 `0001-标题.md` 产物不变。
  const stem = oldName.endsWith('.md') ? oldName.slice(0, -'.md'.length) : oldName
  const newName = stem + ' 副本.md'
  const targetRel = dirname(relPath) === '.' ? newName : dirname(relPath) + '/' + newName
  const docId = chapterToDocId(ctx.bookRoot, chapter)
  if (!docId) return { ok: false, summary: '第 ' + chapter + ' 章清单登记缺失，无法复制。' }
  const r = await new DocumentService({ bookRoot: ctx.bookRoot }).copyDocument({ docId, relPath: targetRel })
  if (!r.ok) return { ok: false, summary: '复制失败：' + r.reason }
  return { ok: true, summary: '已复制第 ' + chapter + ' 章为副本（新路径 ' + r.path + '）。' }
}

export async function deleteChapter(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const chapter = chapterInput(input)
  if (chapter === null) return { ok: false, summary: '缺少合法的章号 chapter（正整数）。' }
  const docId = chapterToDocId(ctx.bookRoot, chapter)
  if (!docId) return { ok: false, summary: '第 ' + chapter + ' 章正文不存在，无法删除。' }
  const r = await new DocumentService({ bookRoot: ctx.bookRoot }).trashDocument({ docId })
  if (!r.ok) return { ok: false, summary: '删除失败：' + r.reason }
  return { ok: true, summary: '已把第 ' + chapter + ' 章移入回收站（可还原）。' }
}

