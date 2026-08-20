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
import { defineRoute } from './schema.js'
import { readJson, reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { DocumentService, type SaveDocumentInput } from '../../../document/service.js'
import { getBookTreeIndex } from '../../../document/tree.js'
import { finalizeRevision } from '../../../document/finalize.js'
import { afterFinalizeGenerateSummary } from '../../../process/summary.js'
import { invalidateBookSummary } from './progress.js'
import { acquireTaskGate } from './task-gate.js' // CC-P2-9：批量定稿并发闸
import { readBaseline, appendBaseline, readTodayDelta, todayDate } from '../../../document/words-diary.js'
import { listTrash, restoreTrash, purgeTrash } from '../../../document/trash.js'
import { readForeshadows, type ForeshadowEntry } from '../../../document/foreshadow.js'
import { openSessionStore, bookHash } from '../../../events/store.js'
import { recordForeshadowChanges } from '../../../events/chain-bridge.js'

interface DocumentCtx {
  workDir: string | null
  /** Z-P2-6：伏笔事件族接线需要（null → 观测层静默跳过） */
  userDataPath: string | null
}

/** per-bookRoot DocumentService 缓存（跨请求共享串行队列）。 */
const services = new Map<string, DocumentService>()

/** per-bookRoot DocumentService 缓存（跨请求共享串行队列）。
 *  snapshots.ts 的恢复端点复用同一实例——两个队列会破坏串行写保证。
 *  userDataPath 供写时清理读 global.json 全局保留策略（版本保留三层链）。 */
export function getOrCreateService(bookRoot: string, userDataPath: string | null = null): DocumentService {
  let svc = services.get(bookRoot)
  if (!svc) {
    svc = new DocumentService({ bookRoot, userDataPath })
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

// ── Z-P2-6：伏笔事件族接线（设定/伏笔/*.md 变更 → foreshadow/change 事件）──────
// 快照-差分模式：变更前抓 设定/伏笔/ 全量状态（非伏笔路径 null 免读），变更后
// recordForeshadowChanges 差分落 workspace 会话（与 step/llm 链路事件同会话）。

/** 变更前快照：path 落在 设定/伏笔/ 才读（其余文档零开销直通 null）。 */
function foreshadowSnapshot(bookRoot: string, path: string | null): ForeshadowEntry[] | null {
  if (!path || !path.startsWith('设定/伏笔/')) return null
  try {
    return readForeshadows(bookRoot)
  } catch {
    return null
  }
}

/** 变更后差分落事件：prev 为 null（非伏笔/快照失败）静默跳过；写失败静默（观测层）。 */
function recordForeshadowDelta(
  userDataPath: string | null,
  bookRoot: string,
  prev: ForeshadowEntry[] | null,
): void {
  if (!prev || !userDataPath) return
  try {
    const store = openSessionStore(userDataPath, bookRoot)
    if (!store) return
    try {
      const sessionId = store.workspaceSession(bookHash(bookRoot))
      recordForeshadowChanges(store, sessionId, prev, readForeshadows(bookRoot))
    } finally {
      // L2（二轮复审）：openSessionStore 是引用计数单例——中途抛错（如跨进程 SQLITE_BUSY
      // 超时）不 close 则 refs 永不归零，连接泄漏；同文件其他调用方均为 try/finally 配对
      store.close()
    }
  } catch {
    // 观测层：写失败不炸文档操作
  }
}

export function registerDocumentRoutes(ctx: DocumentCtx): void {
  // ── W1：保存内容 ──────────────────────────────
  defineRoute('books.documents.content', {
    method: 'PUT',
    path: '/api/books/:name/documents/:docId/content',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)

      const docId = params['docId'] ?? ''
      const svc = getOrCreateService(r.bookRoot, ctx.userDataPath)
      // docId → relPath（含 legacy 旧文件首次补登记，service.resolvePath → adoptLegacyDoc）
      const path = svc.resolvePath(docId)
      if (!path) {
        replyError(res, 404, 'NOT_FOUND', `文档ID未在清单登记：${docId}`)
        return
      }
      const input = parseSaveInput(await readJson(req))
      if (!input) {
        replyError(res, 400, 'BAD_INPUT', 'content / expectedRevision / operationId 缺失或类型不符')
        return
      }

      // Z-P2-6：伏笔快照先于保存（差分需要变更前状态）
      const fsPrev = foreshadowSnapshot(r.bookRoot, path)
      const outcome = await svc.save(docId, path, input)
      if (outcome.ok) {
        // V-P2-27：字数变了 → 书架摘要即时失效（不等 5s TTL）
        invalidateBookSummary(r.bookRoot)
        // Z-P2-6：伏笔内容保存（fm 状态变更）→ foreshadow/change 事件
        recordForeshadowDelta(ctx.userDataPath, r.bookRoot, fsPrev)
        reply(res, 200, { ok: true, revision: outcome.revision, superseded: outcome.superseded })
        return
      }
      // CC-P2-11：错误信封统一 {error, code?}——save 结构化失败码保留 code，人话进 error
      reply(res, structStatus(outcome.code), { code: outcome.code, error: outcome.reason })
    },
  })

  // ── W2A：文件树 ──────────────────────────────
  defineRoute('books.tree', {
    method: 'GET',
    path: '/api/books/:name/tree',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
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
  })

  // ── 定稿确认（P1：revision → final，git commit 锁定版本）────────
  defineRoute('books.documents.finalize', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/finalize',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      const outcome = finalizeRevision(r.bookRoot, params['docId'] ?? '')
      if (!outcome.ok) {
        // ee-P1-3：LEAD_GATE → 409（可修复的账实状态冲突，语义与 structStatus 的
        // REVISION_CONFLICT/OCCUPIED 冲突族一致）；ee-P1-4：LEAD_WRITE_ERROR → 500
        // （服务端 IO 故障，作者修复环境后重试）。error 人话原样透传给前端 toast。
        const status =
          outcome.code === 'NOT_FOUND' ? 404
          : outcome.code === 'LEAD_GATE' ? 409
          : outcome.code === 'LEAD_WRITE_ERROR' ? 500
          : 400
        return reply(res, status, { ok: false, code: outcome.code, error: outcome.error })
      }
      // C1（批 2）定稿即生成章摘要：best-effort fire-and-forget（钩子在 API 层——
      // document/ 禁 import AI 层，依赖方向治理测试守门）；skipped（幂等重定稿）不触发
      if (!outcome.skipped) afterFinalizeGenerateSummary(r.bookRoot, ctx.userDataPath ?? null, params['docId'] ?? '')
      reply(res, 200, { ok: true, status: outcome.status, skipped: outcome.skipped })
    },
  })

  // ── 批量定稿（P2-PROD-2：一键定稿 ≤目标章号 的全部 revision/draft 章）────────
  // body { docIds: string[] }；逐个 finalizeRevision（同步串行，天然无 SQLite 写锁冲突）。
  // 单条失败不中断：返回逐条结果，前端汇总 toast。
  defineRoute('books.documents.batch-finalize', {
    method: 'POST',
    path: '/api/books/:name/documents/batch-finalize',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      // CC-P2-9：并发闸——必须在首个 await（readJson）前同步占位，覆盖 body 在途窗口：
      // handler 已持闸悬在 readJson 时，后到的完整请求 409（与 rewrite/outline 闸同口径）。
      // 注：定稿循环全程同步，body 已齐的双击会串行执行——由 finalize 幂等（已定稿 →
      // skipped）兜底，不产生双 commit。
      const release = acquireTaskGate(params['name']!, 'batch-finalize')
      if (!release) {
        return replyError(res, 409, 'BUSY', '本书批量定稿进行中，请等待完成后再试')
      }
      try {
        const body = await readJson(req)
        const docIds = Array.isArray(body?.docIds) ? body.docIds : null
        if (!docIds || docIds.length === 0 || docIds.some((d) => typeof d !== 'string')) {
          return replyError(res, 400, 'BAD_INPUT', 'docIds 必须为非空字符串数组')
        }
        const results = docIds.map((docId) => {
          // ee-P1-3/ee-P1-4：LEAD_GATE / LEAD_WRITE_ERROR 同样作为该文档的失败结果记录
          // （error 人话透传，前端汇总 toast），不中断其余文档的定稿。
          const o = finalizeRevision(r.bookRoot, docId)
          // C1（批 2）：批量定稿同样触发章摘要（best-effort；fire-and-forget 不阻塞批量循环）
          if (o.ok && !o.skipped) afterFinalizeGenerateSummary(r.bookRoot, ctx.userDataPath ?? null, docId)
          return { docId, ok: o.ok, status: o.ok ? o.status : undefined, skipped: o.ok ? o.skipped : undefined, error: o.ok ? undefined : o.error }
        })
        reply(res, 200, { ok: true, results })
      } finally {
        release()
      }
    },
  })

  // ── 字数日记（§5.4 今日基线）──────────────────────
  defineRoute('books.words-diary.get', {
    method: 'GET',
    path: '/api/books/:name/words-diary',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      const date = todayDate()
      reply(res, 200, { ok: true, date, baseline: readBaseline(r.bookRoot, date), delta: readTodayDelta(r.bookRoot, date) })
    },
  })

  defineRoute('books.words-diary.post', {
    method: 'POST',
    path: '/api/books/:name/words-diary',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      const body = await readJson(req)
      const baseline = Number(body?.baseline)
      if (!Number.isFinite(baseline) || baseline < 0) {
        replyError(res, 400, 'BAD_INPUT', 'baseline 需非负数')
        return
      }
      appendBaseline(r.bookRoot, todayDate(), baseline)
      reply(res, 200, { ok: true })
    },
  })

  // ── W2A：新建文档 ──────────────────────────────
  defineRoute('books.documents', {
    method: 'POST',
    path: '/api/books/:name/documents',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      const body = await readJson(req)
      if (typeof body.relPath !== 'string' || !body.relPath) {
        replyError(res, 400, 'BAD_INPUT', 'relPath 缺失')
        return
      }
      const svc = getOrCreateService(r.bookRoot, ctx.userDataPath)
      // Z-P2-6：新建伏笔（create）前快照
      const fsPrev = foreshadowSnapshot(r.bookRoot, body.relPath)
      const result = await svc.createDocument({
        relPath: body.relPath,
        content: typeof body.content === 'string' ? body.content : undefined,
      })
      if (result.ok) recordForeshadowDelta(ctx.userDataPath, r.bookRoot, fsPrev)
      reply(res, result.ok ? 201 : structStatus(result.code), result)
    },
  })

  // ── W2A：移动 / 重命名 ──────────────────────────
  defineRoute('books.documents.patch', {
    method: 'PATCH',
    path: '/api/books/:name/documents/:docId',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      const docId = params['docId'] ?? ''
      const body = await readJson(req)
      const svc = getOrCreateService(r.bookRoot, ctx.userDataPath)
      // Z-P2-6：伏笔快照先于变更（rename/move/meta/fm 都可能改 设定/伏笔/ 状态）
      const fsPrev = foreshadowSnapshot(r.bookRoot, svc.resolvePath(docId))
      let result
      if (body.op === 'rename') {
        if (typeof body.newName !== 'string') {
          replyError(res, 400, 'BAD_INPUT', 'rename 需要 newName')
          return
        }
        result = await svc.renameDocument({ docId, newName: body.newName })
      } else if (body.op === 'move') {
        if (typeof body.toDir !== 'string') {
          replyError(res, 400, 'BAD_INPUT', 'move 需要 toDir')
          return
        }
        result = await svc.moveDocument({ docId, toDir: body.toDir })
      } else if (body.op === 'meta') {
        const 标题 = typeof body.标题 === 'string' ? body.标题 : undefined
        // 章号：长篇/短篇统一用 章号
        const numVal = typeof body.章号 === 'number' || typeof body.章号 === 'string' ? Number(body.章号) : NaN
        if (标题 === undefined && !Number.isFinite(numVal)) {
          replyError(res, 400, 'BAD_INPUT', 'meta 需要 标题 或 章号')
          return
        }
        const metaUpdate: Record<string, unknown> = {}
        if (标题 !== undefined) metaUpdate['标题'] = 标题
        if (Number.isFinite(numVal)) metaUpdate['章号'] = numVal
        result = svc.updateChapterMeta(docId, metaUpdate)
      } else if (body.op === 'fm') {
        const meta = body.meta
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
          replyError(res, 400, 'BAD_INPUT', 'fm 需要 meta 对象')
          return
        }
        result = svc.updateDocMeta(docId, meta as Record<string, unknown>)
      } else {
        replyError(res, 400, 'BAD_INPUT', '未知 op（rename/move/meta/fm）')
        return
      }
      if (result.ok) recordForeshadowDelta(ctx.userDataPath, r.bookRoot, fsPrev)
      reply(res, result.ok ? 200 : structStatus(result.code), result)
    },
  })

  // ── E3.3：复制文档（源 docId + 目标 relPath → 新 docId）──────────
  defineRoute('books.documents.copy', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/copy',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      const docId = params['docId'] ?? ''
      const body = await readJson(req)
      if (typeof body.relPath !== 'string' || !body.relPath) {
        replyError(res, 400, 'BAD_INPUT', 'relPath 缺失')
        return
      }
      const svc = getOrCreateService(r.bookRoot, ctx.userDataPath)
      const result = await svc.copyDocument({ docId, relPath: body.relPath })
      reply(res, result.ok ? 201 : structStatus(result.code), result)
    },
  })

  // ── W2A：软删（→ 回收站）────────────────────────
  defineRoute('books.documents.delete', {
    method: 'DELETE',
    path: '/api/books/:name/documents/:docId',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      const docId = params['docId'] ?? ''
      const svc = getOrCreateService(r.bookRoot, ctx.userDataPath)
      // Z-P2-6：软删伏笔（clear 事件）前快照
      const fsPrev = foreshadowSnapshot(r.bookRoot, svc.resolvePath(docId))
      const result = await svc.trashDocument({ docId })
      if (result.ok) recordForeshadowDelta(ctx.userDataPath, r.bookRoot, fsPrev)
      reply(res, result.ok ? 200 : structStatus(result.code), result)
    },
  })

  // ── W2A：回收站 ──────────────────────────────
  defineRoute('books.trash', {
    method: 'GET',
    path: '/api/books/:name/trash',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      reply(res, 200, { ok: true, entries: listTrash(r.bookRoot) })
    },
  })

  defineRoute('books.trash.restore', {
    method: 'POST',
    path: '/api/books/:name/trash/:id/restore',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      const id = params['id'] ?? ''
      const result = restoreTrash(r.bookRoot, id)
      reply(res, result.ok ? 200 : structStatus(result.code), result)
    },
  })

  defineRoute('books.trash.delete', {
    method: 'DELETE',
    path: '/api/books/:name/trash/:id',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      const id = params['id'] ?? ''
      const result = purgeTrash(r.bookRoot, id)
      reply(res, result.ok ? 200 : structStatus(result.code), result)
    },
  })
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

