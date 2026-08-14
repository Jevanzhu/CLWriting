/**
 * 文档管理 REST 端点（W0-1 §10）。
 *
 * W1：PUT /documents/:docId/content（保存协议）。
 * W2A：GET /tree、POST /documents（新建）、PATCH /documents/:docId（move/rename）、
 *      DELETE /documents/:docId（软删）；GET /trash、POST /trash/:id/restore、DELETE /trash/:id（永久删）。
 *
 * docId→path 从项目清单解析；DocumentService per-bookRoot 单例（跨请求共享串行队列）。
 * 写端点的 Origin 白名单 + x-studio-token 校验由 server/index.ts 统一拦截（defense-in-depth）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { resolveBook } from '../book-context.js'
import { DocumentService, type SaveDocumentInput } from '../../../document/service.js'
import { getBookTreeIndex } from '../../../document/tree.js'
import { finalizeRevision } from '../../../document/finalize.js'
import { invalidateBookSummary } from './progress.js'
import { readBaseline, appendBaseline, readTodayDelta, todayDate } from '../../../document/words-diary.js'
import { listTrash, restoreTrash, purgeTrash } from '../../../document/trash.js'

interface DocumentCtx {
  workDir: string | null
}

/** per-bookRoot DocumentService 缓存（跨请求共享串行队列）。 */
const services = new Map<string, DocumentService>()

/** per-bookRoot DocumentService 缓存（跨请求共享串行队列）。
 *  snapshots.ts 的恢复端点复用同一实例——两个队列会破坏串行写保证。 */
export function getOrCreateService(bookRoot: string): DocumentService {
  let svc = services.get(bookRoot)
  if (!svc) {
    svc = new DocumentService({ bookRoot })
    services.set(bookRoot, svc)
  }
  return svc
}

/** 测试用：清空 service 缓存（避免跨用例串行队列泄漏）。 */
export function __clearDocumentServices(): void {
  services.clear()
}

/** 删书时清理对应 bookRoot 的 service 缓存（防同 path 重建复用旧实例）。 */
export function forgetService(bookRoot: string): void {
  services.delete(bookRoot)
}

export function registerDocumentRoutes(ctx: DocumentCtx): void {
  // ── W1：保存内容 ──────────────────────────────
  route(
    'PUT',
    '/api/books/:name/documents/:docId/content',
    async (req: IncomingMessage, res: ServerResponse, params) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return reply(res, r.status, { error: r.error })

      const docId = params['docId'] ?? ''
      const svc = getOrCreateService(r.bookRoot)
      // docId → relPath（含 legacy 旧文件首次补登记，service.resolvePath → adoptLegacyDoc）
      const path = svc.resolvePath(docId)
      if (!path) {
        reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `文档ID未在清单登记：${docId}` })
        return
      }
      const input = parseSaveInput(await readJson(req))
      if (!input) {
        reply(res, 400, {
          ok: false,
          code: 'BAD_INPUT',
          error: 'content / expectedRevision / operationId 缺失或类型不符',
        })
        return
      }

      const outcome = await svc.save(docId, path, input)
      if (outcome.ok) {
        // V-P2-27：字数变了 → 书架摘要即时失效（不等 5s TTL）
        invalidateBookSummary(r.bookRoot)
        reply(res, 200, { ok: true, revision: outcome.revision, superseded: outcome.superseded })
        return
      }
      reply(res, structStatus(outcome.code), { ok: false, code: outcome.code, reason: outcome.reason })
    },
  )

  // ── W2A：文件树 ──────────────────────────────
  route(
    'GET',
    '/api/books/:name/tree',
    async (req: IncomingMessage, res: ServerResponse, params) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return reply(res, r.status, { error: r.error })
      // refresh=1：丢缓存重扫（外部编辑器/CLI 改盘不经 invalidateTreeIndex）
      const refresh = new URL(req.url ?? '/', 'http://localhost').searchParams.get('refresh') === '1'
      const index = getBookTreeIndex(r.bookRoot, refresh)
      reply(res, 200, {
        ok: true,
        nodes: index.nodes,
        revision: index.revision,
        validatedAt: index.validatedAt,
      })
    },
  )

  // ── 定稿确认（P1：revision → final，git commit 锁定版本）────────
  route(
    'POST',
    '/api/books/:name/documents/:docId/finalize',
    async (_req: IncomingMessage, res: ServerResponse, params) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return reply(res, r.status, { error: r.error })
      const outcome = finalizeRevision(r.bookRoot, params['docId'] ?? '')
      if (!outcome.ok) {
        const status = outcome.code === 'NOT_FOUND' ? 404 : 400
        return reply(res, status, { ok: false, code: outcome.code, error: outcome.error })
      }
      reply(res, 200, { ok: true, status: outcome.status, skipped: outcome.skipped })
    },
  )

  // ── 批量定稿（P2-PROD-2：一键定稿 ≤目标章号 的全部 revision/draft 章）────────
  // body { docIds: string[] }；逐个 finalizeRevision（同步串行，天然无 SQLite 写锁冲突）。
  // 单条失败不中断：返回逐条结果，前端汇总 toast。
  route(
    'POST',
    '/api/books/:name/documents/batch-finalize',
    async (req: IncomingMessage, res: ServerResponse, params) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return reply(res, r.status, { error: r.error })
      const body = await readJson(req)
      const docIds = Array.isArray(body?.docIds) ? body.docIds : null
      if (!docIds || docIds.length === 0 || docIds.some((d) => typeof d !== 'string')) {
        return reply(res, 400, { ok: false, code: 'BAD_INPUT', error: 'docIds 必须为非空字符串数组' })
      }
      const results = docIds.map((docId) => {
        const o = finalizeRevision(r.bookRoot, docId)
        return { docId, ok: o.ok, status: o.ok ? o.status : undefined, skipped: o.ok ? o.skipped : undefined, error: o.ok ? undefined : o.error }
      })
      reply(res, 200, { ok: true, results })
    },
  )

  // ── 字数日记（§5.4 今日基线）──────────────────────
  route(
    'GET',
    '/api/books/:name/words-diary',
    async (_req: IncomingMessage, res: ServerResponse, params) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return reply(res, r.status, { error: r.error })
      const date = todayDate()
      reply(res, 200, { ok: true, date, baseline: readBaseline(r.bookRoot, date), delta: readTodayDelta(r.bookRoot, date) })
    },
  )

  route(
    'POST',
    '/api/books/:name/words-diary',
    async (req: IncomingMessage, res: ServerResponse, params) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return reply(res, r.status, { error: r.error })
      const body = await readJson(req)
      const baseline = Number(body?.baseline)
      if (!Number.isFinite(baseline) || baseline < 0) {
        reply(res, 400, { ok: false, code: 'BAD_INPUT', error: 'baseline 需非负数' })
        return
      }
      appendBaseline(r.bookRoot, todayDate(), baseline)
      reply(res, 200, { ok: true })
    },
  )

  // ── W2A：新建文档 ──────────────────────────────
  route(
    'POST',
    '/api/books/:name/documents',
    async (req: IncomingMessage, res: ServerResponse, params) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return reply(res, r.status, { error: r.error })
      const body = await readJson(req)
      if (typeof body.relPath !== 'string' || !body.relPath) {
        reply(res, 400, { ok: false, code: 'BAD_INPUT', error: 'relPath 缺失' })
        return
      }
      const svc = getOrCreateService(r.bookRoot)
      const result = await svc.createDocument({
        relPath: body.relPath,
        content: typeof body.content === 'string' ? body.content : undefined,
      })
      reply(res, result.ok ? 201 : structStatus(result.code), result)
    },
  )

  // ── W2A：移动 / 重命名 ──────────────────────────
  route(
    'PATCH',
    '/api/books/:name/documents/:docId',
    async (req: IncomingMessage, res: ServerResponse, params) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return reply(res, r.status, { error: r.error })
      const docId = params['docId'] ?? ''
      const body = await readJson(req)
      const svc = getOrCreateService(r.bookRoot)
      let result
      if (body.op === 'rename') {
        if (typeof body.newName !== 'string') {
          reply(res, 400, { ok: false, code: 'BAD_INPUT', error: 'rename 需要 newName' })
          return
        }
        result = await svc.renameDocument({ docId, newName: body.newName })
      } else if (body.op === 'move') {
        if (typeof body.toDir !== 'string') {
          reply(res, 400, { ok: false, code: 'BAD_INPUT', error: 'move 需要 toDir' })
          return
        }
        result = await svc.moveDocument({ docId, toDir: body.toDir })
      } else if (body.op === 'meta') {
        const 标题 = typeof body.标题 === 'string' ? body.标题 : undefined
        // 章号：长篇/短篇统一用 章号
        const numVal = typeof body.章号 === 'number' || typeof body.章号 === 'string' ? Number(body.章号) : NaN
        if (标题 === undefined && !Number.isFinite(numVal)) {
          reply(res, 400, { ok: false, code: 'BAD_INPUT', error: 'meta 需要 标题 或 章号' })
          return
        }
        const metaUpdate: Record<string, unknown> = {}
        if (标题 !== undefined) metaUpdate['标题'] = 标题
        if (Number.isFinite(numVal)) metaUpdate['章号'] = numVal
        result = svc.updateChapterMeta(docId, metaUpdate)
      } else if (body.op === 'fm') {
        const meta = body.meta
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
          reply(res, 400, { ok: false, code: 'BAD_INPUT', error: 'fm 需要 meta 对象' })
          return
        }
        result = svc.updateDocMeta(docId, meta as Record<string, unknown>)
      } else {
        reply(res, 400, { ok: false, code: 'BAD_INPUT', error: '未知 op（rename/move/meta/fm）' })
        return
      }
      reply(res, result.ok ? 200 : structStatus(result.code), result)
    },
  )

  // ── E3.3：复制文档（源 docId + 目标 relPath → 新 docId）──────────
  route(
    'POST',
    '/api/books/:name/documents/:docId/copy',
    async (req: IncomingMessage, res: ServerResponse, params) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return reply(res, r.status, { error: r.error })
      const docId = params['docId'] ?? ''
      const body = await readJson(req)
      if (typeof body.relPath !== 'string' || !body.relPath) {
        reply(res, 400, { ok: false, code: 'BAD_INPUT', error: 'relPath 缺失' })
        return
      }
      const svc = getOrCreateService(r.bookRoot)
      const result = await svc.copyDocument({ docId, relPath: body.relPath })
      reply(res, result.ok ? 201 : structStatus(result.code), result)
    },
  )

  // ── W2A：软删（→ 回收站）────────────────────────
  route(
    'DELETE',
    '/api/books/:name/documents/:docId',
    async (_req: IncomingMessage, res: ServerResponse, params) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return reply(res, r.status, { error: r.error })
      const docId = params['docId'] ?? ''
      const svc = getOrCreateService(r.bookRoot)
      const result = await svc.trashDocument({ docId })
      reply(res, result.ok ? 200 : structStatus(result.code), result)
    },
  )

  // ── W2A：回收站 ──────────────────────────────
  route(
    'GET',
    '/api/books/:name/trash',
    async (_req: IncomingMessage, res: ServerResponse, params) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return reply(res, r.status, { error: r.error })
      reply(res, 200, { ok: true, entries: listTrash(r.bookRoot) })
    },
  )

  route(
    'POST',
    '/api/books/:name/trash/:id/restore',
    async (_req: IncomingMessage, res: ServerResponse, params) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return reply(res, r.status, { error: r.error })
      const id = params['id'] ?? ''
      const result = restoreTrash(r.bookRoot, id)
      reply(res, result.ok ? 200 : structStatus(result.code), result)
    },
  )

  route(
    'DELETE',
    '/api/books/:name/trash/:id',
    async (_req: IncomingMessage, res: ServerResponse, params) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return reply(res, r.status, { error: r.error })
      const id = params['id'] ?? ''
      const result = purgeTrash(r.bookRoot, id)
      reply(res, result.ok ? 200 : structStatus(result.code), result)
    },
  )
}

const ORIGINS = new Set(['manual', 'autosave', 'restore', 'external-merge'])

/** 解析 + 校验 SaveDocumentInput；非法 → null。 */
function parseSaveInput(body: Record<string, unknown>): SaveDocumentInput | null {
  if (typeof body.content !== 'string') return null
  if (typeof body.operationId !== 'string') return null
  const er = body.expectedRevision
  let expectedRevision: SaveDocumentInput['expectedRevision']
  if (er === null) expectedRevision = null
  else if (typeof er === 'string' && er.startsWith('sha256:')) {
    expectedRevision = er as `sha256:${string}`
  } else return null
  const origin = ORIGINS.has(body.origin as string)
    ? (body.origin as SaveDocumentInput['origin'])
    : 'manual'
  const input: SaveDocumentInput = {
    content: body.content,
    expectedRevision,
    operationId: body.operationId,
    origin,
  }
  if (typeof body.reason === 'string') input.reason = body.reason
  return input
}

/** 结构性操作错误码 → HTTP status（W2A §8）。 */
function structStatus(code: string): number {
  switch (code) {
    case 'NOT_FOUND':
      return 404
    case 'CAPABILITY_DENIED':
      return 403
    case 'PATH_ESCAPE':
    case 'BAD_INPUT':
      return 400
    case 'ALREADY_EXISTS':
    case 'OCCUPIED':
    case 'REVISION_CONFLICT':
      return 409
    case 'WRITE_ERROR':
      return 500
    default:
      return 500
  }
}

