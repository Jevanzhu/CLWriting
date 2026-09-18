/**
 * 文档保存·定稿·文件树 REST 端点 —— 自 src/studio/server/api/documents.ts 缝 1 拆出。
 *
 * R0916-5h（2026-09-16，⑤④产品巨件拆分波4）：documents.ts（1019 行）路由段按域
 * 纯移动拆分。本文件承载缝 1：W1 保存协议（PUT /documents/:docId/content）、
 * W2A 文件树（GET /tree）、定稿确认（POST finalize）与批量定稿（POST
 * batch-finalize），及本缝私有辅助（ORIGINS / parseSaveInput /
 * BATCH_FINALIZE_MAX_DOCS——顶层求值常量单源本文件，不经残核环回引，
 * R0916-5e HANZI 单源先例同款纪律）。文件树归本缝而非 CRUD 缝：三缝按原文件
 * 连续段切分，各域路由相对序与全局注册序逐字节不变（dispatch 按注册顺序匹配，
 * router.ts 隐性契约——顺序细节与环判定记档见残核 documents.ts 头注 R0916-5h 段）。
 * 纯移动：代码与注释逐字随迁，零行为变化、零逻辑改写、零格式重排；差异仅
 * export 前缀与 import 重组。
 * 依赖方向：本文件 → document/process/driver 既有出边（studio→ai 组合根白名单
 * 面内，不新增 ai→studio 边）+ 回引基建单源 documents-core.ts（getOrCreateService /
 * runBookScopedOp / structStatus / DocumentCtx——⑤① R0916-5a 收敛的公共底座，
 * 零触碰单源 core）。模块图单向无环（core 不 import 同批任何 documents-* 模块；
 * 聚合入口在残核 documents.ts 单向 import 本文件），顶层求值常量各归单源，
 * 无 TDZ 面。
 * 其余文档 CRUD 族见 documents-crud.ts（缝 2）；章节结构操作族见
 * documents-structure.ts（缝 3）；基建段与全部历史沿革记载留 documents.ts 残核。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { readJson, reply, replyError, parseRequestUrl } from '../http.js'
// SRV-N8（专项精简优化 §五，2026-09-15 机械批）：resolveBook 双行样板收编单源
//（resolveBookOrReply 失败即回写错误响应返回 null）。readJson 站点 defineRoute
// parse 迁移跳过：书域写端点按 CC-P2-9 先占书级闸再读体（R51-G-2 悬持计时耦合闸
// 语义），parse 化会把读体挪到占闸前——顺序纪律不可翻转。
import { resolveBookOrReply } from '../book-context.js'
import type { SaveDocumentInput, SaveOutcome } from '../../../document/service.js'
import { getBookTreeIndex } from '../../../document/tree.js'
import { finalizeRevisionAsync } from '../../../document/finalize.js' // R30-6（三十轮，批 C 移交收尾）：服务进程切异步孪生
import { afterFinalizeGenerateSummary, afterFinalizeGenerateSummaryBatch } from '../../../process/summary.js'
// R0912（重评-0911c P2）：定稿摘要后台任务的中断接线——driver 会话惰性取得后传入
// 钩子，后台摘要/批量链持独立登记 ctrl（/interrupt 可中止）；未接线形态（session
// 取得失败）退化为不登记，与修复前等价
import { ensureSession, getDriver } from '../../../driver/index.js'
import { invalidateBookSummary } from './progress.js'
import { acquireTaskGate } from './task-gate.js'
// R0916-5h：基建段回引单源 core（见文件头注依赖方向）
import { getOrCreateService, runBookScopedOp, structStatus, type DocumentCtx } from './documents-core.js'

/** X-23（第五十六轮）：批量定稿单次条数上限——每条全量读改写 manifest，超大批量
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

export function registerDocumentsSaveRoutes(ctx: DocumentCtx): void {
  // ── W1：保存内容 ──────────────────────────────
  defineRoute('books.documents.content', {
    method: 'PUT',
    path: '/api/books/:name/documents/:docId/content',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return

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
      // R1010b-SRV-P2-1 面 A：重验在链单元首行——非伏笔直调路径天然同覆盖，伏笔链
      // 路径在链单元开跑时刻重验（竞态时序见 bookMovedFailure 头注）。
      // R0916-5a：重验→快照→差分→链决策收编 runBookScopedOp 单源；V-P2-27 摘要
      // 失效保留在本站 op 的 ok 分支且先于差分（原序）。
      const outcome = await runBookScopedOp(ctx, {
        bookName: params['name'],
        bookRoot: r.bookRoot,
        fsPath: path,
        causeId: docId, // R43-23：docId 留痕因果
        deltaId: () => docId, // R43-23：伏笔内容保存（fm 状态变更）→ foreshadow/change 事件
        op: async (): Promise<SaveOutcome> => {
          const o = await svc.save(docId, path, input)
          // V-P2-27：字数变了 → 书架摘要即时失效（不等 5s TTL）
          if (o.ok) invalidateBookSummary(r.bookRoot)
          return o
        },
      })
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
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return
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
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return
      // R0915-P3-2（四轮处置批）：单件定稿补任务闸——batch-finalize 早已持 'batch-finalize'
      // 闸而单件端点裸跑，两路在途交错时单件可插进批量串行循环的章间隙（同章双 commit/
      // 双 manifest 写的 CC-P2-9 动机面）。同族操作同闸名互斥、拒而非排队（闸窗毫秒级，
      // 前端重试即过；对齐 batch-finalize 与 rewrite/outline 闸口径）；books.ts busyGate
      // 随之把单件定稿的 git commit 窗也纳入删书/改名拦截面。
      const release = acquireTaskGate(params['name']!, 'batch-finalize')
      if (!release) {
        return replyError(res, 409, 'BUSY', '本书定稿操作进行中，请等待完成后再试')
      }
      try {
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
        // B103（0918独立重评二轮修复批）：防吃书闸降级短语随信封透传（非空 = 闸门
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
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return
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
        const results: Array<{ docId: string; ok: boolean; status?: string; skipped?: boolean; error?: string; gateDegraded?: string[] }> = []
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
          // B103：单条降级短语随批量结果透传（前端逐条汇总面可显）
          results.push({
            docId,
            ok: o.ok,
            status: o.ok ? o.status : undefined,
            skipped: o.ok ? o.skipped : undefined,
            error: o.ok ? undefined : o.error,
            ...(o.ok && o.gateDegraded && o.gateDegraded.length > 0 ? { gateDegraded: o.gateDegraded } : {}),
          })
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
}
