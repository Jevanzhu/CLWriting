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
import { readJson, reply, replyError, parseRequestUrl } from '../http.js'
import { resolveBook } from '../book-context.js'
import { DocumentService, type SaveDocumentInput } from '../../../document/service.js'
import { getBookTreeIndex } from '../../../document/tree.js'
import { finalizeRevisionAsync } from '../../../document/finalize.js' // R30-6（三十轮，批 C 移交收尾）：服务进程切异步孪生
import { afterFinalizeGenerateSummary, afterFinalizeGenerateSummaryBatch } from '../../../process/summary.js'
import { invalidateBookSummary } from './progress.js'
import { acquireTaskGate } from './task-gate.js' // CC-P2-9：批量定稿并发闸
import { readBaseline, appendBaseline, readTodayDelta, todayDate } from '../../../document/words-diary.js'
import { listTrash, restoreTrash, purgeTrash } from '../../../document/trash.js'
import { readForeshadows, type ForeshadowEntry } from '../../../document/foreshadow.js'
import { openSessionStoreAsync, bookHash } from '../../../events/store.js'
import { recordForeshadowChanges } from '../../../events/chain-bridge.js'

interface DocumentCtx {
  workDir: string | null
  /** Z-P2-6：伏笔事件族接线需要（null → 观测层静默跳过） */
  userDataPath: string | null
}

/** X-23（第五十六轮）：批量定稿单次条数上限——每条全量读改写 manifest，超大批量
 *  同步循环会长时间阻塞事件循环；400 为长篇全书待定稿章数的量级上界。 */
const BATCH_FINALIZE_MAX_DOCS = 400

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

/** 第五轮：等该书串行保存队列清空（删书/改名前 drain 用）——在途 save 的收尾
 * （journal+快照+fsync，慢盘几十 ms）若在 rmSync/renameSync 之后恢复，会对已删/
 * 已搬路径 atomicWriteFile 重建孤儿文件。轮询到零或超时（保存秒级异常时放行，
 * 与 settle 超时降级同口径）；无 service 或无在途 → 立即返回。 */
export async function drainDocumentSaves(bookRoot: string, timeoutMs = 2_000): Promise<void> {
  const svc = services.get(bookRoot)
  if (!svc) return
  const deadline = Date.now() + timeoutMs
  while (svc.inFlightSaves() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
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

/** 变更后差分落事件：prev 为 null（非伏笔/快照失败）静默跳过；写失败静默（观测层）。
 *  R34D-19（三十四轮）：转 async——开库走 openSessionStoreAsync（首开锁等待不阻塞
 *  服务事件循环）；两处调用方均在异步 handler 内 await。 */
async function recordForeshadowDelta(
  userDataPath: string | null,
  bookRoot: string,
  prev: ForeshadowEntry[] | null,
): Promise<void> {
  if (!prev || !userDataPath) return
  try {
    const store = await openSessionStoreAsync(userDataPath, bookRoot)
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
      // docId → relPath（含 legacy 旧文件首次补登记，resolvePathAsync → 异步收编孪生——
      // 残留清偿批：原同步 resolvePath 的收编段走 withManifestLock 同步睡，已改异步不再阻塞）
      const path = await svc.resolvePathAsync(docId)
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
        await recordForeshadowDelta(ctx.userDataPath, r.bookRoot, fsPrev)
        reply(res, 200, { ok: true, revision: outcome.revision, superseded: outcome.superseded })
        return
      }
      // CC-P2-11：错误信封统一 {error, code?}——save 结构化失败码保留 code，人话进 error
      // N-2（第十二轮）：收编 replyError 单一出口（信封形状不变，去 reply 手拼）
      replyError(res, structStatus(outcome.code), outcome.code, outcome.reason)
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
      // R-19（第十六轮）：parseRequestUrl 统一解析（Q-1/N-3 口径）——畸形 URL → 400 BAD_INPUT
      const url = parseRequestUrl(req)
      if (!url) return replyError(res, 400, 'BAD_INPUT', 'bad request')
      const refresh = url.searchParams.get('refresh') === '1'
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
      // R30-6（三十轮，批 C 移交收尾）：切异步孪生——锁等待（布线锁/清单锁）走事件
      // 循环轮询原语，不再阻塞 SSE/心跳；语义（超时档/fail-closed/锁序）与同步孪生逐位一致
      const outcome = await finalizeRevisionAsync(r.bookRoot, params['docId'] ?? '')
      if (!outcome.ok) {
        // ee-P1-3：LEAD_GATE → 409（可修复的账实状态冲突，语义与 structStatus 的
        // REVISION_CONFLICT/OCCUPIED 冲突族一致）；ee-P1-4：LEAD_WRITE_ERROR → 500
        // （服务端 IO 故障，作者修复环境后重试）。error 人话原样透传给前端 toast。
        const status =
          outcome.code === 'NOT_FOUND' ? 404
          : outcome.code === 'LEAD_GATE' ? 409
          : outcome.code === 'LEAD_WRITE_ERROR' ? 500
          : 400
        // N-2（第十二轮）：收编 replyError 单一出口（去掉 ok:false 冗余位）
        return replyError(res, status, outcome.code, outcome.error)
      }
      // C1（批 2）定稿即生成章摘要：best-effort fire-and-forget（钩子在 API 层——
      // document/ 禁 import AI 层，依赖方向治理测试守门）；skipped（幂等重定稿）不触发；
      // M-2：带书名登记进后台表，删书/改名/退出的 settle 能追上其落盘
      if (!outcome.skipped) afterFinalizeGenerateSummary(r.bookRoot, ctx.userDataPath ?? null, params['docId'] ?? '', params['name'])
      reply(res, 200, { ok: true, status: outcome.status, skipped: outcome.skipped })
    },
  })

  // ── 批量定稿（P2-PROD-2：一键定稿 ≤目标章号 的全部 revision/draft 章）────────
  // body { docIds: string[] }；逐个 finalizeRevisionAsync（await 串行，天然无 SQLite 写锁冲突；
  // R30-6 三十轮起为异步孪生，锁等待不阻塞事件循环）。
  // 单条失败不中断：返回逐条结果，前端汇总 toast。
  // X-23（第五十六轮）：条数上限——每条 finalizeRevision 各自全量读改写 manifest，
  // 无上限的大批量同步循环会阻塞事件循环数秒（SSE/心跳全停）。400 为长篇全书待定稿
  // 章数的量级上界，超出 fail-fast 提示分批。
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
        if (docIds.length > BATCH_FINALIZE_MAX_DOCS) {
          return replyError(res, 400, 'BAD_INPUT', `批量定稿一次最多 ${BATCH_FINALIZE_MAX_DOCS} 章（本次 ${docIds.length} 章），请分批提交`)
        }
        const summarized: string[] = []
        const results: Array<{ docId: string; ok: boolean; status?: string; skipped?: boolean; error?: string }> = []
        // R30-6（三十轮，批 C 移交收尾）：切异步孪生 finalizeRevisionAsync——逐条 await
        // 串行保持既有「串行天然无 SQLite 写锁冲突」语义，锁等待不再阻塞事件循环。
        // （原同步 map 循环：finalizeRevision 逐条全量读改写 manifest）
        for (const docId of docIds) {
          // ee-P1-3/ee-P1-4：LEAD_GATE / LEAD_WRITE_ERROR 同样作为该文档的失败结果记录
          // （error 人话透传，前端汇总 toast），不中断其余文档的定稿。
          const o = await finalizeRevisionAsync(r.bookRoot, docId)
          // C1（批 2）：批量定稿同样触发章摘要（best-effort；fire-and-forget 不阻塞批量循环；
          // M-2：书名登记进后台表——批量连发多任务也能被 settle 逐个追上）
          if (o.ok && !o.skipped) summarized.push(docId)
          results.push({ docId, ok: o.ok, status: o.ok ? o.status : undefined, skipped: o.ok ? o.skipped : undefined, error: o.ok ? undefined : o.error })
        }
        // 第五轮：批量摘要走串行链——逐章 fire-and-forget 会让一键定稿 N 章 = N 路
        // 摘要 AI 并发（provider 限流整批失败）；整链单条登记，settle 在链首即追上全部
        afterFinalizeGenerateSummaryBatch(r.bookRoot, ctx.userDataPath ?? null, summarized, params['name'])
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
      if (result.ok) await recordForeshadowDelta(ctx.userDataPath, r.bookRoot, fsPrev)
      // Q-7（第十五轮）：失败收编 replyError 统一信封（原裸 result——前端 toast 直显机器码，reason 人话永不见）
      if (result.ok) reply(res, 201, result)
      else replyError(res, structStatus(result.code), result.code, result.reason)
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
      const fsPrev = foreshadowSnapshot(r.bookRoot, await svc.resolvePathAsync(docId))
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
        // 低-3（第十轮）：章号 fail-closed 整数校验——3.5 这类小数旧口径放行后文件名落成
        // 03.5-…（从章号特性脱落）；前端 ChapterMetaDialog 同口径拒收，服务端兜底 400，
        // 也顺带堵住旧实现「章号非法被静默丢弃、只改标题」的半成功
        if (body.章号 !== undefined && (!Number.isInteger(numVal) || numVal < 1)) {
          replyError(res, 400, 'BAD_INPUT', '章号需为正整数')
          return
        }
        if (标题 === undefined && !Number.isFinite(numVal)) {
          replyError(res, 400, 'BAD_INPUT', 'meta 需要 标题 或 章号')
          return
        }
        const metaUpdate: Record<string, unknown> = {}
        if (标题 !== undefined) metaUpdate['标题'] = 标题
        if (Number.isFinite(numVal)) metaUpdate['章号'] = numVal
        result = await svc.updateChapterMeta(docId, metaUpdate) // R31-20：异步孪生
      } else if (body.op === 'fm') {
        const meta = body.meta
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
          replyError(res, 400, 'BAD_INPUT', 'fm 需要 meta 对象')
          return
        }
        result = await svc.updateDocMeta(docId, meta as Record<string, unknown>) // R31-20：异步孪生
      } else {
        replyError(res, 400, 'BAD_INPUT', '未知 op（rename/move/meta/fm）')
        return
      }
      if (result.ok) await recordForeshadowDelta(ctx.userDataPath, r.bookRoot, fsPrev)
      // Q-7（第十五轮）：同上——失败走 replyError 统一信封
      if (result.ok) reply(res, 200, result)
      else replyError(res, structStatus(result.code), result.code, result.reason)
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
      // R-17（第十六轮）：copy 目标落在伏笔域（设定/伏笔/）时同 create/patch 接伏笔
      // 差分事件——此前 copy 绕过 foreshadowSnapshot → recordForeshadowDelta，伏笔
      // md 复制出的新条目不落 foreshadow/change{create}（观测层丢事件）
      const fsPrev = foreshadowSnapshot(r.bookRoot, body.relPath)
      const result = await svc.copyDocument({ docId, relPath: body.relPath })
      // Q-7（第十五轮）：失败走 replyError 统一信封（原裸 result 违反 schema.ts 信封约定）
      if (result.ok) {
        await recordForeshadowDelta(ctx.userDataPath, r.bookRoot, fsPrev)
        reply(res, 201, result)
      } else replyError(res, structStatus(result.code), result.code, result.reason)
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
      const fsPrev = foreshadowSnapshot(r.bookRoot, await svc.resolvePathAsync(docId))
      const result = await svc.trashDocument({ docId })
      if (result.ok) await recordForeshadowDelta(ctx.userDataPath, r.bookRoot, fsPrev)
      // Q-7（第十五轮）：同上——失败走 replyError 统一信封
      if (result.ok) reply(res, 200, result)
      else replyError(res, structStatus(result.code), result.code, result.reason)
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
      const result = await restoreTrash(r.bookRoot, id)
      // Q-7（第十五轮）：失败走 replyError 统一信封（原裸 result 违反 schema.ts 信封约定）
      if (result.ok) reply(res, 200, result)
      else replyError(res, structStatus(result.code), result.code, result.reason)
    },
  })

  defineRoute('books.trash.delete', {
    method: 'DELETE',
    path: '/api/books/:name/trash/:id',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      const id = params['id'] ?? ''
      const result = await purgeTrash(r.bookRoot, id)
      // Q-7（第十五轮）：失败走 replyError 统一信封（原裸 result 违反 schema.ts 信封约定）
      if (result.ok) reply(res, 200, result)
      else replyError(res, structStatus(result.code), result.code, result.reason)
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

