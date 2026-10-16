/**
 * 文档 CRUD / 字数日记端点编排体（documents-crud.ts 的 handler 落地档）。
 *
 * 内容 = documents-crud.ts 九个端点的 handler 全量业务：字数日记读写（今日基线）、新建文档、
 * PATCH 移动/重命名/meta/fm、复制、软删、回收站列出/恢复/永久删。method/path/gate/parse/
 * bodyLimit 声明与一行转调留在 documents-crud.ts（范式同 documents-core.ts 的 runBookScopedOp
 * 承接五站写端点不变链：域路由文件单向 import 本档，本档不 import 路由文件）。
 *
 * 行为不变量（纯下沉，逐字等价）：
 * - 五站 op 体仍走 runBookScopedOp 单源（链单元首行书注册重验 → 伏笔快照 → op → 差分 → 链决策），
 *   回包信封与拆分前逐位一致；
 * - PATCH 的 op 形状校验刻意留链单元内：**链单元首行书注册重验 409 BOOK_MOVED 先于形状校验
 *   400**——校验若上移 parse（读体段）会把 400 提到 409 之前，属对外错误优先序翻转，故本站
 *   只接 readJson 一半（parse 原样透传 body）；本档该 handler 的单元序即该判据的唯一载体。
 * - 字数日记/回收站端点的 BOOK_MOVED 重验仍在写段首行（同款时序，见各单元注）。
 *
 * 书架摘要失效（文档写出口）：各写出口成功后调 invalidateBookSummary(bookRoot)，即时失效
 * 书架摘要 30s TTL 结果缓存（progress.ts summaryCache，键 = bookRoot）——否则写后在 TTL
 * 窗口内读 GET /api/books 仍回旧章数/字数（改名/删书路径已失效，本档补文档级出口）。书键
 * 缓存族（forgetBookKeyedCaches）不随本处调用——树索引由 service 层 invalidateTreeIndex
 * 承担，与保存路径（documents-save.ts）同口径。
 *
 * 依赖方向单向（无环）：本文件 → http / book-context / document / shared-contract / documents-core
 * 既有出边（不新增 ai 边），对 documents-crud.ts 只有 type 面回引（DocumentCtx 真家在 core，
 * 编译期擦除）；顶层零求值常量，无 TDZ 面。
 */
import type { ServerResponse } from 'node:http'
import { reply, replyError } from '../http.js'
import { bookMovedFailure, resolveBookOrReply } from '../book-context.js'
// 回包形状钉在跨端契约上（shared/contract/documents.ts）——成功体以 `satisfies` 接在字面量上
import type { CreateOk, TrashEntry } from '../../../shared/contract/documents.js'
import type { CopyResult, CreateResult, MoveResult, TrashResult } from '../../../document/service.js'
import { readBaseline, appendBaseline, readTodayDelta, todayDate } from '../../../document/words-diary.js'
import { listTrash, restoreTrash, purgeTrash } from '../../../document/trash.js'
// 基建段单源 core（getOrCreateService / 五站不变链 / 错误码映射）
import { getOrCreateService, runBookScopedOp, structStatus, type DocumentCtx } from './documents-core.js'
import { invalidateBookSummary } from './progress.js'

/** 前置闸产出（找书结果）按本站用到的成员收窄——resolveBookOrReply 成功返回值的结构面，
 *  声明面 RouteContext 的 gate 位在 schema.ts 未导出，跨模块只能按结构收窄。 */
interface ResolvedBookScope {
  bookRoot: string
}

export async function handleWordsDiaryGet(
  ctx: DocumentCtx,
  params: Record<string, string>,
  res: ServerResponse,
): Promise<void> {
  const r = resolveBookOrReply(ctx.workDir, params['name'], res)
  if (!r) return
  const date = todayDate()
  reply(res, 200, {
    ok: true,
    date,
    baseline: readBaseline(r.bookRoot, date),
    delta: readTodayDelta(r.bookRoot, date),
  })
}

export function handleWordsDiaryPost(
  ctx: DocumentCtx,
  arg: { params: Record<string, string>; input: { baseline: number }; gate: ResolvedBookScope },
  res: ServerResponse,
): void {
  const { params, input, gate } = arg
  // 面 A（同型扫描接线）：书注册重验——入口快照（gate）到本写段之间可跨删书/改名
  // drain 时点，appendBaseline 对旧捕获路径 mkdir recursive + append 成孤儿；
  // 与五处链内单元同款（时序见 bookMovedFailure 头注）
  const moved = bookMovedFailure(ctx.workDir, params['name'], gate.bookRoot)
  if (moved) return replyError(res, structStatus(moved.code), moved.code, moved.reason)
  appendBaseline(gate.bookRoot, todayDate(), input.baseline)
  reply(res, 200, { ok: true })
}

export async function handleDocumentCreate(
  ctx: DocumentCtx,
  arg: {
    params: Record<string, string>
    input: { relPath: string; content: string | undefined }
    gate: ResolvedBookScope
  },
  res: ServerResponse,
): Promise<void> {
  const { params, input, gate } = arg
  const svc = getOrCreateService(gate.bookRoot, ctx.userDataPath)
  // 清偿-伏笔接线×4②：新建——「快照读 → create → 差分」
  // 整段入 per-book 伏笔串行链（同 PUT 2--① 口径）：并发交叠不再重复计窗；
  // 非伏笔域目标不进链。新建前无 docId，以 relPath 作留痕因果标注。
  // 面 A：链单元首行重验书注册（同 PUT 口径；409 BOOK_MOVED 先于
  // 不变链收编 runBookScopedOp 单源；新建改 docId 集合，快照
  // 基线仍取本单元 op 前全域状态（链内前继落库变更必在基线中）。
  const result = await runBookScopedOp(ctx, {
    bookName: params['name'],
    bookRoot: gate.bookRoot,
    fsPath: input.relPath,
    causeId: input.relPath, // 非伏笔域目标不进链。新建前无 docId，以 relPath 作留痕因果标注。
    deltaId: (created) => (created.ok ? created.docId : input.relPath), // 新 docId（仅 ok 回调；else 支不可达兜底）
    op: (): Promise<CreateResult> =>
      svc.createDocument({
        relPath: input.relPath,
        content: input.content,
      }),
  })
  // 失败收编 replyError 统一信封（原裸 result——前端 toast 直显机器码，reason 人话永不见）
  if (result.ok) {
    invalidateBookSummary(gate.bookRoot) // 写出口失效书架摘要（30s TTL，见头注）
    reply(res, 201, result satisfies CreateOk)
  } else replyError(res, structStatus(result.code), result.code, result.reason)
}

export async function handleDocumentPatch(
  ctx: DocumentCtx,
  arg: {
    params: Record<string, string>
    input: Record<string, unknown>
    gate: ResolvedBookScope
  },
  res: ServerResponse,
): Promise<void> {
  const { params, input: body, gate } = arg
  const docId = params['docId'] ?? ''
  const svc = getOrCreateService(gate.bookRoot, ctx.userDataPath)
  // docId → relPath：仅作伏笔域判定（rename/move/meta/fm 各自内部会再解析登记路径）
  const docPath = await svc.resolvePathAsync(docId)
  // 清偿-伏笔接线×4①：PATCH——op=fm 改伏笔状态最常用，
  // rename/move/meta 与其共用同一 handler 差分接线：「快照读 → op → 差分」整段入
  // per-book 伏笔串行链（同 PUT 2--① 口径），并发交叠不再重复计窗。op 形状
  // 校验失败在链单元内同步回复即出链（400 不产生差分、不长时间占链位；返回
  // undefined = 响应已发）。
  // 面 A：链单元首行重验书注册（同 PUT 口径；409 BOOK_MOVED 先于
  // 形状校验 400 的现行错误优先序由单元序保证）——形状校验不得上移读体段，
  // 否则 400 先于 409，属对外契约翻转。
  // 伏笔快照先于变更（rename/move/meta/fm 都可能改 设定/伏笔/ 状态）。
  // 快照/重验/差分/链决策收编 runBookScopedOp 单源，本站只存 op 业务体
  //（形状校验留单元内，undefined 直通走第二重载档）。
  const result = await runBookScopedOp(ctx, {
    bookName: params['name'],
    bookRoot: gate.bookRoot,
    fsPath: docPath,
    causeId: docId, // 非伏笔域目标不进链。新建前无 docId，以 relPath 作留痕因果标注。
    deltaId: () => docId, // 非伏笔域目标不进链。新建前无 docId，以 relPath 作留痕因果标注。
    op: async (): Promise<MoveResult | undefined> => {
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
        // 低-3：章号 fail-closed 整数校验——3.5 这类小数旧口径放行后文件名落成
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
        result = await svc.updateChapterMeta(docId, metaUpdate) // 异步孪生
      } else if (body.op === 'fm') {
        const meta = body.meta
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
          replyError(res, 400, 'BAD_INPUT', 'fm 需要 meta 对象')
          return undefined
        }
        result = await svc.updateDocMeta(docId, meta as Record<string, unknown>) // 异步孪生
      } else {
        replyError(res, 400, 'BAD_INPUT', '未知 op（rename/move/meta/fm）')
        return undefined
      }
      return result
    },
  })
  if (result === undefined) return // op 形状校验失败：链单元内已回 400
  // 同上——失败走 replyError 统一信封
  if (result.ok) {
    invalidateBookSummary(gate.bookRoot) // 写出口失效书架摘要（30s TTL，见头注）
    reply(res, 200, result)
  } else replyError(res, structStatus(result.code), result.code, result.reason)
}

export async function handleDocumentCopy(
  ctx: DocumentCtx,
  arg: { params: Record<string, string>; input: { relPath: string }; gate: ResolvedBookScope },
  res: ServerResponse,
): Promise<void> {
  const { params, input, gate } = arg
  const docId = params['docId'] ?? ''
  const svc = getOrCreateService(gate.bookRoot, ctx.userDataPath)
  // 清偿-伏笔接线×4④：copy——「快照读 → copy → 差分」
  // 整段入 per-book 伏笔串行链（同 PUT 2--① 口径）：复制出的新条目 create
  // 事件各归各窗，非伏笔域目标不进链。
  // 面 A：链单元首行重验书注册（同 PUT 口径；409 BOOK_MOVED 先于
  // copy 目标落在伏笔域（设定/伏笔/）时同 create/patch 接伏笔
  // 差分事件——此前 copy 绕过 foreshadowSnapshot → recordForeshadowDelta，伏笔
  // md 复制出的新条目不落 foreshadow/change{create}（观测层丢事件）。
  // 不变链收编 runBookScopedOp 单源；快照因果取源 docId、差分因果取
  // result.docId。
  const result = await runBookScopedOp(ctx, {
    bookName: params['name'],
    bookRoot: gate.bookRoot,
    fsPath: input.relPath,
    causeId: docId, // 源 docId 作留痕因果
    deltaId: (copied) => (copied.ok ? copied.docId : docId), // 新 docId（仅 ok 回调；else 支不可达兜底）
    op: (): Promise<CopyResult> => svc.copyDocument({ docId, relPath: input.relPath }),
  })
  // 失败走 replyError 统一信封（原裸 result 违反 schema.ts 信封约定）
  if (result.ok) {
    invalidateBookSummary(gate.bookRoot) // 写出口失效书架摘要（30s TTL，见头注）
    reply(res, 201, result satisfies CreateOk)
  } else replyError(res, structStatus(result.code), result.code, result.reason)
}

export async function handleDocumentDelete(
  ctx: DocumentCtx,
  params: Record<string, string>,
  res: ServerResponse,
): Promise<void> {
  const r = resolveBookOrReply(ctx.workDir, params['name'], res)
  if (!r) return
  const docId = params['docId'] ?? ''
  const svc = getOrCreateService(r.bookRoot, ctx.userDataPath)
  // docId → relPath：仅作伏笔域判定（trashDocument 内部自会再解析）
  const docPath = await svc.resolvePathAsync(docId)
  // 清偿-伏笔接线×4③：软删——「快照读 → trash → 差分」
  // 整段入 per-book 伏笔串行链（同 PUT 2--① 口径）：软删改 docId 集合（−1）
  // 且把文件移出 设定/伏笔/，快照仍取本单元 trash 前全域状态（条目在册）、差分读
  // 在 trashDocument 落定之后（条目已移出）→ clear 事件各归各窗；链内串行保证
  // 他单元的增删不混入本单元差分窗。
  // 面 A：链单元首行重验书注册（同 PUT 口径；409 BOOK_MOVED 先于
  // 不变链收编 runBookScopedOp 单源（软删伏笔 clear 事件前快照）。
  const result = await runBookScopedOp(ctx, {
    bookName: params['name'],
    bookRoot: r.bookRoot,
    fsPath: docPath,
    causeId: docId, // 源 docId 作留痕因果
    deltaId: () => docId, // 源 docId 作留痕因果
    op: (): Promise<TrashResult> => svc.trashDocument({ docId }),
  })
  // 同上——失败走 replyError 统一信封
  if (result.ok) {
    invalidateBookSummary(r.bookRoot) // 写出口失效书架摘要（30s TTL，见头注）
    reply(res, 200, result)
  } else replyError(res, structStatus(result.code), result.code, result.reason)
}

export async function handleTrashList(
  ctx: DocumentCtx,
  params: Record<string, string>,
  res: ServerResponse,
): Promise<void> {
  const r = resolveBookOrReply(ctx.workDir, params['name'], res)
  if (!r) return
  // 条目元素类型按契约定型（清单条目数组是变量，多余属性检查作用在信封字面量上
  // ——加兄弟字段即红；元素逐字段等价由 documents.conformance.ts 的探针钉住）
  const entries: TrashEntry[] = listTrash(r.bookRoot)
  reply(res, 200, { ok: true, entries } satisfies { ok: true; entries: TrashEntry[] })
}

export async function handleTrashRestore(
  ctx: DocumentCtx,
  params: Record<string, string>,
  res: ServerResponse,
): Promise<void> {
  const r = resolveBookOrReply(ctx.workDir, params['name'], res)
  if (!r) return
  // 1：写端点书注册重验补配——同文件
  // words-diary.post（59 先例）六族写端点均有，唯 trash 两端点漏配；restoreTrash
  // 内部多 await（清单锁/簿记）后对 originalPath mkdir recursive，窗口内书被删/改名
  // 即对旧捕获路径重建孤儿目录树（无 book.yaml，repairBooks 不认领）。trash 不持任务
  // 闸、不进串行链，本重验是该请求唯一防线。
  const moved = bookMovedFailure(ctx.workDir, params['name'], r.bookRoot)
  if (moved) return replyError(res, structStatus(moved.code), moved.code, moved.reason)
  const id = params['id'] ?? ''
  const result = await restoreTrash(r.bookRoot, id)
  // 失败走 replyError 统一信封（原裸 result 违反 schema.ts 信封约定）
  if (result.ok) {
    invalidateBookSummary(r.bookRoot) // 写出口失效书架摘要（30s TTL，见头注）
    reply(res, 200, result)
  } else replyError(res, structStatus(result.code), result.code, result.reason)
}

export async function handleTrashPurge(
  ctx: DocumentCtx,
  params: Record<string, string>,
  res: ServerResponse,
): Promise<void> {
  const r = resolveBookOrReply(ctx.workDir, params['name'], res)
  if (!r) return
  // -1：同 restore——purgeTrash 恢复清单 RMW 段同样对 bookRoot 下路径落盘
  const moved = bookMovedFailure(ctx.workDir, params['name'], r.bookRoot)
  if (moved) return replyError(res, structStatus(moved.code), moved.code, moved.reason)
  const id = params['id'] ?? ''
  const result = await purgeTrash(r.bookRoot, id)
  // 失败走 replyError 统一信封（原裸 result 违反 schema.ts 信封约定）
  if (result.ok) {
    // 写出口失效书架摘要——purge 只删 工作区/.trash 副本（正文集合不变），此处随文档
    // 写出口家族统一失效（廉价 forget），与 restore/删除出口同口径。
    invalidateBookSummary(r.bookRoot)
    reply(res, 200, result)
  } else replyError(res, structStatus(result.code), result.code, result.reason)
}
