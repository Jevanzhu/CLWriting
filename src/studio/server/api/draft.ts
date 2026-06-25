/**
 * draft 落盘端点(C.1 + 短篇轮1):driver writer 产出 → 工作区/草稿-<N>.md。
 *
 * POST /api/books/:name/draft-save  body {chapter, content}
 *   → 长篇 工作区/草稿-<chapter>.md;短篇 工作区/草稿-1.md(候选序号)→ {ok, path, words}
 * GET  /api/books/:name/draft-prompt?chapter=N
 *   → 组 prompt(长篇:细纲+备料+章 front matter;短篇:细纲+篇 front matter)→ {prompt}
 *
 * 工作区是 driver 落盘区(非手编);前端收集 driver text 流(done 后)调此落盘。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readBookConfig } from '../../../format/yaml.js'
import { buildSettingsContext } from './settings.js'

interface DraftCtx {
  workDir: string | null
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
    const kind = readKind(bookRoot)
    const draftDir = join(bookRoot, '工作区')
    // 长篇 草稿-<章号>.md(review --chapter=N 推导);短篇 草稿-1.md(候选序号)
    const draftFile = kind === 'short' ? '草稿-1.md' : `草稿-${chapter}.md`
    const relPath = `工作区/${draftFile}`
    try {
      mkdirSync(draftDir, { recursive: true })
      writeFileSync(join(draftDir, draftFile), content, 'utf8')
    } catch (e) {
      return reply(res, 500, { error: `落盘失败:${e instanceof Error ? e.message : String(e)}` })
    }
    reply(res, 200, { ok: true, path: relPath, words: content.length })
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

/** 读 book.yaml kind(long 缺省 / short) */
function readKind(bookRoot: string): 'long' | 'short' {
  const r = readBookConfig(join(bookRoot, 'book.yaml'))
  if (!r.ok) return 'long'
  return ((r as { config: { kind?: string } }).config.kind ?? 'long') === 'short' ? 'short' : 'long'
}

/** 组 draft prompt:细纲 + 备料 + 要求(方案 6.6,长短篇 front matter 分支)*/
export function buildDraftPrompt(bookRoot: string, chapter: number, kind: 'long' | 'short'): string {
  const outline = readSafe(join(bookRoot, '工作区', '细纲.md'))
  const materials = readSafe(join(bookRoot, '工作区', '本章写作材料.md'))
  if (kind === 'short') {
    const parts: string[] = [
      `## 任务\n写第 ${chapter} 篇正文(短篇,8000-20000 字,单篇完整开合:铺垫→反转→收尾,目标情绪落地)。`,
    ]
    if (outline) parts.push(`## 本篇细纲(已确认)\n${outline}`)
    const settingsCtx = buildSettingsContext(bookRoot)
    if (settingsCtx) parts.push(settingsCtx)
    parts.push(
      `## 要求\n按你的角色规则产出完整草稿:以短篇 front matter 开头(篇号: ${chapter} / 标题 / 目标情绪 / 核心反转),紧跟正文(纯文本段落,单篇闭合,余韵收尾)。直接输出 front matter + 正文全文,不要读文件、不要用任何工具。`,
    )
    return parts.join('\n\n')
  }
  const parts: string[] = [
    `## 任务\n按细纲与备料写第 ${chapter} 章正文(长篇,2000-4000 字,单章一主场景,章尾留钩)。`,
  ]
  if (outline) parts.push(`## 本章细纲(已确认)\n${outline}`)
  if (materials) parts.push(`## 备料\n${materials}`)
  const settingsCtx = buildSettingsContext(bookRoot)
  if (settingsCtx) parts.push(settingsCtx)
  parts.push(
    `## 要求\n按你的角色规则产出完整草稿:以章节 front matter 开头(章号: ${chapter} / 标题 / 钩子类型 / 钩子强弱 / 情绪定位),紧跟正文(纯文本段落,章尾留钩)。直接输出 front matter + 正文全文,不要读文件、不要用任何工具。`,
  )
  return parts.join('\n\n')
}

function readSafe(fp: string): string {
  if (!existsSync(fp)) return ''
  try {
    return readFileSync(fp, 'utf8')
  } catch {
    return ''
  }
}
