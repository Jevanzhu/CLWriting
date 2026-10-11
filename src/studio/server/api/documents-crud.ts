/**
 * 文档 CRUD 与字数日记 REST 端点。
 *
 * 路由：字数日记（GET/POST /words-diary，今日基线）、W2A 新建文档（POST /documents）、移动/重命名/
 * meta/fm（PATCH /documents/:docId）、E3.3 复制文档（POST copy）、软删（DELETE /documents/:docId）
 * 与回收站（GET /trash、POST /trash/:id/restore、DELETE /trash/:id 永久删）。各域路由相对序
 * 与全局注册序不变——dispatch 按注册顺序匹配，顺序是 router.ts 的隐性契约。
 * 依赖方向：本文件 → document 既有出边（只出不进，不 import ai/studio 反向）+ 回引基建单源
 * documents-core.ts（getOrCreateService / runBookScopedOp / structStatus / DocumentCtx）。模块图
 * 单向无环（core 不 import 同批任何 documents-* 模块；聚合入口在残核 documents.ts 单向 import
 * 本文件），本文件无顶层求值常量，无 TDZ 面。
 * 校验单轨：本文件四处带 body 的端点（words-diary.post / 新建 / PATCH / copy）由
 * handler 内联 readJson + 手工校验迁至 gate（找书 404 前置门）+ parse（body 形状 400）——
 * 错误优先序「找书 404 → body 400 → 链内 BOOK_MOVED 409」逐位不变；PATCH 的形状校验
 * 刻意留链单元内（409 先于 400 的现行优先序，见该端点注），只收 readJson 一半。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { reply, replyError, CONTENT_BODY_LIMIT_BYTES } from '../http.js'
import { bookMovedFailure, resolveBookOrReply } from '../book-context.js'
import type { CopyResult, CreateResult, MoveResult, TrashResult } from '../../../document/service.js'
import { readBaseline, appendBaseline, readTodayDelta, todayDate } from '../../../document/words-diary.js'
import { listTrash, restoreTrash, purgeTrash } from '../../../document/trash.js'
// 基建段回引单源 core（见文件头注依赖方向）
import { getOrCreateService, runBookScopedOp, structStatus, type DocumentCtx } from './documents-core.js'

export function registerDocumentsCrudRoutes(ctx: DocumentCtx): void {
  // ── 字数日记（§5.4 今日基线）──────────────────────
  defineRoute('books.words-diary.get', {
    method: 'GET',
    path: '/api/books/:name/words-diary',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return
      const date = todayDate()
      reply(res, 200, {
        ok: true,
        date,
        baseline: readBaseline(r.bookRoot, date),
        delta: readTodayDelta(r.bookRoot, date),
      })
    },
  })

  defineRoute('books.words-diary.post', {
    method: 'POST',
    path: '/api/books/:name/words-diary',
    // 校验单轨：找书 404（前置门）→ body 400（parse）→ BOOK_MOVED 409（链内/写前
    // 重验）的既有错误优先序由 gate→parse→handler 三段承载，响应对齐迁移前逐位不变。
    gate: ({ params, res }) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      return r ? { value: r } : false
    },
    parse: (raw) => {
      const body = (raw ?? {}) as Record<string, unknown>
      const baseline = Number(body['baseline'])
      if (!Number.isFinite(baseline) || baseline < 0) throw new Error('baseline 需非负数')
      return { baseline }
    },
    handler: ({ params, input, gate }, _req: IncomingMessage, res: ServerResponse) => {
      // 面 A（同型扫描接线）：书注册重验——入口快照（gate）到本写段之间可跨删书/改名
      // drain 时点，appendBaseline 对旧捕获路径 mkdir recursive + append 成孤儿；
      // 与五处链内单元同款（时序见 bookMovedFailure 头注）
      const moved = bookMovedFailure(ctx.workDir, params['name'], gate.bookRoot)
      if (moved) return replyError(res, structStatus(moved.code), moved.code, moved.reason)
      appendBaseline(gate.bookRoot, todayDate(), input.baseline)
      reply(res, 200, { ok: true })
    },
  })

  // ── W2A：新建文档 ──────────────────────────────
  defineRoute('books.documents', {
    method: 'POST',
    path: '/api/books/:name/documents',
    // 校验单轨：找书 404（gate）→ relPath 400（parse）→ 链内 BOOK_MOVED 409（序不变）
    gate: ({ params, res }) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      return r ? { value: r } : false
    },
    // RC：新建可带 content（建卷即建首章/导入大章）——同走内容档上限
    bodyLimit: CONTENT_BODY_LIMIT_BYTES,
    parse: (raw) => {
      const body = (raw ?? {}) as Record<string, unknown>
      const relPath = body['relPath']
      if (typeof relPath !== 'string' || !relPath) throw new Error('relPath 缺失')
      return { relPath, content: typeof body['content'] === 'string' ? body['content'] : undefined }
    },
    handler: async ({ params, input, gate }, _req: IncomingMessage, res: ServerResponse) => {
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
      if (result.ok) reply(res, 201, result)
      else replyError(res, structStatus(result.code), result.code, result.reason)
    },
  })

  // ── W2A：移动 / 重命名 ──────────────────────────
  defineRoute('books.documents.patch', {
    method: 'PATCH',
    path: '/api/books/:name/documents/:docId',
    // 读体随 parse（找书 404 仍由 gate 先于读体）——op 形状校验刻意留链单元内：
    // BOOK_MOVED 409 先于形状 400 的现行错误优先序由单元序保证（注释下方「形状校验留单元内」），
    // 迁进 parse 会把 400 提到 409 之前，属契约面翻转，故只收 readJson 一半。
    gate: ({ params, res }) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      return r ? { value: r } : false
    },
    parse: (raw) => (raw ?? {}) as Record<string, unknown>,
    handler: async ({ params, input: body, gate }, _req: IncomingMessage, res: ServerResponse) => {
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
      // 形状校验 400 的现行错误优先序由单元序保证）。
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
      if (result.ok) reply(res, 200, result)
      else replyError(res, structStatus(result.code), result.code, result.reason)
    },
  })

  // ── E3.3：复制文档（源 docId + 目标 relPath → 新 docId）──────────
  defineRoute('books.documents.copy', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/copy',
    // 校验单轨：找书 404（gate）→ relPath 400（parse）→ 链内 BOOK_MOVED 409（序不变）
    gate: ({ params, res }) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      return r ? { value: r } : false
    },
    parse: (raw) => {
      const body = (raw ?? {}) as Record<string, unknown>
      const relPath = body['relPath']
      if (typeof relPath !== 'string' || !relPath) throw new Error('relPath 缺失')
      return { relPath }
    },
    handler: async ({ params, input, gate }, _req: IncomingMessage, res: ServerResponse) => {
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
        reply(res, 201, result)
      } else replyError(res, structStatus(result.code), result.code, result.reason)
    },
  })

  // ── W2A：软删（→ 回收站）────────────────────────
  defineRoute('books.documents.delete', {
    method: 'DELETE',
    path: '/api/books/:name/documents/:docId',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
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
      if (result.ok) reply(res, 200, result)
      else replyError(res, structStatus(result.code), result.code, result.reason)
    },
  })

  // ── W2A：软删（→ 回收站）────────────────────────
  defineRoute('books.trash', {
    method: 'GET',
    path: '/api/books/:name/trash',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return
      reply(res, 200, { ok: true, entries: listTrash(r.bookRoot) })
    },
  })

  defineRoute('books.trash.restore', {
    method: 'POST',
    path: '/api/books/:name/trash/:id/restore',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
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
      if (result.ok) reply(res, 200, result)
      else replyError(res, structStatus(result.code), result.code, result.reason)
    },
  })

  defineRoute('books.trash.delete', {
    method: 'DELETE',
    path: '/api/books/:name/trash/:id',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return
      // -1：同 restore——purgeTrash 恢复清单 RMW 段同样对 bookRoot 下路径落盘
      const moved = bookMovedFailure(ctx.workDir, params['name'], r.bookRoot)
      if (moved) return replyError(res, structStatus(moved.code), moved.code, moved.reason)
      const id = params['id'] ?? ''
      const result = await purgeTrash(r.bookRoot, id)
      // 失败走 replyError 统一信封（原裸 result 违反 schema.ts 信封约定）
      if (result.ok) reply(res, 200, result)
      else replyError(res, structStatus(result.code), result.code, result.reason)
    },
  })
}
