/**
 * 文档 CRUD 与字数日记 REST 端点（路由声明面）。
 *
 * 路由：字数日记（GET/POST /words-diary，今日基线）、W2A 新建文档（POST /documents）、移动/重命名/
 * meta/fm（PATCH /documents/:docId）、E3.3 复制文档（POST copy）、软删（DELETE /documents/:docId）
 * 与回收站（GET /trash、POST /trash/:id/restore、DELETE /trash/:id 永久删）。各域路由相对序
 * 与全局注册序不变——dispatch 按注册顺序匹配，顺序是 router.ts 的隐性契约。
 * 编排体（链单元 op 体 / 伏笔差分接线 / 书注册重验 / 回包信封）下沉 documents-crud-ops.ts：
 * 本文件只留 method/path/gate/parse/bodyLimit 声明与一行转调（范式同 documents-core.ts 的
 * runBookScopedOp 承接五站不变链——域路由文件单向 import 落点档）。
 * 依赖方向：本文件 → defineRoute + 回引基建单源 documents-core.ts（DocumentCtx）+ 转调
 * documents-crud-ops.ts（其 handler 体）；ops 档不 import 本文件（无环）。模块图单向无环
 * （core/ops 均不 import 本文件；聚合入口在残核 documents.ts 单向 import 本文件），
 * 本文件无顶层求值常量，无 TDZ 面。
 * 校验单轨：本文件四处带 body 的端点（words-diary.post / 新建 / PATCH / copy）由
 * handler 内联 readJson + 手工校验迁至 gate（找书 404 前置门）+ parse（body 形状 400）——
 * 错误优先序「找书 404 → body 400 → 链内 BOOK_MOVED 409」逐位不变；PATCH 的形状校验
 * 刻意留链单元内（409 先于 400 的现行优先序，见该端点注与 ops 档同名判据），只收 readJson 一半。
 */
import { defineRoute } from './schema.js'
import { CONTENT_BODY_LIMIT_BYTES } from '../http.js'
import { resolveBookOrReply } from '../book-context.js'
import type { DocumentCtx } from './documents-core.js'
import {
  handleDocumentCopy,
  handleDocumentCreate,
  handleDocumentDelete,
  handleDocumentPatch,
  handleTrashList,
  handleTrashPurge,
  handleTrashRestore,
  handleWordsDiaryGet,
  handleWordsDiaryPost,
} from './documents-crud-ops.js'

export function registerDocumentsCrudRoutes(ctx: DocumentCtx): void {
  // ── 字数日记（§5.4 今日基线）──────────────────────
  defineRoute('books.words-diary.get', {
    method: 'GET',
    path: '/api/books/:name/words-diary',
    handler: ({ params }, _req, res) => handleWordsDiaryGet(ctx, params, res),
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
    handler: (c, _req, res) => handleWordsDiaryPost(ctx, c, res),
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
    handler: (c, _req, res) => handleDocumentCreate(ctx, c, res),
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
    handler: (c, _req, res) => handleDocumentPatch(ctx, c, res),
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
    handler: (c, _req, res) => handleDocumentCopy(ctx, c, res),
  })

  // ── W2A：软删（→ 回收站）────────────────────────
  defineRoute('books.documents.delete', {
    method: 'DELETE',
    path: '/api/books/:name/documents/:docId',
    handler: ({ params }, _req, res) => handleDocumentDelete(ctx, params, res),
  })

  // ── W2A：软删（→ 回收站）────────────────────────
  defineRoute('books.trash', {
    method: 'GET',
    path: '/api/books/:name/trash',
    handler: ({ params }, _req, res) => handleTrashList(ctx, params, res),
  })

  defineRoute('books.trash.restore', {
    method: 'POST',
    path: '/api/books/:name/trash/:id/restore',
    handler: ({ params }, _req, res) => handleTrashRestore(ctx, params, res),
  })

  defineRoute('books.trash.delete', {
    method: 'DELETE',
    path: '/api/books/:name/trash/:id',
    handler: ({ params }, _req, res) => handleTrashPurge(ctx, params, res),
  })
}
