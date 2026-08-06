/**
 * draft 落盘端点(C.1 + 短篇轮1):driver writer 产出 → 写作/草稿/草稿-<N>.md。
 *
 * POST /api/books/:name/draft-save  body {chapter, content}
 *   → 长篇 写作/草稿/草稿-<chapter>.md;短篇 写作/草稿/草稿-1.md(候选序号)→ {ok, path, words}
 * GET  /api/books/:name/draft-prompt?chapter=N
 *   → 组 prompt(长篇:细纲+备料+章 front matter;短篇:细纲+篇 front matter)→ {prompt}
 *
 * 草稿区是 driver 落盘区(非手编);前端收集 driver text 流(done 后)调此落盘。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, basename } from 'node:path'
import { mkdirSync, existsSync, readFileSync } from 'node:fs'
import { atomicWriteFile } from '../../../fs/atomic.js'
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readKind } from '../book-context.js'
import { readChapterDir } from '../../../format/chapters.js'
import { buildSettingsContext } from './settings.js'
import { readManifest } from '../../../document/manifest.js'
import { writeSnapshot } from '../../../document/snapshot.js'
import { legacyId } from '../../../document/stable-id.js'
import { invalidateTreeIndex } from '../../../document/tree.js'
import { recordAiVersion } from '../../../git/ai-track.js'
import { recordAuthorSignal } from '../../../ai/author-signal.js'

interface DraftCtx {
  workDir: string | null
}

/**
 * M1 草稿覆写留底：目标已存在且内容不同 → force 快照（origin 缺省 draft-overwrite）。
 * docId 反查文档清单（与编辑器历史同目录，作者可从本章历史恢复）；
 * 未登记回落文件名派生键（草稿-N）。快照失败不阻断落盘（留底是护栏，不是门禁）。
 * 返回快照 id（null = 无需留底或留底失败）。
 */
export function snapshotBeforeOverwrite(
  bookRoot: string,
  relPath: string,
  newContent: string,
  origin = 'draft-overwrite',
): string | null {
  const absPath = join(bookRoot, relPath)
  if (!existsSync(absPath)) return null
  let old: string
  try {
    old = readFileSync(absPath, 'utf8')
  } catch {
    return null
  }
  if (old === newContent) return null
  // docId：清单反查（编辑器保存的快照同目录）→ 未登记按文件名派生
  let docId: string | undefined
  const manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  for (const e of manifest.entries.values()) {
    if (e.path === relPath) {
      docId = e.id
      break
    }
  }
  if (!docId) docId = basename(relPath, '.md')
  try {
    return writeSnapshot(join(bookRoot, '工作区', '.snapshots'), docId, old, { origin }, { force: true })
  } catch {
    return null
  }
}

/**
 * 草稿落盘全套副作用（/draft-save 端点与全自动写章闭环 self-heal.ts 共用）：
 * 覆写留底 → mkdir → 写盘 → 失效树缓存 → docId 反查 → AI 改稿轨迹。
 *
 * 闭环中间轮传 `recordAi:false`——中间稿不是作者会手改的对象，
 * 记进文风轨迹只会污染信号（终局那次才记）。落盘失败向上抛，调用方决定回应。
 */
export function saveDraft(
  bookRoot: string,
  chapter: number,
  content: string,
  opts?: { recordAi?: boolean; snapshotOrigin?: string },
): { relPath: string; docId: string; words: number; snapshotted: boolean } {
  const kind = readKind(bookRoot)
  const draftDir = join(bookRoot, '写作', '草稿')
  // 长篇 草稿-<章号>.md(review --chapter=N 推导);短篇 草稿-1.md(候选序号)
  const draftFile = kind === 'short' ? '草稿-1.md' : `草稿-${chapter}.md`
  const relPath = `写作/草稿/${draftFile}`
  // M1 覆写留底：已有草稿且内容不同 → force 快照（作者手改不静默丢失）
  const snapshotId = snapshotBeforeOverwrite(bookRoot, relPath, content, opts?.snapshotOrigin)
  mkdirSync(draftDir, { recursive: true })
  atomicWriteFile(join(draftDir, draftFile), content)
  // 新文件落盘会改变树结构 → 失效树缓存（前端保存后重拉树能看到新草稿）
  invalidateTreeIndex(bookRoot)
  // M3 存草稿并编辑：返回 docId（清单已登记给真 ID；未登记回落 legacyId(relPath)，
  // 与树扫盘一致，前端可直接 openTab）
  const manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  let docId: string | null = null
  for (const e of manifest.entries.values()) {
    if (e.path === relPath) {
      docId = e.id
      break
    }
  }
  const finalDocId = docId ?? legacyId(relPath)
  // 文风S2 改稿轨迹：AI 产出记旁路 ref（作者手改后可比对挖信号；失败不阻断落盘）
  if (opts?.recordAi !== false) {
    // B5 作者信号：先对比上一版（AI 产出）删掉的片段 → 规则命中统计，再记录当前版
    recordAuthorSignal(bookRoot, finalDocId, content, 'self-heal')
    recordAiVersion(bookRoot, finalDocId, content)
  }
  return { relPath, docId: finalDocId, words: content.length, snapshotted: snapshotId !== null }
}

export function registerDraftRoutes(ctx: DraftCtx): void {
  route('POST', '/api/books/:name/draft-save', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })

    const body = await readJson(req)
    const chapter = Number(body['chapter'])
    if (!Number.isInteger(chapter) || chapter < 1) {
      return reply(res, 400, { error: 'chapter 需为正整数' })
    }
    const content = typeof body['content'] === 'string' ? (body['content'] as string) : ''
    if (!content.trim()) return reply(res, 400, { error: 'content 为空' })

    const bookRoot = join(ctx.workDir, entry.path)
    let saved: ReturnType<typeof saveDraft>
    try {
      saved = saveDraft(bookRoot, chapter, content)
    } catch (e) {
      return reply(res, 500, { error: `落盘失败:${e instanceof Error ? e.message : String(e)}` })
    }
    reply(res, 200, {
      ok: true,
      path: saved.relPath,
      words: saved.words,
      docId: saved.docId,
      snapshotted: saved.snapshotted,
    })
  })

  // 组 draft prompt(读细纲+备料,长短篇分支,方案 6.6)——前端 draftWrite 拉取后 POST /spawn
  route('GET', '/api/books/:name/draft-prompt', (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const chapter = Number(url.searchParams.get('chapter') ?? '1')
    if (!Number.isInteger(chapter) || chapter < 1) return reply(res, 400, { error: 'chapter 需为正整数' })
    const bookRoot = join(ctx.workDir, entry.path)
    reply(res, 200, { prompt: buildDraftPrompt(bookRoot, chapter, readKind(bookRoot)) })
  })
}

/** 组 draft prompt:细纲 + 备料 + 章纲 + 世界观 + 要求(方案 6.6,长短篇 front matter 分支)*/
export function buildDraftPrompt(bookRoot: string, chapter: number, kind: 'long' | 'short'): string {
  const outline = readSafe(join(bookRoot, '写作', '草稿', '细纲.md'))
  const materials = readSafe(join(bookRoot, '写作', '草稿', '本章写作材料.md'))
  // Bug B 修复：补读章纲 + 世界观——AI 据此知道本书题材/人物/世界，不再跑题
  const chapterOutline = readChapterOutline(bookRoot, chapter)
  const worldView = readSafe(join(bookRoot, '设定', '世界观.md'))
  if (kind === 'short') {
    const parts: string[] = [
      `## 任务\n写第 ${chapter} 篇正文(短篇,8000-20000 字,单篇完整开合:铺垫→反转→收尾,目标情绪落地)。`,
    ]
    if (outline) parts.push(`## 本篇细纲(已确认)\n${outline}`)
    if (worldView) parts.push(`## 世界观(本书设定,保持设定一致)\n${worldView.slice(0, 1200)}`)
    const settingsCtx = buildSettingsContext(bookRoot)
    if (settingsCtx) parts.push(settingsCtx)
    parts.push(
      `## 要求\n只输出第 ${chapter} 篇正文（纯叙事文本，仅段落与空行，禁 markdown 标题/加粗/列表，单篇闭合，余韵收尾）。标题 / 目标情绪 / 核心反转 由结构化字段承载，无需写进正文。`,
    )
    return parts.join('\n\n')
  }
  const parts: string[] = [
    `## 任务\n按细纲、章纲与备料写第 ${chapter} 章正文(长篇,2000-4000 字,单章一主场景,章尾留钩)。`,
  ]
  if (outline) parts.push(`## 本章细纲(已确认)\n${outline}`)
  if (chapterOutline) parts.push(`## 本章章纲(情节走向依据)\n${chapterOutline}`)
  if (materials) parts.push(`## 备料\n${materials}`)
  if (worldView) parts.push(`## 世界观(本书设定,保持设定一致)\n${worldView.slice(0, 1200)}`)
  const settingsCtx = buildSettingsContext(bookRoot)
  if (settingsCtx) parts.push(settingsCtx)
  parts.push(
    `## 要求\n只输出第 ${chapter} 章正文（纯叙事文本，仅段落与空行，禁 markdown 标题/加粗/列表，单章一主场景，章尾留钩，人物与境界须与世界观一致）。标题 / 钩子类型 / 情绪定位 由结构化字段承载，无需写进正文。`,
  )
  return parts.join('\n\n')
}

/** 读本章章纲（大纲/章纲/000N-*.md，按章号匹配文件名前缀）——AI 写稿的情节依据 */
function readChapterOutline(bookRoot: string, chapter: number): string {
  const { chapters } = readChapterDir(join(bookRoot, '大纲', '章纲'))
  const hit = chapters.find((c) => c.章号 === chapter)
  if (!hit?._path) return ''
  return readSafe(hit._path)
}

function readSafe(fp: string): string {
  if (!existsSync(fp)) return ''
  try {
    return readFileSync(fp, 'utf8')
  } catch {
    return ''
  }
}
