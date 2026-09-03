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
import { basename, sep, join } from 'node:path'
import { readFile as readFileAsync } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolveWithinRoot } from '../../../fs/safe-path.js'
import { atomicWriteFile } from '../../../fs/atomic.js'
import { acquireCrossProcessLockAsync } from '../../../fs/cross-process-lock.js'
import { canonicalizeText } from '../../../fs/text-canonical.js'
import { isMdFileName } from '../../../format/filename.js'
import { defineRoute } from './schema.js'
import { readJson, reply, replyError, parseRequestUrl } from '../http.js'
import { resolveBook } from '../book-context.js'
import { invalidateTreeIndex } from '../../../document/tree.js'
import { snapshotBeforeOverwrite } from '../../../process/draft-pipeline.js' // R26-9（二十六轮）：覆盖留底单源复用（R71-9/R74-4 同款）
import { log } from '../../../log/index.js'

interface FileCtx {
  workDir: string | null
  /** R26-9（二十六轮）：留底保留策略读 global.json 需要（缺省 → 硬编码默认，与快照端点同口径） */
  userDataPath: string | null
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
      // R26-9（二十六轮）：writablePath 同次解析带回 rel（快照留底按 bookRoot 相对路径寻址）
      const dest = writablePath(r.bookRoot, file)
      if (!dest) return replyError(res, 400, 'BAD_PATH', '非法路径（正文请走文档保存协议）')
      const putRel: string = dest.rel
      const safe: string = dest.abs
      const body = (await readJson(req)) as { content?: unknown; expectedRevision?: unknown }
      if (typeof body.content !== 'string') {
        replyError(res, 400, 'BAD_INPUT', '缺少 content')
        return
      }
      // B-22 串行链闭包内使用——属性窄化不跨闭包，先钉成不可变局部
      // 平台规范化批：PUT 白名单 .md 直写不经 DocumentService.save，此处自收口——
      // 请求体内容（外部编辑器粘贴/同步盘形态）写前归一规范形，快照比对与指纹同源
      const content: string = canonicalizeText(body.content)
      // M-3（第六轮）：可选乐观锁——expectedRevision 与盘上字节指纹不符 → 409。缺省时保持
      // 旧「后写为准」语义（存量调用方零改动）；成功响应回新指纹供客户端滚动基线。
      // B-22（第六十轮）：乐观锁挡的是「基线不符」，挡不住两标签页同 expectedRevision
      // 并发保存时双双读到同一旧基线先后过检的 TOCTOU 残窗（读基线→比对→写跨两个
      // await）——per-file Promise 链把临界段在进程内串行化，后到者重读基线即见先写者
      // 指纹 → 409；跨进程双开的残窗如实记档（锁基建可后续收口）。
      const outcome = await enqueueFilePut(safe, async () => {
        // R43-1（四十三轮）：布线/关系线文件先取同名布线锁（与保存/定稿链同锁文件互斥），
        // 超时 fail-closed 拒写可重试（裸写正是本锁要闭合的覆盖形态）——此前 PUT 直写
        // 绕过布线锁协议，跨进程定稿履历回写可无痕覆盖 PUT 刚落的内容
        const wiringKey = wiringLockKeyForPut(r.bookRoot, putRel)
        let wiringRelease: (() => void) | null = null
        if (wiringKey) {
          try {
            wiringRelease = await acquireCrossProcessLockAsync(wiringKey, 5_000)
          } catch (e) {
            return {
              status: 409,
              code: 'WRITE_ERROR',
              error: `布线文件锁获取失败（未执行保存，可重试）：${e instanceof Error ? e.message : String(e)}`,
            } as const
          }
          if (!wiringRelease) {
            return {
              status: 409,
              code: 'WRITE_ERROR',
              error: '保存等待超时：另一进程正在回写此布线文件（5 秒未让出），请重试',
            } as const
          }
        }
        try {
        // S4：异步读取基线（原 existsSync + hashFile 同步整读；ENOENT 统一 404）
        const baseline = await readFileHashed(safe)
        if (!baseline) return { status: 404, code: 'NOT_FOUND', error: '文件不存在' } as const
        // R70-6（十八轮）：临界段写前重验书注册——readFileHashed 的 await 可跨
        // renameSync/rmSync（drain 是快照式，快照后新进的 PUT 无闸拦）：书已删/改路径
        // 后写旧路径，atomicWriteFile 的 mkdir recursive 会重建目录树成孤儿文件，PUT
        // 却返回 200「已保存」。重验 resolveBook：已删（error）或 bookRoot 变化（改名）
        // → 拒写 409，编辑端拿到可读错误重新进书。
        const rNow = resolveBook(ctx.workDir, params['name']!)
        if ('error' in rNow || rNow.bookRoot !== r.bookRoot) {
          return { status: 409, code: 'BOOK_MOVED', error: '书目录刚被改名或删除，保存已取消——请重新打开本书后再试' } as const
        }
        if (typeof body.expectedRevision === 'string' && body.expectedRevision !== baseline.revision) {
          return {
            status: 409,
            code: 'REVISION_CONFLICT',
            error: '文件已在其他地方修改（基线不符）——请重载最新内容后再保存',
          } as const
        }
        // R26-9（二十六轮）：覆盖写前快照留底——PUT /file 直接 atomicWriteFile 覆盖既有
        // 文件（设定/大纲/细纲等编辑器白名单 .md），旧内容此前无版本链、误存即不可恢复。
        // 复用 draft 侧 snapshotBeforeOverwrite 单源工具（文件不存在/内容相同 → null 不留）。
        // 留底失败 fail-open（log 留痕不阻断保存）——与 onboard-ai（R71-9）同口径：保存
        // 主链路不因留底 IO 抖动失败（编辑器 PUT 另有乐观锁 + per-file 串行链兜底）。
        try {
          snapshotBeforeOverwrite(r.bookRoot, putRel, content, 'file-put-overwrite', undefined, ctx.userDataPath)
        } catch (e) {
          log.warn('api', `PUT /file 覆盖前快照失败（fail-open 继续保存）：${safe}`, e)
        }
        atomicWriteFile(safe, content)
        // U-P2-8：与 DocumentService 写路径同口径——失效树索引缓存（wordCount/status），
        // 否则 PUT 设定/大纲后树字数过期，只能靠前端 refresh=1 自愈
        invalidateTreeIndex(r.bookRoot)
        return { revision: hashContent(content) } as const
        } finally {
          wiringRelease?.()
        }
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

/** R69-25（十七轮）：等待某书根前缀下全部在途 PUT /file 串行链排空——改名/删书前
 *  drain（与 drainDocumentSaves 同型）：PUT 临界段内 readFileHashed 跨 renameSync 的
 *  await 窗口会「读到旧内容 → atomicWriteFile 直写旧路径 + mkdir recursive 重建目录树」
 *  → 旧书路径残留孤儿文件。删除路径天然免疫（基线 ENOENT → 404 不写），仍一并 drain
 *  求同口径。快照当前键后逐键等待（新进链不等——rename 已过本闸的守卫语义由各端点
 *  自身的 orchestration 排队保证）。
 *  R71-10（总七十一轮）：链键是 resolveWithinRoot 返回的口径——目标存在时为 realpath
 *  （safe-path.ts），目标不存在时为词法 resolve；调用方（books.ts）传入的书根是
 *  join(workDir, entry.path) 词法口径。workDir 含 symlink 组件（macOS /var→/private/var）
 *  时词法前缀永不匹配 realpath 键 → drain no-op、R69-25 守卫失效。此处对书根补
 *  realpath 前缀（失败回退词法），两前缀任一命中即 drain——不改 safe-path.ts 语义。 */
export async function drainFilePutChainsUnder(bookRoot: string): Promise<void> {
  const prefixes = [bookRoot + sep]
  try {
    const real = realpathSync(bookRoot)
    if (real !== bookRoot) prefixes.push(real + sep)
  } catch {
    /* 书根不存在（已删）等 → 只用词法前缀（与修复前口径一致） */
  }
  const pending = [...filePutChains.keys()].filter((k) => prefixes.some((p) => k.startsWith(p)))
  if (pending.length === 0) return
  await Promise.allSettled(pending.map((k) => filePutChains.get(k)))
}

/** R71-10：测试观测钩子（对齐 stream.ts __getSseConnections 风格）——当前在途 PUT 链
 *  键的只读快照（链键口径断言 + drain 等待性测试用；快照时点在途，settle 后自清理）。 */
export function __filePutChainKeysForTest(): readonly string[] {
  return [...filePutChains.keys()]
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
  // R42-39（四十二轮）：.md 判定收敛 isMdFileName（大小写不敏感）——.MD 编辑对象
  // 此前被读写双侧白名单拒绝；basename `._` 前缀跳过条件不变
  if (!isMdFileName(file) || basename(file).startsWith('._')) return null
  const safe = resolveWithinRoot(bookRoot, file)
  if (!safe) return null
  const allowed = EDIT_DIRS.some(({ dir }) => safe.rel === dir || safe.rel.startsWith(`${dir}/`))
  // W-P1-3 作者确认位：细纲.md（推进声明）与 账本推进.md（实际履历行）放行编辑器读写
  if (!allowed && WORKDIR_EDITABLE.has(safe.rel)) return safe.abs
  return allowed ? safe.abs : null
}

/** X-P2-14：写侧白名单 = editablePath 去掉 写作/正文——正文 PUT 走文档保存协议（读侧 doc store 仍按路径读正文）。
 *  R26-9（二十六轮）：返回值带 rel（bookRoot 相对路径）——快照留底 snapshotBeforeOverwrite 按 rel 寻址，免二次解析。 */
function writablePath(bookRoot: string, file: string): { rel: string; abs: string } | null {
  const safe = resolveWithinRoot(bookRoot, file)
  if (!safe) return null
  // R42-39（四十二轮）：.md 判定收敛 isMdFileName（大小写不敏感，与 editablePath 同批）
  if (!isMdFileName(file) || basename(file).startsWith('._')) return null
  if (safe.rel === '写作/正文' || safe.rel.startsWith('写作/正文/')) return null
  const allowed = EDIT_DIRS.some(({ dir }) => safe.rel === dir || safe.rel.startsWith(`${dir}/`))
  if (!allowed && !WORKDIR_EDITABLE.has(safe.rel)) return null
  return { rel: safe.rel, abs: safe.abs }
}

/** R43-1（四十三轮）：PUT /file 的布线锁键——与 DocumentService.wiringFileLockKey /
 *  lead-finalize wiringFileLockKeyOf 同口径（前缀过滤 + join(bookRoot, rel) + win32 折叠），
 *  保证 PUT 直写与保存/定稿履历回写取到**同一个锁文件**（互斥成立）。此前 PUT 白名单
 *  放行 布线/大纲/关系线/ 但临界段不取锁：跨进程下 CLI 定稿持锁 RMW 与 PUT 直写交错，
 *  writeLead 以旧读内容覆盖 PUT 刚落的新内容——无痕丢更新（快照留底的是覆写前旧内容）。 */
function wiringLockKeyForPut(bookRoot: string, rel: string): string | null {
  const p = rel.replace(/\\/g, '/')
  if (p.startsWith('布线/') || p.startsWith('大纲/关系线/')) {
    const key = `${join(bookRoot, rel)}.lock`
    // R38-14 同款 win32 折叠——与两侧既有实现逐位一致（回归锚定同键）
    return process.platform === 'win32' ? key.toLowerCase() : key
  }
  return null
}

