/**
 * 章节结构操作 REST 端点 —— 自 src/studio/server/api/documents.ts 缝 3 拆出。
 *
 * R0916-5h（2026-09-16，⑤④产品巨件拆分波4）：documents.ts（1019 行）路由段按域
 * 纯移动拆分。本文件承载缝 3：阶段 24 章节结构操作（S3+S4）——干跑（POST
 * structure-plan：merge/split plan 与指纹）、执行（POST structure-apply：合并/
 * 拆分落账）、撤销合并（POST merge-undo），及本缝私有常量 structureRag（structure
 * 的 RAG 触点端口实例——顶层求值常量单源本文件，引用 rag/index 顶层 import、
 * 不经残核环回引，R0916-5e HANZI 单源先例同款纪律）。三缝按原文件连续段切分，
 * 各域路由相对序与全局注册序逐字节不变（dispatch 按注册顺序匹配，router.ts
 * 隐性契约——顺序细节与环判定记档见残核 documents.ts 头注 R0916-5h 段）。
 * 纯移动：代码与注释逐字随迁，零行为变化、零逻辑改写、零格式重排；差异仅
 * export 前缀与 import 重组。
 * 依赖方向：本文件 → document/rag 既有出边（studio→ai 组合根白名单面内，不新增
 * ai→studio 边）+ 回引基建单源 documents-core.ts（getOrCreateService /
 * enqueueStructureOp / structureBusyGuarded / structStatus / DocumentCtx——⑤①
 * R0916-5a 收敛的公共底座，零触碰单源 core）。模块图单向无环（core 不 import
 * 同批任何 documents-* 模块；聚合入口在残核 documents.ts 单向 import 本文件），
 * structureRag 只引用本文件 import 的 rag 函数，无 TDZ 面。
 * 保存/定稿/文件树族见 documents-save.ts（缝 1）；其余文档 CRUD 族见
 * documents-crud.ts（缝 2）；基建段与全部历史沿革记载留 documents.ts 残核。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { readJson, reply, replyError } from '../http.js'
import { bookMovedFailure, resolveBookOrReply } from '../book-context.js'
import {
  planChapterMerge,
  applyChapterMerge,
  planChapterSplit,
  applyChapterSplit,
  undoChapterMerge,
  type MergeApplyResult,
  type MergeUndoHints,
  type SplitApplyResult,
  type StructureRagPort,
} from '../../../document/structure.js'
// 阶段 24：structure 的 RAG 触点端口实现（G5 依赖反转——document 层不 import rag，
// 由本合法层注入；方法名同 rag/index 原函数，适配零成本）
import { cleanupRagAfterMerge, estimateRagChunkCount } from '../../../rag/index.js'
import { invalidateBookSummary } from './progress.js'
import { acquireTaskGate, orchestrationBusyFor } from './task-gate.js' // CC-P2-9：批量定稿并发闸
// R0916-5h：基建段回引单源 core（见文件头注依赖方向）
import { enqueueStructureOp, getOrCreateService, structStatus, structureBusyGuarded, type DocumentCtx } from './documents-core.js'

/** 阶段 24：structure 的 RAG 触点端口实例（干跑预估 + 合并/撤销/拆分后清理）。 */
const structureRag: StructureRagPort = { cleanupRagAfterMerge, estimateRagChunkCount }

export function registerDocumentsStructureRoutes(ctx: DocumentCtx): void {
  // ── 阶段 24 章节结构操作（S3+S4）：干跑 / 执行 / 撤销合并 ──────────────
  // 入口实序照 rewrite.ts 样板：resolveBook → self-heal/spawn 单面 → orchestrationBusyFor
  // （chat/后台）→ review → 任务闸 'structure'（plan 干跑只读只走 resolveBook +
  // orchestrationBusyFor，不占闸）。反向零接线——chat.send/auto-write/spawn/chat.clear/
  // 删书 busyGate 查 allHeldTaskGatesFor 全集，'structure' 注册进 KNOWN_ACTIONS 后自动生效。
  // （注释避免写出 acquireTaskGate 加左括号的调用形态——known-actions-audit 的 OCCUR_RE
  // 对注释与代码同计，CALL_RE 只认真调用点，字样残留即 19≠20 假红。）
  defineRoute('books.documents.structure-plan', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/structure-plan',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return
      const busy = orchestrationBusyFor(params['name']!)
      if (busy) return replyError(res, 409, 'BUSY', busy)
      const body = await readJson(req)
      const docId = params['docId'] ?? ''
      const svc = getOrCreateService(r.bookRoot, ctx.userDataPath)
      if (body.op === 'merge') {
        if (typeof body.sourceDocId !== 'string' || !body.sourceDocId) {
          return replyError(res, 400, 'BAD_INPUT', 'merge 干跑需要 sourceDocId')
        }
        const plan = await planChapterMerge(r.bookRoot, svc, docId, body.sourceDocId, structureRag)
        if (!plan.ok) return replyError(res, structStatus(plan.code), plan.code, plan.reason)
        return reply(res, 200, { ok: true, plan })
      }
      if (body.op === 'split') {
        const cursorOffset = Number(body.cursorOffset)
        if (!Number.isInteger(cursorOffset) || cursorOffset < 0) {
          return replyError(res, 400, 'BAD_INPUT', 'split 干跑需要 cursorOffset（非负整数）')
        }
        const plan = await planChapterSplit(r.bookRoot, svc, docId, cursorOffset)
        if (!plan.ok) return replyError(res, structStatus(plan.code), plan.code, plan.reason)
        return reply(res, 200, { ok: true, plan })
      }
      return replyError(res, 400, 'BAD_INPUT', 'op 需为 merge 或 split')
    },
  })

  defineRoute('books.documents.structure-apply', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/structure-apply',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return
      // R0916-5a：busy 守卫四连收编 structureBusyGuarded 单源（次序与文案逐字节不变；
      // 改写正文的结构操作与三审互斥——stream.ts spawn 先例同款面）
      if (structureBusyGuarded(params['name']!, res)) return
      const release = acquireTaskGate(params['name']!, 'structure')
      if (!release) return replyError(res, 409, 'BUSY', '本书结构操作进行中，请等待完成后再试')
      try {
        const body = await readJson(req)
        const docId = params['docId'] ?? ''
        const planHash = typeof body.planHash === 'string' ? body.planHash : ''
        if (!planHash) {
          return replyError(res, 400, 'BAD_INPUT', 'structure-apply 需要 planHash（先干跑取指纹）')
        }
        const sourceDocId = typeof body.sourceDocId === 'string' ? body.sourceDocId : ''
        const title = typeof body.title === 'string' ? body.title : ''
        const cursorOffset = Number(body.cursorOffset)
        const svc = getOrCreateService(r.bookRoot, ctx.userDataPath)
        // 链内首行书注册重验（readJson await 窗口内书可被删/改名）
        type ApplyOutcome =
          | { status: number; code: string; error: string }
          | { result: MergeApplyResult | SplitApplyResult }
        const outcome = await enqueueStructureOp(r.bookRoot, async (): Promise<ApplyOutcome> => {
          const moved = bookMovedFailure(ctx.workDir, params['name'], r.bookRoot)
          if (moved) return { status: structStatus(moved.code), code: moved.code, error: moved.reason }
          let result: MergeApplyResult | SplitApplyResult
          if (body.op === 'merge') {
            if (!sourceDocId) {
              return { status: 400, code: 'BAD_INPUT', error: 'merge 需要 sourceDocId' }
            }
            result = await applyChapterMerge(
              r.bookRoot,
              svc,
              ctx.userDataPath,
              {
                targetDocId: docId,
                sourceDocId,
                planHash,
              },
              structureRag,
            )
          } else if (body.op === 'split') {
            if (!title.trim()) {
              return { status: 400, code: 'BAD_INPUT', error: 'split 需要 title（新章标题必填）' }
            }
            if (!Number.isInteger(cursorOffset) || cursorOffset < 0) {
              return { status: 400, code: 'BAD_INPUT', error: 'split 需要 cursorOffset（非负整数）' }
            }
            result = await applyChapterSplit(
              r.bookRoot,
              svc,
              ctx.userDataPath,
              {
                docId,
                title,
                cursorOffset,
                planHash,
              },
              structureRag,
            )
          } else {
            return { status: 400, code: 'BAD_INPUT', error: 'op 需为 merge 或 split' }
          }
          if (result.ok) invalidateBookSummary(r.bookRoot)
          return { result }
        })
        if ('status' in outcome) return replyError(res, outcome.status, outcome.code, outcome.error)
        const result = outcome.result
        if (!result.ok) return replyError(res, structStatus(result.code), result.code, result.reason)
        reply(res, 200, result)
      } finally {
        release()
      }
    },
  })

  defineRoute('books.documents.merge-undo', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/merge-undo',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return
      // R0916-5a：busy 守卫四连收编 structureBusyGuarded 单源（次序与文案逐字节不变）
      if (structureBusyGuarded(params['name']!, res)) return
      const release = acquireTaskGate(params['name']!, 'structure')
      if (!release) return replyError(res, 409, 'BUSY', '本书结构操作进行中，请等待完成后再试')
      try {
        // 前端恒发 JSON body（无提示时 {}）；hints 三 id 齐备时 undo 直用（apply 响应透传）
        const body = await readJson(req)
        const hints: MergeUndoHints = {}
        if (typeof body.sourceDocId === 'string') hints.sourceDocId = body.sourceDocId
        if (typeof body.sourceChapterNo === 'number') hints.sourceChapterNo = body.sourceChapterNo
        if (typeof body.trashEntryId === 'string') hints.trashEntryId = body.trashEntryId
        if (typeof body.rollbackSnapshotId === 'string') hints.rollbackSnapshotId = body.rollbackSnapshotId
        if (typeof body.planHash === 'string') hints.planHash = body.planHash
        const docId = params['docId'] ?? ''
        const svc = getOrCreateService(r.bookRoot, ctx.userDataPath)
        type UndoOutcome = { status: number; code: string; error: string } | { result: Awaited<ReturnType<typeof undoChapterMerge>> }
        const outcome = await enqueueStructureOp(r.bookRoot, async (): Promise<UndoOutcome> => {
          const moved = bookMovedFailure(ctx.workDir, params['name'], r.bookRoot)
          if (moved) return { status: structStatus(moved.code), code: moved.code, error: moved.reason }
          const result = await undoChapterMerge(r.bookRoot, svc, ctx.userDataPath, docId, structureRag, hints)
          if (result.ok) invalidateBookSummary(r.bookRoot)
          return { result }
        })
        if ('status' in outcome) return replyError(res, outcome.status, outcome.code, outcome.error)
        const result = outcome.result
        if (!result.ok) return replyError(res, structStatus(result.code), result.code, result.reason)
        reply(res, 200, result)
      } finally {
        release()
      }
    },
  })
}
