/**
 * 快照 REST 端点（单章版本回滚）。
 *
 * GET  /api/books/:name/documents/:docId/snapshots           → 版本列表（时间/来源/字数）
 * GET  /api/books/:name/documents/:docId/snapshots/:id       → 单个版本内容（预览）
 * POST /api/books/:name/documents/:docId/snapshots/:id/restore → 恢复该版本
 *
 * 恢复走 DocumentService.save + origin='restore'，因此会自动再留一份当前内容的底
 * （maybeSnapshot 的 restore 分支 force 不节流）——恢复本身可再撤销。
 * 复用 documents.ts 的 service 缓存：两个队列会破坏串行写保证。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { listSnapshotEntries, readSnapshot } from '../../../document/snapshot.js'
import { countWords } from '../../../format/words.js'
import { ulid } from '../../../document/stable-id.js'
import { getOrCreateService } from './documents.js'
import type { Revision } from '../../../document/revision.js'

interface SnapshotCtx {
  workDir: string | null
}

/** 定位书 + 文档：返回 bookRoot 与文档相对路径。 */
function resolveDoc(
  workDir: string | null,
  name: string | undefined,
  docId: string,
): { bookRoot: string; relPath: string; snapshotsDir: string } | { error: string; status: number } {
  if (!workDir) return { error: '未定位到工作目录', status: 400 }
  if (!name) return { error: '缺少书名', status: 400 }
  const entry = readBooks(workDir).find((b) => b.name === name)
  if (!entry) return { error: `没有这本书：${name}`, status: 404 }
  const bookRoot = join(workDir, entry.path)
  // docId → relPath（含 legacy 旧文件首次补登记，service.resolvePath → adoptLegacyDoc）
  const relPath = getOrCreateService(bookRoot).resolvePath(docId)
  if (!relPath) return { error: `文档ID未登记：${docId}`, status: 404 }
  return { bookRoot, relPath, snapshotsDir: join(bookRoot, '工作区', '.snapshots') }
}

export function registerSnapshotRoutes(ctx: SnapshotCtx): void {
  // 版本列表（新的在前）
  route(
    'GET',
    '/api/books/:name/documents/:docId/snapshots',
    (_req: IncomingMessage, res: ServerResponse, params) => {
      const docId = params['docId'] ?? ''
      const r = resolveDoc(ctx.workDir, params['name'], docId)
      if ('error' in r) return reply(res, r.status, { ok: false, error: r.error })
      reply(res, 200, { ok: true, entries: listSnapshotEntries(r.snapshotsDir, docId, countWords) })
    },
  )

  // 单个版本内容（预览用）
  route(
    'GET',
    '/api/books/:name/documents/:docId/snapshots/:id',
    (_req: IncomingMessage, res: ServerResponse, params) => {
      const docId = params['docId'] ?? ''
      const r = resolveDoc(ctx.workDir, params['name'], docId)
      if ('error' in r) return reply(res, r.status, { ok: false, error: r.error })
      const snap = readSnapshot(r.snapshotsDir, docId, params['id'] ?? '')
      if (!snap) return reply(res, 404, { ok: false, error: '版本不存在' })
      reply(res, 200, { ok: true, content: snap.content, meta: snap.meta })
    },
  )

  // 恢复：用该版本内容覆盖当前正文（当前内容自动留底）
  route(
    'POST',
    '/api/books/:name/documents/:docId/snapshots/:id/restore',
    async (req: IncomingMessage, res: ServerResponse, params) => {
      const docId = params['docId'] ?? ''
      const r = resolveDoc(ctx.workDir, params['name'], docId)
      if ('error' in r) return reply(res, r.status, { ok: false, error: r.error })
      const snap = readSnapshot(r.snapshotsDir, docId, params['id'] ?? '')
      if (!snap) return reply(res, 404, { ok: false, error: '版本不存在' })

      const body = (await readJson(req)) as { expectedRevision?: unknown }
      const expectedRevision =
        typeof body.expectedRevision === 'string' ? (body.expectedRevision as Revision) : null
      if (expectedRevision === null) {
        return reply(res, 400, { ok: false, code: 'BAD_INPUT', error: 'expectedRevision 必填' })
      }

      const outcome = await getOrCreateService(r.bookRoot).save(docId, r.relPath, {
        content: snap.content,
        expectedRevision,
        operationId: ulid(),
        origin: 'restore',
        reason: `恢复到 ${new Date(snap.meta.time).toLocaleString('zh-CN')} 的版本`,
      })
      if (!outcome.ok) {
        const status = outcome.code === 'REVISION_CONFLICT' ? 409 : 400
        return reply(res, status, { ok: false, code: outcome.code, error: outcome.reason })
      }
      reply(res, 200, { ok: true, revision: outcome.revision, content: snap.content })
    },
  )
}
