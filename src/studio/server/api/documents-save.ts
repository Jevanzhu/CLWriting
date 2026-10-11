/**
 * 文档保存·定稿·文件树 REST 端点。
 *
 * 路由：保存协议（PUT /documents/:docId/content）、文件树（GET /tree）、定稿确认
 *（POST finalize）与批量定稿（POST batch-finalize）；缝私有辅助 ORIGINS / parseSaveInput /
 * BATCH_FINALIZE_MAX_DOCS（顶层求值常量单源本文件，不经残核环回引）。文件树归本缝而非 CRUD 缝：
 * 各域路由相对序与全局注册序不变——dispatch 按注册顺序匹配，顺序是 router.ts 的隐性契约。
 * 依赖方向：本文件 → document/process/driver 既有出边（studio→ai 组合根白名单面内，不新增
 * ai→studio 边）+ 回引基建单源 documents-core.ts（getOrCreateService / runBookScopedOp /
 * structStatus / DocumentCtx）。模块图单向无环（core 不 import 同批任何 documents-* 模块；聚合
 * 入口在残核 documents.ts 单向 import 本文件），顶层求值常量各归单源，无 TDZ 面。
 * 其余文档 CRUD 族见 documents-crud.ts；章节结构操作族见 documents-structure.ts。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { reply, replyError, parseRequestUrl, CONTENT_BODY_LIMIT_BYTES } from '../http.js'
// SRV-（专项精简优化 §五）：resolveBook 双行样板收编单源
//（resolveBookOrReply 失败即回写错误响应返回 null）。
// 本文件两处正文/批量写端点改 gate（找书 404 / 书级闸 409 前置门，先于读体）
// + parse（body 形状 400）——「先占书级闸再读体」的顺序纪律由 gate 位承载（gate 在
// parse 之前），不再需要内联 readJson 绕开 parse 声明。
import { resolveBookOrReply } from '../book-context.js'
import type { SaveDocumentInput, SaveOutcome } from '../../../document/service.js'
import { getBookTreeIndex } from '../../../document/tree.js'
import { finalizeRevisionAsync } from '../../../document/finalize.js' // 服务进程切异步孪生
import { afterFinalizeGenerateSummary, afterFinalizeGenerateSummaryBatch } from '../../../process/summary.js'
// （c ）：定稿摘要后台任务的中断接线——driver 会话惰性取得后传入
// 钩子，后台摘要/批量链持独立登记 ctrl（/interrupt 可中止）；未接线形态（session
// 取得失败）退化为不登记，与修复前等价
import { invalidateBookSummary } from './progress.js'
// 基建段回引单源 core（见文件头注依赖方向）
import { getOrCreateService, runBookScopedOp, structStatus, type DocumentCtx } from './documents-core.js'

/** 批量定稿单次条数上限——每条全量读改写 manifest，超大批量
 *  同步循环会长时间阻塞事件循环；400 为长篇全书待定稿章数的量级上界。 */
const BATCH_FINALIZE_MAX_DOCS = 400

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
  // origin：缺省（旧客户端/测试裸 PUT）→ 'manual'；在场但非值域成员 → null 走 400。
  // 原「非法一律静默归一 manual」与同函数其余字段 fail-loud 口径分裂——拼错的
  // 'autosave '（尾空格）会被记成手动保存，快照 origin 与留底理由随之失真
  let origin: SaveDocumentInput['origin'] = 'manual'
  if (body.origin !== undefined) {
    if (!ORIGINS.has(body.origin as string)) return null
    origin = body.origin as SaveDocumentInput['origin']
  }
  const input: SaveDocumentInput = {
    content: body.content,
    expectedRevision,
    operationId: body.operationId,
    origin,
  }
  if (typeof body.reason === 'string') input.reason = body.reason
  return input
}

export function registerDocumentsSaveRoutes(ctx: DocumentCtx): void {
  // 正文保存走内容档上限（默认 1MB 对 >35 万字中文正文即 413）
  defineRoute('books.documents.content', {
    method: 'PUT',
    path: '/api/books/:name/documents/:docId/content',
    // 校验单轨：原 handler 内联「找书 → 找文档 → readJson + parseSaveInput」——
    // 前置两级 404（未找书 / docId 未登记，后者内含 legacy 补登记副作用）落 gate，
    // body 形状（content/expectedRevision/operationId 缺失或类型不符、origin 非值域）
    // 落 parse：响应序「404 找书 → 404 文档 → 400 body → 链内 409 BOOK_MOVED」逐位不变
    // （gate 先于读体，docId 解析仍在读体前——与迁移前同步段序一致）。
    gate: async ({ params, res }) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return false
      const docId = params['docId'] ?? ''
      const svc = getOrCreateService(r.bookRoot, ctx.userDataPath)
      // docId → relPath（含 legacy 旧文件首次补登记，resolvePathAsync → 异步收编孪生——
      // 原同步 resolvePath 的收编段走 withManifestLock 同步睡，已改异步不再阻塞）
      const path = await svc.resolvePathAsync(docId)
      if (!path) {
        replyError(res, 404, 'NOT_FOUND', `文档ID未在清单登记：${docId}`)
        return false
      }
      return { value: { svc, path, bookRoot: r.bookRoot } }
    },
    // RC：正文保存走内容档上限（默认 1MB 对 >35 万字中文正文即 413）
    bodyLimit: CONTENT_BODY_LIMIT_BYTES,
    parse: (raw) => {
      const input = parseSaveInput((raw ?? {}) as Record<string, unknown>)
      if (!input) {
        throw new Error('content / expectedRevision / operationId 缺失或类型不符，或 origin 非值域成员')
      }
      return input
    },
    handler: async ({ params, input, gate }, _req: IncomingMessage, res: ServerResponse) => {
      const { svc, path, bookRoot } = gate
      const docId = params['docId'] ?? ''

      // 伏笔快照先于保存（差分需要变更前状态）。
      // 2--①：伏笔域保存（快照读→save→差分落事件）整段入 per-book 串行链
      // ——并发保存交叠不再重复计窗；非伏笔路径不进链（快照直通 null、零差分，
      // 保存并行性不变）。
      // 面 A：重验在链单元首行——非伏笔直调路径天然同覆盖，伏笔链
      // 路径在链单元开跑时刻重验（竞态时序见 bookMovedFailure 头注）。
      // 重验→快照→差分→链决策收编 runBookScopedOp 单源；摘要
      // 失效保留在本站 op 的 ok 分支且先于差分（原序）。
      const outcome = await runBookScopedOp(ctx, {
        bookName: params['name'],
        bookRoot,
        fsPath: path,
        causeId: docId, // docId 留痕因果
        deltaId: () => docId, // 伏笔内容保存（fm 状态变更）→ foreshadow/change 事件
        op: async (): Promise<SaveOutcome> => {
          const o = await svc.save(docId, path, input)
          // 字数变了 → 书架摘要即时失效（不等 5s TTL）
          if (o.ok) invalidateBookSummary(bookRoot)
          return o
        },
      })
      if (outcome.ok) {
        // 留底降级旗透出（仅 true 时带，既有响应形状
        // 零改动）——正文已保存，但本笔没生成版本留底（.版本 目录不可写），前端据此
        // 提示一次「版本历史有缺口」，别让作者在「保存成功」的表象下丢了可回退的底。
        reply(res, 200, {
          ok: true,
          revision: outcome.revision,
          superseded: outcome.superseded,
          ...(outcome.snapshotDegraded ? { snapshotDegraded: true } : {}),
        })
        return
      }
      // 错误信封统一 {error, code?}——save 结构化失败码保留 code，人话进 error
      // 收编 replyError 单一出口（信封形状不变，去 reply 手拼）
      replyError(res, structStatus(outcome.code), outcome.code, outcome.reason)
    },
  })

  // ── W2A：文件树 ──────────────────────────────
  defineRoute('books.tree', {
    method: 'GET',
    path: '/api/books/:name/tree',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return
      // refresh=1：丢缓存重扫（外部编辑器/CLI 改盘不经 invalidateTreeIndex）
      // parseRequestUrl 统一解析（口径）——畸形 URL → 400 BAD_INPUT
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

  // ── 定稿确认（revision → final，git commit 锁定版本）────────
  defineRoute('books.documents.finalize', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/finalize',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return
      // 单件定稿补任务闸——batch-finalize 早已持 'batch-finalize'
      // 闸而单件端点裸跑，两路在途交错时单件可插进批量串行循环的章间隙（同章双 commit/
      // 双 manifest 写的动机面）。同族操作同闸名互斥、拒而非排队（闸窗毫秒级，
      // 前端重试即过；对齐 batch-finalize 与 rewrite/outline 闸口径）；books.ts busyGate
      // 随之把单件定稿的 git commit 窗也纳入删书/改名拦截面。
      const release = ctx.gate.acquire(params['name']!, 'batch-finalize')
      if (!release) {
        return replyError(res, 409, 'BUSY', '本书定稿操作进行中，请等待完成后再试')
      }
      try {
        // 切异步孪生——锁等待（布线锁/清单锁）走事件
        // 循环轮询原语，不再阻塞 SSE/心跳；语义（超时档/fail-closed/锁序）与同步孪生逐位一致
        const outcome = await finalizeRevisionAsync(r.bookRoot, params['docId'] ?? '')
        if (!outcome.ok) {
          // ee-LEAD_GATE → 409（可修复的账实状态冲突，语义与 structStatus 的
          // REVISION_CONFLICT/OCCUPIED 冲突族一致）；ee-LEAD_WRITE_ERROR → 500
          // （服务端 IO 故障，作者修复环境后重试）。error 人话原样透传给前端 toast。
          const status =
            outcome.code === 'NOT_FOUND'
              ? 404
              : outcome.code === 'LEAD_GATE'
                ? 409
                : outcome.code === 'LEAD_WRITE_ERROR'
                  ? 500
                  : 400
          // 收编 replyError 单一出口（去掉 ok:false 冗余位）
          return replyError(res, status, outcome.code, outcome.error)
        }
        // 定稿即生成章摘要：best-effort fire-and-forget（钩子在 API 层——
        // document/ 禁 import AI 层，依赖方向治理测试守门）；skipped（幂等重定稿）不触发；
        // 带书名登记进后台表，删书/改名/退出的 settle 能追上其落盘
        // driver 会话惰性取得后再挂钩子——ensureSession 窗口内任务尚未启动
        // （零 AI 调用/零落盘）登记稍迟无逃逸面；session 失败 → 不登记（修复前等价）
        if (!outcome.skipped) {
          void (async (): Promise<void> => {
            const session = await ctx.driver
              .ensureSession(params['name']!, ctx.workDir!)
              .catch((): undefined => undefined)
            afterFinalizeGenerateSummary(
              r.bookRoot,
              ctx.userDataPath ?? null,
              params['docId'] ?? '',
              params['name'],
              ctx.driver.driver,
              session,
            )
          })()
        }
        // 防吃书闸降级短语随信封透传（非空 = 闸门
        // fail-open 放行的事实，前端弹 warning toast；服务端不改写内容）
        reply(res, 200, {
          ok: true,
          status: outcome.status,
          skipped: outcome.skipped,
          ...(outcome.gateDegraded && outcome.gateDegraded.length > 0 ? { gateDegraded: outcome.gateDegraded } : {}),
        })
      } finally {
        release()
      }
    },
  })

  // ── 批量定稿（一键定稿 ≤目标章号 的全部 revision/draft 章）────────
  // body { docIds: string[] }；逐个 finalizeRevisionAsync（await 串行，天然无 SQLite 写锁冲突；
  // 三十轮起为异步孪生，锁等待不阻塞事件循环）。
  // 单条失败不中断：返回逐条结果，前端汇总 toast。
  // 条数上限——每条 finalizeRevision 各自全量读改写 manifest，
  // 无上限的大批量同步循环会阻塞事件循环数秒（SSE/心跳全停）。400 为长篇全书待定稿
  // 章数的量级上界，超出 fail-fast 提示分批。
  defineRoute('books.documents.batch-finalize', {
    method: 'POST',
    path: '/api/books/:name/documents/batch-finalize',
    // 校验单轨：书级闸占位仍在读体前（gate 先于 parse）——「受理请求即持闸、
    // 覆盖 body 在途窗口」的既有语义不变（原注：handler 已持闸悬在 readJson 时，后到的
    // 完整请求 409）；闸的释放走 defineRoute 的 cleanup 唯一收尾点（parse 失败 / handler
    // 抛错 / 正常返回全覆盖，与迁移前 finally 等价）。错误序「找书 404 → BUSY 409 →
    // docIds 400」逐位不变。
    gate: ({ params, res }) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return false
      const release = ctx.gate.acquire(params['name']!, 'batch-finalize')
      if (!release) {
        replyError(res, 409, 'BUSY', '本书批量定稿进行中，请等待完成后再试')
        return false
      }
      return { value: { bookRoot: r.bookRoot }, cleanup: release }
    },
    parse: (raw) => {
      const body = (raw ?? {}) as Record<string, unknown>
      const docIds = Array.isArray(body['docIds']) ? body['docIds'] : null
      if (!docIds || docIds.length === 0 || docIds.some((d) => typeof d !== 'string')) {
        throw new Error('docIds 必须为非空字符串数组')
      }
      if (docIds.length > BATCH_FINALIZE_MAX_DOCS) {
        throw new Error(
          `批量定稿一次最多 ${BATCH_FINALIZE_MAX_DOCS} 章（本次 ${docIds.length} 章），请分批提交`,
        )
      }
      return { docIds: docIds as string[] }
    },
    handler: async ({ params, input, gate }, _req: IncomingMessage, res: ServerResponse) => {
      const { bookRoot } = gate
      const docIds = input.docIds
      const summarized: string[] = []
      const results: Array<{
        docId: string
        ok: boolean
        status?: string
        skipped?: boolean
        error?: string
        gateDegraded?: string[]
      }> = []
      // 切异步孪生 finalizeRevisionAsync——逐条 await
      // 串行保持既有「串行天然无 SQLite 写锁冲突」语义，锁等待不再阻塞事件循环。
      // （原同步 map 循环：finalizeRevision 逐条全量读改写 manifest）
      for (const docId of docIds) {
        // ee-/ee-LEAD_GATE / LEAD_WRITE_ERROR 同样作为该文档的失败结果记录
        // （error 人话透传，前端汇总 toast），不中断其余文档的定稿。
        const o = await finalizeRevisionAsync(bookRoot, docId)
        // 批量定稿同样触发章摘要（best-effort；fire-and-forget 不阻塞批量循环；
        // 书名登记进后台表——批量连发多任务也能被 settle 逐个追上）
        if (o.ok && !o.skipped) summarized.push(docId)
        // 单条降级短语随批量结果透传（前端逐条汇总面可显）
        results.push({
          docId,
          ok: o.ok,
          status: o.ok ? o.status : undefined,
          skipped: o.ok ? o.skipped : undefined,
          error: o.ok ? undefined : o.error,
          ...(o.ok && o.gateDegraded && o.gateDegraded.length > 0 ? { gateDegraded: o.gateDegraded } : {}),
        })
      }
      // 批量摘要走串行链——逐章 fire-and-forget 会让一键定稿 N 章 = N 路
      // 摘要 AI 并发（provider 限流整批失败）；整链单条登记，settle 在链首即追上全部
      // 同上——惰性取得 driver 会话后接线（中断对链上在途与未开跑的章一并生效）
      void (async (): Promise<void> => {
        const session = await ctx.driver
          .ensureSession(params['name']!, ctx.workDir!)
          .catch((): undefined => undefined)
        afterFinalizeGenerateSummaryBatch(
          bookRoot,
          ctx.userDataPath ?? null,
          summarized,
          params['name'],
          ctx.driver.driver,
          session,
        )
      })()
      reply(res, 200, { ok: true, results })
    },
  })
}
