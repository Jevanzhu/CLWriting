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
import { mkdirSync, writeFileSync } from 'node:fs'
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
    const relPath = `工作区/草稿-${chapter}.md`
    try {
      mkdirSync(draftDir, { recursive: true })
      writeFileSync(join(draftDir, `草稿-${chapter}.md`), content, 'utf8')
    } catch (e) {
      return reply(res, 500, { error: `落盘失败:${e instanceof Error ? e.message : String(e)}` })
    }
    reply(res, 200, { ok: true, path: relPath, words: content.length })
  })
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
