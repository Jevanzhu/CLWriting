/**
 * draft 落盘端点(C.1):driver writer 产出 → 工作区/草稿-N.md。
 *
 * POST /api/books/:name/draft-save  body {chapter, content}
 *   → 写 bookRoot/工作区/草稿-<chapter>.md → {ok, path, words}
 *
 * 工作区是 driver 落盘区(非手编,不在 files.ts EDIT_DIRS);
 * 前端收集 driver text 流(done 后)调此落盘。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { route } from '../router.js'
import { readBooks } from '../../../install/books.js'

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
    const draftDir = join(bookRoot, '工作区')
    // 草稿-<章号>.md:与 review --chapter=N 推导一致(check/finalize 显式传此路径)
    const relPath = `工作区/草稿-${chapter}.md`
    try {
      mkdirSync(draftDir, { recursive: true })
      writeFileSync(join(draftDir, `草稿-${chapter}.md`), content, 'utf8')
    } catch (e) {
      return reply(res, 500, { error: `落盘失败:${e instanceof Error ? e.message : String(e)}` })
    }
    reply(res, 200, { ok: true, path: relPath, words: content.length })
  })

  // 组 draft prompt(读细纲+备料,方案 6.6)——前端 draftWrite 拉取后 POST /spawn
  route('GET', '/api/books/:name/draft-prompt', (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const chapter = Number(url.searchParams.get('chapter') ?? '1')
    if (!Number.isInteger(chapter) || chapter < 1) return reply(res, 400, { error: 'chapter 需为正整数' })
    const bookRoot = join(ctx.workDir, entry.path)
    reply(res, 200, { prompt: buildDraftPrompt(bookRoot, chapter) })
  })
}

/** 组 draft prompt:细纲 + 备料 + 要求(方案 6.6:draft prompt = 细纲.md + 本章写作材料.md) */
function buildDraftPrompt(bookRoot: string, chapter: number): string {
  const parts: string[] = [
    `## 任务\n按细纲与备料写第 ${chapter} 章正文(长篇,2000-4000 字,单章一主场景,章尾留钩)。`,
  ]
  const outline = readSafe(join(bookRoot, '工作区', '细纲.md'))
  if (outline) parts.push(`## 本章细纲(已确认)\n${outline}`)
  const materials = readSafe(join(bookRoot, '工作区', '本章写作材料.md'))
  if (materials) parts.push(`## 备料\n${materials}`)
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

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let buf = ''
    req.on('data', (c) => {
      buf += c
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(buf || '{}'))
      } catch {
        resolve({})
      }
    })
  })
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
