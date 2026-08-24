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
import { basename } from 'node:path'
import { readFile as readFileAsync } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolveWithinRoot } from '../../../fs/safe-path.js'
import { atomicWriteFile } from '../../../fs/atomic.js'
import { defineRoute } from './schema.js'
import { readJson, reply, replyError, parseRequestUrl } from '../http.js'
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

/**
 * S4（五十九轮）：异步读全文 + 字节指纹单次读取共源——原 readFileSync + hashFile
 * 各整读一次（PUT 乐观锁路径双份同步整读），数百 KB 设定文件在同步 IO 期间阻塞
 * 事件循环（SSE 心跳停摆）。哈希口径与 fs/hash 的 hashFile 同构（'sha256:' + 原始
 * 字节 hex），revision 契约不变；ENOENT 以 null 区分（调用方回 404）。
 * 注：写侧仍走 atomicWriteFile（同步原子写是既有纪律，src/fs 不动；写面 IO 量级
 * 与读面同源，后续批次统一异步化时一并收口）。
 */
async function readFileHashed(fp: string): Promise<{ content: string; revision: string } | null> {
  let buf: Buffer
  try {
    buf = await readFileAsync(fp)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  return { content: buf.toString('utf-8'), revision: 'sha256:' + createHash('sha256').update(buf).digest('hex') }
}

export function registerFileRoutes(ctx: FileCtx): void {
  // 读 .md 全文
  defineRoute('books.file.get', {
    method: 'GET',
    path: '/api/books/:name/file',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      // R-19（第十六轮）：畸形 URL → 400 BAD_INPUT（Q-1/N-3 口径）
      const q = queryParams(req)
      if (!q) return replyError(res, 400, 'BAD_INPUT', 'bad request')
      const file = q.get('file') ?? ''
      const safe = editablePath(r.bookRoot, file)
      if (!safe) return replyError(res, 400, 'BAD_PATH', '非法路径')
      // S4：异步读取（原 existsSync + readFileSync + hashFile 三份同步 IO）
      const read = await readFileHashed(safe)
      if (!read) return replyError(res, 404, 'NOT_FOUND', '文件不存在')
      // M-3（第六轮）：附带字节指纹——与 /documents 协议的 revision 同源（hashFile），
      // 客户端读时取走、存时回传，PUT 侧据此做乐观锁（此前 PUT /file 无任何并发控制）
      reply(res, 200, { content: read.content, revision: read.revision })
    },
  })

  // 写 .md 全文
  defineRoute('books.file.put', {
    method: 'PUT',
    path: '/api/books/:name/file',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      // R-19（第十六轮）：畸形 URL → 400 BAD_INPUT（Q-1/N-3 口径）
      const q = queryParams(req)
      if (!q) return replyError(res, 400, 'BAD_INPUT', 'bad request')
      const file = q.get('file') ?? ''
      // X-P2-14：路径寻址 PUT 不放行 写作/正文——正文保存必须走 /documents/:docId/content
      // （乐观锁 + journal + 快照协议），否则编辑器并发保存被静默覆写、树状态失真
      const safe = writablePath(r.bookRoot, file)
      if (!safe) return replyError(res, 400, 'BAD_PATH', '非法路径（正文请走文档保存协议）')
      const body = (await readJson(req)) as { content?: unknown; expectedRevision?: unknown }
      if (typeof body.content !== 'string') {
        replyError(res, 400, 'BAD_INPUT', '缺少 content')
        return
      }
      // B-22 串行链闭包内使用——属性窄化不跨闭包，先钉成不可变局部
      const content: string = body.content
      // M-3（第六轮）：可选乐观锁——expectedRevision 与盘上字节指纹不符 → 409。缺省时保持
      // 旧「后写为准」语义（存量调用方零改动）；成功响应回新指纹供客户端滚动基线。
      // B-22（第六十轮）：乐观锁挡的是「基线不符」，挡不住两标签页同 expectedRevision
      // 并发保存时双双读到同一旧基线先后过检的 TOCTOU 残窗（读基线→比对→写跨两个
      // await）——per-file Promise 链把临界段在进程内串行化，后到者重读基线即见先写者
      // 指纹 → 409；跨进程双开的残窗如实记档（锁基建可后续收口）。
      const outcome = await enqueueFilePut(safe, async () => {
        // S4：异步读取基线（原 existsSync + hashFile 同步整读；ENOENT 统一 404）
        const baseline = await readFileHashed(safe)
        if (!baseline) return { status: 404, code: 'NOT_FOUND', error: '文件不存在' } as const
        if (typeof body.expectedRevision === 'string' && body.expectedRevision !== baseline.revision) {
          return {
            status: 409,
            code: 'REVISION_CONFLICT',
            error: '文件已在其他地方修改（基线不符）——请重载最新内容后再保存',
          } as const
        }
        atomicWriteFile(safe, content)
        // U-P2-8：与 DocumentService 写路径同口径——失效树索引缓存（wordCount/status），
        // 否则 PUT 设定/大纲后树字数过期，只能靠前端 refresh=1 自愈
        invalidateTreeIndex(r.bookRoot)
        return { revision: hashContent(content) } as const
      })
      if ('status' in outcome) return replyError(res, outcome.status, outcome.code, outcome.error)
      reply(res, 200, { ok: true, revision: outcome.revision })
    },
  })

}

/** B-22：PUT 临界段产出——错误信封（回 4xx/5xx）或成功新指纹。 */
type FilePutOutcome =
  | { readonly status: number; readonly code: string; readonly error: string }
  | { readonly revision: string }

/** B-22：同文件 PUT 串行链（key = 绝对安全路径）。续链用 settled 副本吞错防断链，
 *  真实结果经返回的 task 传递（IO 异常照常上抛给路由层，与修复前口径一致）；
 *  链尾自清理防 Map 无界增长。 */
const filePutChains = new Map<string, Promise<unknown>>()

function enqueueFilePut(safe: string, critical: () => Promise<FilePutOutcome>): Promise<FilePutOutcome> {
  const prev = filePutChains.get(safe) ?? Promise.resolve()
  const task = prev.then(critical, critical)
  const settled = task.catch(() => { /* 续链副本吞错；真实异常经 task 上抛 */ })
  filePutChains.set(safe, settled)
  void settled.then(() => {
    if (filePutChains.get(safe) === settled) filePutChains.delete(safe)
  })
  return task
}

/** S4：写后回指纹——对写入内容直接哈希（盘上即该内容，语义与 hashFile 相同且免二次读盘）。 */
function hashContent(content: string): string {
  return 'sha256:' + createHash('sha256').update(content, 'utf-8').digest('hex')
}

/** 取 req URL 的 searchParams
 *  R-19（第十六轮）：改经 parseRequestUrl 统一解析（Q-1/N-3 口径）——畸形 URL 返 null，
 *  调用方回 400 BAD_INPUT 信封。 */
function queryParams(req: IncomingMessage): URLSearchParams | null {
  return parseRequestUrl(req)?.searchParams ?? null
}

/** 编辑器只允许读写 EDIT_DIRS 下的普通 Markdown 文件（+ W-P1-3 工作区确认文件白名单）。
 *  防穿越批 6 统一：resolveWithinRoot（resolve+relative 防穿越 + symlink 双侧 realpath 校验，
 *  目标存在时返回 realpath；fail-closed）——安全判定与 rel 提取共用同一次解析结果。 */
function editablePath(bookRoot: string, file: string): string | null {
  if (!file.endsWith('.md') || basename(file).startsWith('._')) return null
  const safe = resolveWithinRoot(bookRoot, file)
  if (!safe) return null
  const allowed = EDIT_DIRS.some(({ dir }) => safe.rel === dir || safe.rel.startsWith(`${dir}/`))
  // W-P1-3 作者确认位：细纲.md（推进声明）与 账本推进.md（实际履历行）放行编辑器读写
  if (!allowed && WORKDIR_EDITABLE.has(safe.rel)) return safe.abs
  return allowed ? safe.abs : null
}

/** X-P2-14：写侧白名单 = editablePath 去掉 写作/正文——正文 PUT 走文档保存协议（读侧 doc store 仍按路径读正文）。 */
function writablePath(bookRoot: string, file: string): string | null {
  const safe = resolveWithinRoot(bookRoot, file)
  if (!safe) return null
  if (!file.endsWith('.md') || basename(file).startsWith('._')) return null
  if (safe.rel === '写作/正文' || safe.rel.startsWith('写作/正文/')) return null
  const allowed = EDIT_DIRS.some(({ dir }) => safe.rel === dir || safe.rel.startsWith(`${dir}/`))
  if (!allowed && !WORKDIR_EDITABLE.has(safe.rel)) return null
  return safe.abs
}

