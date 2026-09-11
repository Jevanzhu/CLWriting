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
import { resolveBook, bookMovedFailure } from '../book-context.js'
import {
  DocumentService,
  type CopyResult,
  type CreateResult,
  type MoveResult,
  type SaveDocumentInput,
  type SaveOutcome,
  type TrashResult,
} from '../../../document/service.js'
import { getBookTreeIndex } from '../../../document/tree.js'
import { finalizeRevisionAsync } from '../../../document/finalize.js' // R30-6（三十轮，批 C 移交收尾）：服务进程切异步孪生
import { afterFinalizeGenerateSummary, afterFinalizeGenerateSummaryBatch } from '../../../process/summary.js'
// R0912（重评-0911c P2）：定稿摘要后台任务的中断接线——driver 会话惰性取得后传入
// 钩子，后台摘要/批量链持独立登记 ctrl（/interrupt 可中止）；未接线形态（session
// 取得失败）退化为不登记，与修复前等价
import { ensureSession, getDriver } from '../../../driver/index.js'
import { invalidateBookSummary } from './progress.js'
import { acquireTaskGate } from './task-gate.js' // CC-P2-9：批量定稿并发闸
import { readBaseline, appendBaseline, readTodayDelta, todayDate } from '../../../document/words-diary.js'
import { listTrash, restoreTrash, purgeTrash } from '../../../document/trash.js'
import { readForeshadows, type ForeshadowEntry } from '../../../document/foreshadow.js'
import { openSessionStoreAsync, bookHash } from '../../../events/store.js'
import { recordForeshadowChanges } from '../../../events/chain-bridge.js'
import { log } from '../../../log/index.js' // R43-23（四十三轮）：伏笔观测层失败留痕

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

/** 变更前快照：path 落在 设定/伏笔/ 才读（其余文档零开销直通 null）。
 *  R43-23（四十三轮）：docId 仅作失败留痕的因果标注（对齐 R67-7）。 */
function foreshadowSnapshot(bookRoot: string, path: string | null, docId: string): ForeshadowEntry[] | null {
  if (!path || !path.startsWith('设定/伏笔/')) return null
  try {
    return readForeshadows(bookRoot)
  } catch (e) {
    // R43-23（四十三轮）：空 catch 补留痕——快照失败静默返回 null 时本轮变更不落
    // foreshadow/change 事件且无从排查（观测层缺一段差分）；带 docId 因果
    log.warn('api', `伏笔快照读取失败（docId=${docId}），本轮变更不落 foreshadow/change 事件：${e instanceof Error ? e.message : String(e)}`)
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
  /** R43-23（四十三轮）：失败留痕的因果标注（对齐 R67-7） */
  docId: string,
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
  } catch (e) {
    // 观测层：写失败不炸文档操作
    // R43-23（四十三轮）：空 catch 补留痕——差分落库失败静默时本轮伏笔事件缺失
    // 无从排查（文档操作本身已成功，事件链断在观测层）；带 docId 因果
    log.warn('api', `伏笔差分落事件失败（docId=${docId}，本轮伏笔变更未记录）：${e instanceof Error ? e.message : String(e)}`)
  }
}

// ── 重评2-P3-①（2026-09-09 全量重评 GLM-5.3）：伏笔保存 per-book 串行链 ─────────
// 原 PUT content 的 foreshadowSnapshot 读在 svc.save 的 per-docId 串行队列之外：两
// 并发保存交叠时双方快照基线同取前者变更前的状态，而 recordForeshadowDelta 的差分
// 读的是「当刻」全量状态——后落库的一方会把先落库者的变更一并计入自己的差分窗
// （事件流重复计窗）。现把「快照读 → save → 差分落事件」整段挂到 per-bookRoot
// promise 链上串行执行：后继单元的快照基线必然已含前继单元落库的变更，差分各归
// 各窗。仅伏笔域路径入链（非伏笔保存零开销、并行性不变）；链上单元失败不阻断后继
// （prev.then(unit, unit)），观测层串行不引入新的失败面；伏笔正本保存语义零变更
// （save 仍在原链路原样执行，只是调度位置移入临界段）。
// 清偿-伏笔接线×4（2026-09-09 残留清偿批）：PATCH（fm/rename/move/meta 共用 handler）、
// 新建、软删、copy 四处同型「快照读在链外」残留一并收口——各操作「快照读 → op → 差分」
// 整段入链，链内单元语义按各操作适配：新建/软删/copy 改 docId 集合，差分基线仍取
// 「本单元 op 前的全域快照」（差分是全域标题集对比，recordForeshadowChanges），链内
// 串行保证前继单元落库的增删改必在基线中，事件各归各窗。死锁核查：四处 op 体走
// SaveQueue（save）/chainDocMetaOp（meta/fm）/清单·回收站锁（create/copy/trash/
// rename/move），均只被链单元单向 await、从不反等本链，外链→内链/锁单向无环；
// drainDocumentSaves 只计 SaveQueue 在途，四处本就不入该计数，链化无顺序回归。
const foreshadowSaveChains = new Map<string, Promise<unknown>>()
function runInForeshadowSaveChain<T>(bookRoot: string, unit: () => Promise<T>): Promise<T> {
  const prev = foreshadowSaveChains.get(bookRoot) ?? Promise.resolve()
  const next = prev.then(unit, unit) // 前驱成败都接续
  // 链尾吞错防 unhandled rejection（单元错误由本单元 await 侧经 dispatch 兜底 500）
  const settled = next.catch(() => {})
  foreshadowSaveChains.set(bookRoot, settled)
  // R1010b-SRV-P3-1（2026-09-10 内存专项重审修复批）：链尾自清理——原实现 settled
  // 条目常驻 Map，进过伏笔操作的书每本留一条死 Promise 永不回收（服务进程长期驻留
  // 的桌面场景纯内存死重）。照 files.ts enqueueFilePut 先例：settle 后身份校验
  // delete（settle 窗口内该书新单元已 set 的新链尾不得误删）。
  void settled.then(() => {
    if (foreshadowSaveChains.get(bookRoot) === settled) foreshadowSaveChains.delete(bookRoot)
  })
  return next
}

/** R1010b-SRV-P2-1（2026-09-10 内存专项重审修复批·面 B）：等该书伏笔串行链尾排空
 *  ——删书/改名前 drain（与 drainDocumentSaves / drainFilePutChainsUnder 同型）。
 *  竞态时序：已入队未启动的伏笔单元在 SaveQueue 之外（drainDocumentSaves 只计在途
 *  save，本链不可见——:148 旧注自认），不 drain 则删书/改名后链单元才开跑、照写旧
 *  捕获 bookRoot 落孤儿文件。快照式（同 drainFilePutChainsUnder 口径）：只等快照
 *  时点的链尾，drain 窗口内新进单元不等——其安全由单元体内书注册重验（409
 *  BOOK_MOVED）兜底。死锁核查：链单元只单向 await SaveQueue / 清单·回收站锁 /
 *  save·布线锁，从不反等 books 侧任何锁，drain 置于 books.ts 既有两 drain 之后不
 *  引入环。无条目即立即 resolve。 */
export async function drainForeshadowSaveChains(bookRoot: string): Promise<void> {
  const tail = foreshadowSaveChains.get(bookRoot)
  if (!tail) return
  await tail
}

/** R1010b-SRV-P3-1：删书/改名按书清理伏笔链 Map 条目（对齐 forgetService 等既有
 *  forgetBookKeyedCaches 挂点形态）——链尾自清理已覆盖常态，此处兜悬挂残条。 */
export function forgetForeshadowSaveChain(bookRoot: string): void {
  foreshadowSaveChains.delete(bookRoot)
}

/** R1010b-SRV-P3-1：测试观测钩子（对齐 files.ts __filePutChainKeysForTest 风格）——
 *  当前在途伏笔链键的只读快照（自清理/forget 生效断言用；快照时点在途，settle 后
 *  自清理）。 */
export function __foreshadowSaveChainKeysForTest(): readonly string[] {
  return [...foreshadowSaveChains.keys()]
}

// ── R1010b-SRV-P2-1（2026-09-10 内存专项重审修复批·面 A）：书注册重验 ─────────
// 五处链内写单元（PUT content / PATCH / 新建 / 软删 / copy）的临界段首行防线；重验
// 竞态时序与防线形态单源见 book-context.ts R0912-B-P3-2 头注（R0912-B-P3-2 起四处
// 本地拷贝收敛到 book-context.ts）。本文件特有：SaveOutcome/CreateResult 等失败
// code 联合在 src/document/service.ts 是闭集合（本批不越界改源），BOOK_MOVED 以
// 本地等价形状（ok:false + code + reason，下方 BookMovedFailure）扩展，出口统一经
// structStatus（随批补 409 映射）走 replyError 单一出口，信封形状与其他结构化失败一致。

/** 书注册重验失败的结构化出口（BOOK_MOVED 本地扩展形状，见上节头注）。 */
type BookMovedFailure = { ok: false; code: 'BOOK_MOVED'; reason: string }

/** R0912-B-P3-2：单源重验（book-context.ts）的本文件包装——链单元返回联合以 ok
 *  判别（SaveOutcome/CreateResult/MoveResult 均以 ok:true 成功判定），核心对象补
 *  ok:false 组合，响应契约逐字节不变。 */
function bookMovedFailureOk(ctx: DocumentCtx, name: string | undefined, capturedRoot: string): BookMovedFailure | null {
  const moved = bookMovedFailure(ctx.workDir, name, capturedRoot)
  return moved === null ? null : { ...moved, ok: false }
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

      // Z-P2-6：伏笔快照先于保存（差分需要变更前状态）。
      // 重评2-P3-①：伏笔域保存（快照读→save→差分落事件）整段入 per-book 串行链
      // ——并发保存交叠不再重复计窗；非伏笔路径不进链（快照直通 null、零差分，
      // 保存并行性不变）。
      // R1010b-SRV-P2-1 面 A：重验在 runSave 内——非伏笔直调路径天然同覆盖，伏笔链
      // 路径在链单元开跑时刻重验（竞态时序见 bookMovedFailure 头注）。
      const runSave = async (): Promise<SaveOutcome | BookMovedFailure> => {
        const moved = bookMovedFailureOk(ctx, params['name'], r.bookRoot)
        if (moved) return moved
        const fsPrev = foreshadowSnapshot(r.bookRoot, path, docId) // R43-23：docId 留痕因果
        const o = await svc.save(docId, path, input)
        if (o.ok) {
          // V-P2-27：字数变了 → 书架摘要即时失效（不等 5s TTL）
          invalidateBookSummary(r.bookRoot)
          // Z-P2-6：伏笔内容保存（fm 状态变更）→ foreshadow/change 事件
          await recordForeshadowDelta(ctx.userDataPath, r.bookRoot, fsPrev, docId) // R43-23：docId 留痕因果
        }
        return o
      }
      const outcome = await (path.startsWith('设定/伏笔/')
        ? runInForeshadowSaveChain(r.bookRoot, runSave)
        : runSave())
      if (outcome.ok) {
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
      // R0912：driver 会话惰性取得后再挂钩子——ensureSession 窗口内任务尚未启动
      // （零 AI 调用/零落盘），M-2 登记稍迟无逃逸面；session 失败 → 不登记（修复前等价）
      if (!outcome.skipped) {
        void (async (): Promise<void> => {
          const session = await ensureSession(params['name']!, ctx.workDir!).catch((): undefined => undefined)
          afterFinalizeGenerateSummary(r.bookRoot, ctx.userDataPath ?? null, params['docId'] ?? '', params['name'], getDriver(), session)
        })()
      }
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
        // R0912：同上——惰性取得 driver 会话后接线（中断对链上在途与未开跑的章一并生效）
        void (async (): Promise<void> => {
          const session = await ensureSession(params['name']!, ctx.workDir!).catch((): undefined => undefined)
          afterFinalizeGenerateSummaryBatch(r.bookRoot, ctx.userDataPath ?? null, summarized, params['name'], getDriver(), session)
        })()
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
      // R1010b-SRV-P2-1 面 A（2026-09-10 内存专项重审修复批·同型扫描接线）：await
      // readJson 可跨删书/改名 drain 时点，appendBaseline 对旧捕获路径 mkdir recursive
      // + append 成孤儿——写前与五处链内单元同款书注册重验（时序见 bookMovedFailure 头注）
      const moved = bookMovedFailure(ctx.workDir, params['name'], r.bookRoot)
      if (moved) return replyError(res, structStatus(moved.code), moved.code, moved.reason)
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
      const relPath = body.relPath
      if (typeof relPath !== 'string' || !relPath) {
        replyError(res, 400, 'BAD_INPUT', 'relPath 缺失')
        return
      }
      const svc = getOrCreateService(r.bookRoot, ctx.userDataPath)
      // 清偿-伏笔接线×4（2026-09-09 残留清偿批）②：新建——「快照读 → create → 差分」
      // 整段入 per-book 伏笔串行链（同 PUT 重评2-P3-① 口径）：并发交叠不再重复计窗；
      // 非伏笔域目标不进链。新建前无 docId，以 relPath 作留痕因果标注。
      // R1010b-SRV-P2-1 面 A：单元体首行重验书注册（同 runSave 口径）
      const runCreate = async (): Promise<CreateResult | BookMovedFailure> => {
        const moved = bookMovedFailureOk(ctx, params['name'], r.bookRoot)
        if (moved) return moved
        // Z-P2-6：新建伏笔（create）前快照（差分需要变更前状态；新建改 docId 集合，
        // 基线取本单元 create 前全域状态，链内前继落库变更必在基线中）
        const fsPrev = foreshadowSnapshot(r.bookRoot, relPath, relPath) // R43-23：relPath 留痕因果
        const result = await svc.createDocument({
          relPath,
          content: typeof body.content === 'string' ? body.content : undefined,
        })
        if (result.ok) await recordForeshadowDelta(ctx.userDataPath, r.bookRoot, fsPrev, result.docId) // R43-23：docId 留痕因果
        return result
      }
      const result = await (relPath.startsWith('设定/伏笔/')
        ? runInForeshadowSaveChain(r.bookRoot, runCreate)
        : runCreate())
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
      // docId → relPath：仅作伏笔域判定（rename/move/meta/fm 各自内部会再解析登记路径）
      const docPath = await svc.resolvePathAsync(docId)
      // 清偿-伏笔接线×4（2026-09-09 残留清偿批）①：PATCH——op=fm 改伏笔状态最常用，
      // rename/move/meta 与其共用同一 handler 差分接线：「快照读 → op → 差分」整段入
      // per-book 伏笔串行链（同 PUT 重评2-P3-① 口径），并发交叠不再重复计窗。op 形状
      // 校验失败在链单元内同步回复即出链（400 不产生差分、不长时间占链位；返回
      // undefined = 响应已发）。
      // R1010b-SRV-P2-1 面 A：单元体首行重验书注册（同 runSave 口径；undefined 仍 =
      // op 形状校验失败在单元内已回 400）
      const runPatch = async (): Promise<MoveResult | undefined | BookMovedFailure> => {
        const moved = bookMovedFailureOk(ctx, params['name'], r.bookRoot)
        if (moved) return moved
        // Z-P2-6：伏笔快照先于变更（rename/move/meta/fm 都可能改 设定/伏笔/ 状态）
        const fsPrev = foreshadowSnapshot(r.bookRoot, docPath, docId) // R43-23：docId 留痕因果
        let result: MoveResult | undefined
        if (body.op === 'rename') {
          if (typeof body.newName !== 'string') {
            replyError(res, 400, 'BAD_INPUT', 'rename 需要 newName')
            return undefined
          }
          result = await svc.renameDocument({ docId, newName: body.newName })
        } else if (body.op === 'move') {
          if (typeof body.toDir !== 'string') {
            replyError(res, 400, 'BAD_INPUT', 'move 需要 toDir')
            return undefined
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
            return undefined
          }
          if (标题 === undefined && !Number.isFinite(numVal)) {
            replyError(res, 400, 'BAD_INPUT', 'meta 需要 标题 或 章号')
            return undefined
          }
          const metaUpdate: Record<string, unknown> = {}
          if (标题 !== undefined) metaUpdate['标题'] = 标题
          if (Number.isFinite(numVal)) metaUpdate['章号'] = numVal
          result = await svc.updateChapterMeta(docId, metaUpdate) // R31-20：异步孪生
        } else if (body.op === 'fm') {
          const meta = body.meta
          if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
            replyError(res, 400, 'BAD_INPUT', 'fm 需要 meta 对象')
            return undefined
          }
          result = await svc.updateDocMeta(docId, meta as Record<string, unknown>) // R31-20：异步孪生
        } else {
          replyError(res, 400, 'BAD_INPUT', '未知 op（rename/move/meta/fm）')
          return undefined
        }
        if (result.ok) await recordForeshadowDelta(ctx.userDataPath, r.bookRoot, fsPrev, docId) // R43-23：docId 留痕因果
        return result
      }
      const result = await (docPath !== null && docPath.startsWith('设定/伏笔/')
        ? runInForeshadowSaveChain(r.bookRoot, runPatch)
        : runPatch())
      if (result === undefined) return // op 形状校验失败：链单元内已回 400
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
      const relPath = body.relPath
      if (typeof relPath !== 'string' || !relPath) {
        replyError(res, 400, 'BAD_INPUT', 'relPath 缺失')
        return
      }
      const svc = getOrCreateService(r.bookRoot, ctx.userDataPath)
      // 清偿-伏笔接线×4（2026-09-09 残留清偿批）④：copy——「快照读 → copy → 差分」
      // 整段入 per-book 伏笔串行链（同 PUT 重评2-P3-① 口径）：复制出的新条目 create
      // 事件各归各窗，非伏笔域目标不进链。
      // R1010b-SRV-P2-1 面 A：单元体首行重验书注册（同 runSave 口径）
      const runCopy = async (): Promise<CopyResult | BookMovedFailure> => {
        const moved = bookMovedFailureOk(ctx, params['name'], r.bookRoot)
        if (moved) return moved
        // R-17（第十六轮）：copy 目标落在伏笔域（设定/伏笔/）时同 create/patch 接伏笔
        // 差分事件——此前 copy 绕过 foreshadowSnapshot → recordForeshadowDelta，伏笔
        // md 复制出的新条目不落 foreshadow/change{create}（观测层丢事件）
        const fsPrev = foreshadowSnapshot(r.bookRoot, relPath, docId) // R43-23：源 docId 作留痕因果
        const result = await svc.copyDocument({ docId, relPath })
        if (result.ok) await recordForeshadowDelta(ctx.userDataPath, r.bookRoot, fsPrev, result.docId) // R43-23：新 docId 留痕因果
        return result
      }
      const result = await (relPath.startsWith('设定/伏笔/')
        ? runInForeshadowSaveChain(r.bookRoot, runCopy)
        : runCopy())
      // Q-7（第十五轮）：失败走 replyError 统一信封（原裸 result 违反 schema.ts 信封约定）
      if (result.ok) {
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
      // docId → relPath：仅作伏笔域判定（trashDocument 内部自会再解析）
      const docPath = await svc.resolvePathAsync(docId)
      // 清偿-伏笔接线×4（2026-09-09 残留清偿批）③：软删——「快照读 → trash → 差分」
      // 整段入 per-book 伏笔串行链（同 PUT 重评2-P3-① 口径）：软删改 docId 集合（−1）
      // 且把文件移出 设定/伏笔/，快照仍取本单元 trash 前全域状态（条目在册）、差分读
      // 在 trashDocument 落定之后（条目已移出）→ clear 事件各归各窗；链内串行保证
      // 他单元的增删不混入本单元差分窗。
      // R1010b-SRV-P2-1 面 A：单元体首行重验书注册（同 runSave 口径）
      const runTrash = async (): Promise<TrashResult | BookMovedFailure> => {
        const moved = bookMovedFailureOk(ctx, params['name'], r.bookRoot)
        if (moved) return moved
        // Z-P2-6：软删伏笔（clear 事件）前快照
        const fsPrev = foreshadowSnapshot(r.bookRoot, docPath, docId) // R43-23：docId 留痕因果
        const result = await svc.trashDocument({ docId })
        if (result.ok) await recordForeshadowDelta(ctx.userDataPath, r.bookRoot, fsPrev, docId) // R43-23：docId 留痕因果
        return result
      }
      const result = await (docPath !== null && docPath.startsWith('设定/伏笔/')
        ? runInForeshadowSaveChain(r.bookRoot, runTrash)
        : runTrash())
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
    // R1010b-SRV-P2-1（2026-09-10 内存专项重审修复批）：书注册重验失败（删书/改名
    // drain 窗口后新进单元）——账实状态冲突可重试，与 REVISION_CONFLICT/OCCUPIED
    // 冲突族同 409 档（ee-P1-3 LEAD_GATE 同口径先例）
    case 'BOOK_MOVED':
      return 409
    case 'WRITE_ERROR':
      return 500
    default:
      return 500
  }
}

