/**
 * 书架 + 单书 REST 端点（#12.3）。
 *
 * - GET /api/books        书架列表（读 books.jsonl）
 * - GET /api/books/:name  单书身份（读该书 book.yaml）
 * - GET /api/boot         启动初始态（--book 直进支持）
 *
 * workDir 由 server 启动时 findWorkDir(cwd) 注入；为 null 时书架空 + 提示（不崩）。
 * host 暂不返：内核 book.yaml 无 host 字段（GUI 建书 1.5 起写入），前端兜底「未设置（默认 cc）」。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { route } from '../router.js'
import { readBooks } from '../../../install/books.js'
import { readBookConfig } from '../../../format/yaml.js'

/** workDir 上下文（server 启动时注入一次） */
interface BookCtx {
  workDir: string | null
}

/** 启动初始书名（--book 指定）；缺省 undefined。由 studio-cli 调 setInitialBook 设置 */
let initialBook: string | undefined

/** 注册书架 + 单书路由（server 启动时调用一次） */
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
      })
    },
  )

  // 启动初始态（--book 直进）
  route('GET', '/api/boot', (_req: IncomingMessage, res: ServerResponse) => {
    reply(res, 200, { initialBook })
  })
}

/** 设置启动初始书名（--book；studio-cli 调用） */
export function setInitialBook(name: string | undefined): void {
  initialBook = name
}

/** 统一 JSON 响应 */
function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
