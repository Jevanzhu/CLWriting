/**
 * 章节结构操作 REST 端点。
 *
 * 路由：干跑（POST structure-plan：merge/split plan 与指纹）、执行（POST structure-apply：合并/
 * 拆分落账）、撤销合并（POST merge-undo）；缝私有常量 structureRag（structure 的 RAG 触点端口实例
 *——顶层求值常量单源本文件，引用 rag/index 顶层 import，不经残核环回引）。各域路由相对序
 * 与全局注册序不变——dispatch 按注册顺序匹配，顺序是 router.ts 的隐性契约。
 * 依赖方向：本文件 → document/rag 既有出边（studio→ai 组合根白名单面内，不新增 ai→studio 边）+
 * 回引基建单源 documents-core.ts（getOrCreateService / enqueueStructureOp / structureBusyGuarded /
 * structStatus / DocumentCtx）。模块图单向无环（core 不 import 同批任何 documents-* 模块；聚合入口
 * 在残核 documents.ts 单向 import 本文件），structureRag 只引用本文件 import 的 rag 函数，无 TDZ 面。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { readJson, reply, replyError } from '../http.js'
import { bookMovedFailure, resolveBookOrReply } from '../book-context.js'
// 回包形状钉在跨端契约上（shared/contract/documents.ts，前端按同一份声明消费）。
// 干跑/执行/撤销三处成功体的**逐字段**对齐另有编译期探针
// （documents.conformance.ts 把契约钉在文档层权威类型上）；此处 `satisfies` 再把
// 回包点的类型真值收口一次——契约与文档层任一侧改形而另一侧未随动即在此或探针处红。
import type { MergeApplyOk, MergeUndoOk, SplitApplyOk, StructurePlanOk } from '../../../shared/contract/documents.js'
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
// 阶段 24：structure 的 RAG 触点端口实现（依赖反转——document 层不 import rag，
// 由本合法层注入；方法名同 rag/index 原函数，适配零成本）
import { cleanupRagAfterMerge, estimateRagChunkCount } from '../../../rag/index.js'
import { invalidateBookSummary } from './progress.js'
// 基建段回引单源 core（见文件头注依赖方向）
import {
  enqueueStructureOp,
  getOrCreateService,
  structStatus,
  structureBusyGuarded,
  type DocumentCtx,
} from './documents-core.js'

/** 阶段 24：structure 的 RAG 触点端口实例（干跑预估 + 合并/撤销/拆分后清理）。 */
const structureRag: StructureRagPort = { cleanupRagAfterMerge, estimateRagChunkCount }

export function registerDocumentsStructureRoutes(ctx: DocumentCtx): void {
  // ── 阶段 24 章节结构操作：干跑 / 执行 / 撤销合并 ──────────────
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
      const busy = ctx.gate.busyReason(params['name']!, 'generate')
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
        return reply(res, 200, { ok: true, plan } satisfies StructurePlanOk)
      }
      if (body.op === 'split') {
        const cursorOffset = Number(body.cursorOffset)
        if (!Number.isInteger(cursorOffset) || cursorOffset < 0) {
          return replyError(res, 400, 'BAD_INPUT', 'split 干跑需要 cursorOffset（非负整数）')
        }
        const plan = await planChapterSplit(r.bookRoot, svc, docId, cursorOffset)
        if (!plan.ok) return replyError(res, structStatus(plan.code), plan.code, plan.reason)
        return reply(res, 200, { ok: true, plan } satisfies StructurePlanOk)
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
      // busy 守卫四连收编 structureBusyGuarded 单源（次序与文案逐字节不变；
      // 改写正文的结构操作与三审互斥——stream.ts spawn 先例同款面）
      if (structureBusyGuarded(ctx.gate, params['name']!, res)) return
      const release = ctx.gate.acquire(params['name']!, 'structure')
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
          { status: number; code: string; error: string } | { result: MergeApplyResult | SplitApplyResult }
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
        reply(res, 200, result satisfies MergeApplyOk | SplitApplyOk)
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
      // busy 守卫四连收编 structureBusyGuarded 单源（次序与文案逐字节不变）
      if (structureBusyGuarded(ctx.gate, params['name']!, res)) return
      const release = ctx.gate.acquire(params['name']!, 'structure')
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
        type UndoOutcome =
          { status: number; code: string; error: string } | { result: Awaited<ReturnType<typeof undoChapterMerge>> }
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
        reply(res, 200, result satisfies MergeUndoOk)
      } finally {
        release()
      }
    },
  })
}
