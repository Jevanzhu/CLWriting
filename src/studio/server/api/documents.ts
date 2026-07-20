/**
 * 文档保存 REST 端点（W0-1 §10，W1 仅 PUT content）。
 *
 * - PUT /api/books/:name/documents/:docId/content  走 DocumentService.save
 *
 * docId→path 从项目清单解析（W1 子集）：清单已登记该 docId → 取 path 保存；
 * 旧书无清单或 docId 未登记 → 404（完整 CRUD + legacy 遍历归 W2A）。
 * DocumentService per-bookRoot 单例（模块缓存），跨请求共享串行队列。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readManifest } from '../../../document/manifest.js'
import { DocumentService, type SaveDocumentInput } from '../../../document/service.js'

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
  route(
    'PUT',
    '/api/books/:name/documents/:docId/content',
    async (req: IncomingMessage, res: ServerResponse, params) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return reply(res, r.status, { error: r.error })

      const docId = params['docId'] ?? ''
      // docId → relPath：查项目清单（W1 子集）
      const entry = readManifest(join(r.bookRoot, '项目', '文档清单.jsonl')).entries.get(docId)
      if (!entry) {
        reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `文档ID未在清单登记：${docId}` })
        return
      }

      const input = parseInput(await readJson(req))
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
      const status =
        outcome.code === 'REVISION_CONFLICT' ? 409
        : outcome.code === 'PATH_ESCAPE' ? 400
        : outcome.code === 'CAPABILITY_DENIED' ? 403
        : 500 // WRITE_ERROR
      reply(res, status, { ok: false, code: outcome.code, reason: outcome.reason })
    },
  )
}

const ORIGINS = new Set(['manual', 'autosave', 'restore', 'external-merge'])

/** 解析 + 校验 SaveDocumentInput；非法 → null。 */
function parseInput(body: Record<string, unknown>): SaveDocumentInput | null {
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
