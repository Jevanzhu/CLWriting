/**
 * 文件读写 + 回滚 REST 端点（#12.3 + 6.2 + 6.3）。
 *
 * - GET  /api/books/:name/files        列可编辑 .md（定稿正文 + 设定 + 大纲）
 * - GET  /api/books/:name/file?file=   读 .md 全文
 * - PUT  /api/books/:name/file?file=   写 .md 全文（编辑器保存）
 *
 * 读写全文（不剥 front matter）：设定里有的 .md 无 front matter（如 总纲.md）。
 * 路径防穿越：resolve + relative 判定，必须落在 bookRoot 内。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve, relative, isAbsolute, basename } from 'node:path'
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'

interface FileCtx {
  workDir: string | null
}

/** 可编辑目录（相对 bookRoot）+ 编辑模式（正文纯文本 / 设定 MD） */
const EDIT_DIRS: { dir: string; mode: 'text' | 'md' }[] = [
  { dir: '定稿/正文', mode: 'text' },
  { dir: '定稿/设定', mode: 'md' },
  { dir: '大纲', mode: 'md' },
  { dir: '工作区', mode: 'md' }, // 2.5:草稿/细纲/审稿可见可改(改写针对草稿)
  { dir: '篇', mode: 'md' }, // 短篇集正文（篇/N-标题.md 纯文本）；清单分离到 清单/（系统文档，不进可编辑列表）
  { dir: '文风', mode: 'md' }, // 文风铁律/样章库/金句库（撤出编辑树；SettingsModal「文风铁律」复用 /file 读写）
]


export function registerFileRoutes(ctx: FileCtx): void {
  // 列可编辑 .md
  route('GET', '/api/books/:name/files', (_req: IncomingMessage, res: ServerResponse, params) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return reply(res, r.status, { error: r.error })
    const files: { path: string; mode: 'text' | 'md' }[] = []
    for (const { dir, mode } of EDIT_DIRS) {
      const abs = join(r.bookRoot, dir)
      if (!existsSync(abs)) continue
      for (const p of walkMd(abs)) {
        const rel = relative(r.bookRoot, p).split('\\').join('/')
        // 纯文本正文：工作区草稿-N.md、短篇 篇/N-标题.md；其余 md
        const fileMode =
          (dir === '工作区' && /(?:^|\/)草稿-\d+\.md$/.test(rel)) ||
          dir === '篇'
            ? 'text'
            : mode
        files.push({ path: rel, mode: fileMode })
      }
    }
    reply(res, 200, { files })
  })

  // 读 .md 全文
  route('GET', '/api/books/:name/file', (req: IncomingMessage, res: ServerResponse, params) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return reply(res, r.status, { error: r.error })
    const file = queryParams(req).get('file') ?? ''
    const safe = editablePath(r.bookRoot, file)
    if (!safe) return reply(res, 400, { error: '非法路径' })
    if (!existsSync(safe)) return reply(res, 404, { error: '文件不存在' })
    reply(res, 200, { content: readFileSync(safe, 'utf-8') })
  })

  // 写 .md 全文
  route(
    'PUT',
    '/api/books/:name/file',
    async (req: IncomingMessage, res: ServerResponse, params) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return reply(res, r.status, { error: r.error })
      const file = queryParams(req).get('file') ?? ''
      const safe = editablePath(r.bookRoot, file)
      if (!safe) return reply(res, 400, { error: '非法路径' })
      if (!existsSync(safe)) return reply(res, 404, { error: '文件不存在' })
      const body = (await readJson(req)) as { content?: unknown }
      if (typeof body.content !== 'string') {
        reply(res, 400, { error: '缺少 content' })
        return
      }
      writeFileSync(safe, body.content, 'utf-8')
      reply(res, 200, { ok: true })
    },
  )

}

/** 取 req URL 的 searchParams */
function queryParams(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '/', 'http://localhost').searchParams
}

/** 递归列目录下所有 .md（排除 ._ / node_modules / .git） */
function walkMd(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const name of entries) {
      if (name.startsWith('._') || name === 'node_modules' || name === '.git') continue
      const p = join(d, name)
      let s
      try {
        s = statSync(p)
      } catch {
        continue
      }
      if (s.isDirectory()) walk(p)
      else if (name.endsWith('.md')) out.push(p)
    }
  }
  walk(dir)
  return out
}

/** 防穿越：file 相对 bookRoot，resolve 后 relative 必须非空、不以 .. 开头、非绝对（跨盘） */
function safePath(bookRoot: string, file: string): string | null {
  if (!file || file.includes('\0')) return null
  const root = resolve(bookRoot)
  const abs = resolve(root, file)
  const rel = relative(root, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return abs
}

/** 编辑器只允许读写 EDIT_DIRS 下的普通 Markdown 文件。 */
function editablePath(bookRoot: string, file: string): string | null {
  if (!file.endsWith('.md') || basename(file).startsWith('._')) return null
  const abs = safePath(bookRoot, file)
  if (!abs) return null
  const rel = relative(resolve(bookRoot), abs).split('\\').join('/')
  const allowed = EDIT_DIRS.some(({ dir }) => rel === dir || rel.startsWith(`${dir}/`))
  return allowed ? abs : null
}

function resolveBook(
  workDir: string | null,
  name: string | undefined,
): { bookRoot: string } | { error: string; status: number } {
  if (!workDir) return { error: '未定位到工作目录', status: 400 }
  if (!name) return { error: '缺少书名', status: 400 }
  const entry = readBooks(workDir).find((b) => b.name === name)
  if (!entry) return { error: `没有这本书：${name}`, status: 404 }
  return { bookRoot: join(workDir, entry.path) }
}
