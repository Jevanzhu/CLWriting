/**
 * 文件读写 + 回滚 REST 端点（#12.3 + 6.2 + 6.3）。
 *
 * - GET  /api/books/:name/file?file=   读 .md 全文
 * - PUT  /api/books/:name/file?file=   写 .md 全文（编辑器保存）
 *
 * 读写全文（不剥 front matter）：设定里有的 .md 无 front matter（如 总纲.md）。
 * 路径防穿越：resolve + relative 判定，必须落在 bookRoot 内。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve, relative, isAbsolute, basename } from 'node:path'
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { atomicWriteFile } from '../../../fs/atomic.js'
import { defineRoute } from './schema.js'
import { readJson, reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { invalidateTreeIndex } from '../../../document/tree.js'

interface FileCtx {
  workDir: string | null
}

/** 可编辑目录（相对 bookRoot）+ 编辑模式（正文纯文本 / 设定 MD） */
const EDIT_DIRS: { dir: string; mode: 'text' | 'md' }[] = [
  { dir: '写作/正文', mode: 'text' },
  { dir: '设定', mode: 'md' },
  { dir: '大纲', mode: 'md' },
  { dir: '布线', mode: 'md' }, // 线索账本（设定伏笔在 设定/ 下）
  { dir: '文风', mode: 'md' }, // 文风铁律/样章库/金句库（撤出编辑树；SettingsModal「文风铁律」复用 /file 读写）
  // W-P1-3 作者确认位：细纲.md（推进声明）与 账本推进.md（实际履历行）需在编辑器可见可改，
  // 但 工作区/ 其余内部资产（.版本/.confirm.json 等）不进编辑白名单——只放行这两个确认文件。
]

/** W-P1-3：作者确认位专用白名单（工作区下仅这两个文件可进编辑器） */
const WORKDIR_EDITABLE = new Set(['工作区/细纲.md', '工作区/账本推进.md'])


export function registerFileRoutes(ctx: FileCtx): void {
  // 读 .md 全文
  defineRoute('books.file.get', {
    method: 'GET',
    path: '/api/books/:name/file',
    handler: ({ params }, req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    const file = queryParams(req).get('file') ?? ''
    const safe = editablePath(r.bookRoot, file)
    if (!safe) return replyError(res, 400, 'BAD_PATH', '非法路径')
    if (!existsSync(safe)) return replyError(res, 404, 'NOT_FOUND', '文件不存在')
    reply(res, 200, { content: readFileSync(safe, 'utf-8') })
  },
  })

  // 写 .md 全文
  defineRoute('books.file.put', {
    method: 'PUT',
    path: '/api/books/:name/file',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      const file = queryParams(req).get('file') ?? ''
      // X-P2-14：路径寻址 PUT 不放行 写作/正文——正文保存必须走 /documents/:docId/content
      // （乐观锁 + journal + 快照协议），否则编辑器并发保存被静默覆写、树状态失真
      const safe = writablePath(r.bookRoot, file)
      if (!safe) return replyError(res, 400, 'BAD_PATH', '非法路径（正文请走文档保存协议）')
      if (!existsSync(safe)) return replyError(res, 404, 'NOT_FOUND', '文件不存在')
      const body = (await readJson(req)) as { content?: unknown }
      if (typeof body.content !== 'string') {
        replyError(res, 400, 'BAD_INPUT', '缺少 content')
        return
      }
      atomicWriteFile(safe, body.content)
      // U-P2-8：与 DocumentService 写路径同口径——失效树索引缓存（wordCount/status），
      // 否则 PUT 设定/大纲后树字数过期，只能靠前端 refresh=1 自愈
      invalidateTreeIndex(r.bookRoot)
      reply(res, 200, { ok: true })
    },
  })

}

/** 取 req URL 的 searchParams */
function queryParams(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '/', 'http://localhost').searchParams
}

/** 防穿越：file 相对 bookRoot，resolve 后 relative 必须非空、不以 .. 开头、非绝对（跨盘）。
 *  symlink 二次校验（与其他 3 套 safePath 实现一致）：文件存在时解析 realpath，防符号链接指向 bookRoot 外。 */
function safePath(bookRoot: string, file: string): string | null {
  if (!file || file.includes('\0')) return null
  const root = resolve(bookRoot)
  const abs = resolve(root, file)
  const rel = relative(root, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  // symlink 防御：文件存在时 realpath 仍须在 root 内（两边都 realpath 防 macOS /var → /private/var 前缀差异）
  if (existsSync(abs)) {
    try {
      const realRoot = realpathSync(root)
      if (relative(realRoot, realpathSync(abs)).startsWith('..')) return null
    } catch {
      return null
    }
  }
  return abs
}

/** 编辑器只允许读写 EDIT_DIRS 下的普通 Markdown 文件（+ W-P1-3 工作区确认文件白名单）。 */
function editablePath(bookRoot: string, file: string): string | null {
  if (!file.endsWith('.md') || basename(file).startsWith('._')) return null
  const abs = safePath(bookRoot, file)
  if (!abs) return null
  const rel = relative(resolve(bookRoot), abs).split('\\').join('/')
  const allowed = EDIT_DIRS.some(({ dir }) => rel === dir || rel.startsWith(`${dir}/`))
  // W-P1-3 作者确认位：细纲.md（推进声明）与 账本推进.md（实际履历行）放行编辑器读写
  if (!allowed && WORKDIR_EDITABLE.has(rel)) return abs
  return allowed ? abs : null
}

/** X-P2-14：写侧白名单 = editablePath 去掉 写作/正文——正文 PUT 走文档保存协议（读侧 doc store 仍按路径读正文）。 */
function writablePath(bookRoot: string, file: string): string | null {
  const abs = editablePath(bookRoot, file)
  if (!abs) return null
  const rel = relative(resolve(bookRoot), abs).split('\\').join('/')
  if (rel === '写作/正文' || rel.startsWith('写作/正文/')) return null
  return abs
}

