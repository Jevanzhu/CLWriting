/**
 * 书架 + 单书 + 建书 REST 端点（#12.3 + 5.1）。
 *
 * - GET  /api/books          书架列表（读 books.jsonl）
 * - POST /api/books          建书（doInit；1.5 段 1 表单）
 * - GET  /api/books/:name    单书身份（读该书 book.yaml，含 host）
 * - GET  /api/boot           启动初始态（--book 直进支持）
 *
 * workDir 由 server 启动时 findWorkDir(cwd) 注入；为 null 时书架空 + 提示（不崩）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { route } from '../router.js'
import { readBooks } from '../../../install/books.js'
import { readBookConfig } from '../../../format/yaml.js'
import { doInit } from '../../../install/init.js'

interface BookCtx {
  workDir: string | null
  /** session token(P0 defense-in-depth,boot 注入前端,写端点校验) */
  token: string
}

let initialBook: string | undefined

export function registerBookRoutes(ctx: BookCtx): void {
  // 书架列表
  route('GET', '/api/books', (_req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.workDir) {
      reply(res, 200, {
        books: [],
        workDir: false,
        hint: '当前目录不是 CLWriting 工作目录。请在工作目录（含 .clwriting/）下启动 studio。',
      })
      return
    }
    reply(res, 200, { books: readBooks(ctx.workDir), workDir: true })
  })

  // 建书（1.5 段 1 表单 → doInit）
  route('POST', '/api/books', async (req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.workDir) {
      reply(res, 400, { error: '未定位到工作目录，无法建书' })
      return
    }
    const body = (await readJson(req)) as {
      name?: unknown
      genre?: unknown
      kind?: unknown
      leads?: unknown
      host?: unknown
    }
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) {
      reply(res, 400, { error: '书名不能为空' })
      return
    }
    const genre = typeof body.genre === 'string' ? body.genre.trim() : ''
    const kind = body.kind === 'short' ? 'short' : 'long'
    const leads = Array.isArray(body.leads)
      ? body.leads.filter((x): x is string => typeof x === 'string')
      : undefined
    const host = body.host === 'codex' ? 'codex' : 'cc'
    const result = doInit({
      workDir: ctx.workDir,
      name,
      genre: genre || undefined,
      leads,
      kind,
      host,
    })
    if (!result.ok) {
      reply(res, 400, { error: result.reason })
      return
    }
    reply(res, 200, { name: result.bookName, kind, path: result.bookName })
  })

  // 单书身份
  route(
    'GET',
    '/api/books/:name',
    (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
      const name = params['name']
      if (!name || !ctx.workDir) {
        reply(res, 400, { error: '未定位到工作目录' })
        return
      }
      const entry = readBooks(ctx.workDir).find((b) => b.name === name)
      if (!entry) {
        reply(res, 404, { error: `没有这本书：${name}` })
        return
      }
      const { config } = readBookConfig(join(ctx.workDir, entry.path, 'book.yaml'))
      reply(res, 200, {
        name: entry.name,
        kind: entry.kind,
        path: entry.path,
        ...(entry.created_at ? { created_at: entry.created_at } : {}),
        title: config.book.title,
        genre: config.book.genre,
        host: config.host ?? 'cc',
      })
    },
  )

  // 启动初始态（--book 直进 + session token 注入前端）
  route('GET', '/api/boot', (_req: IncomingMessage, res: ServerResponse) => {
    reply(res, 200, { initialBook, token: ctx.token })
  })
}

export function setInitialBook(name: string | undefined): void {
  initialBook = name
}

/** 读 request body JSON（容错：空/坏 → {}） */
async function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c: Buffer) => {
      data += c.toString('utf-8')
    })
    req.on('end', () => {
      try {
        resolve(data.trim() === '' ? {} : JSON.parse(data))
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
