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
import { join } from 'node:path'
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readManifest } from '../../../document/manifest.js'
import { DocumentService, type SaveDocumentInput } from '../../../document/service.js'
import { getBookTreeIndex } from '../../../document/tree.js'
import { listTrash, restoreTrash, purgeTrash } from '../../../document/trash.js'

interface DocumentCtx {
  workDir: string | null
}

/** per-bookRoot DocumentService 缓存（跨请求共享串行队列）。 */
const services = new Map<string, DocumentService>()

function getOrCreateService(bookRoot: string): DocumentService {
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

export function registerDocumentRoutes(ctx: DocumentCtx): void {
  // ── W1：保存内容 ──────────────────────────────
  route(
    'PUT',
    '/api/books/:name/documents/:docId/content',
    async (req: IncomingMessage, res: ServerResponse, params) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return reply(res, r.status, { error: r.error })

      const docId = params['docId'] ?? ''
      const entry = readManifest(join(r.bookRoot, '项目', '文档清单.jsonl')).entries.get(docId)
      if (!entry) {
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

      const svc = getOrCreateService(r.bookRoot)
      const outcome = await svc.save(docId, entry.path, input)
      if (outcome.ok) {
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
    async (_req: IncomingMessage, res: ServerResponse, params) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return reply(res, r.status, { error: r.error })
      const index = getBookTreeIndex(r.bookRoot)
      reply(res, 200, {
        ok: true,
        nodes: index.nodes,
        revision: index.revision,
        validatedAt: index.validatedAt,
      })
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
      } else {
        if (typeof body.toDir !== 'string') {
          reply(res, 400, { ok: false, code: 'BAD_INPUT', error: 'move 需要 toDir' })
          return
        }
        result = await svc.moveDocument({ docId, toDir: body.toDir })
      }
      reply(res, result.ok ? 200 : structStatus(result.code), result)
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
