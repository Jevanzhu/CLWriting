/**
 * 导出端点（#8.4）：直调内核 exportBook。
 *
 * - POST /api/books/:name/export    body {format, platform?} → 干净导出定稿（剥 front matter）
 *
 * 确定性操作（不涉大模型），直调内核函数。
 * 写端点带 session token 校验（defense-in-depth）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { checkToken, readJson, reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { exportBook, type ExportFormat, type ExportPlatform } from '../../../export/index.js'
import { SUBMISSION_PLATFORMS } from '../../../metrics/short-index.js'
import { acquireTaskGate } from './task-gate.js' // S3（五十九轮）：export 并发闸

interface IoCtx {
  workDir: string | null
  token: string
}

const EXPORT_FORMATS = new Set(['merged', 'split', 'both'])
const PLATFORMS = new Set(SUBMISSION_PLATFORMS)

export function registerIoRoutes(ctx: IoCtx): void {
  // 导出定稿
  defineRoute('books.export', {
    method: 'POST',
    path: '/api/books/:name/export',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.workDir) return replyError(res, 400, 'NO_WORKDIR', '未定位到工作目录')
    if (!checkToken(req, ctx.token)) return replyError(res, 403, 'FORBIDDEN', 'token 校验失败')
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    // S3（五十九轮）：export 并发闸（acquireTaskGate 同款）——双击并发 exportBook 会
    // rmSync 同一导出目录互删 → ENOENT 500。同步占位（无 TOCTOU）、finally 释放，
    // 并发第二请求 409（与 analyze/batch-finalize 闸同口径）。注：export 内核仍为
    // 全同步 IO（S4 留档——异步化改动面大，先闸并发面，事件循环阻塞债另行批次收口）。
    const release = acquireTaskGate(params['name']!, 'export')
    if (!release) return replyError(res, 409, 'BUSY', '本书已有导出任务在跑，请等待完成后再试')
    try {
      const body = await readJson(req)
      const format: ExportFormat = EXPORT_FORMATS.has(String(body['format'])) ? (String(body['format']) as ExportFormat) : 'both'
      const platform: ExportPlatform = PLATFORMS.has(String(body['platform'])) ? (String(body['platform']) as ExportPlatform) : 'generic'
      const result = exportBook({ bookRoot: r.bookRoot, format, platform })
      // 业务失败编码在 body.ok,不用 500（前端 apiJson 会当异常抛,吞诊断信息）。
      // ii 批：域形状负载（chapterCount/unit/files）——此前透传 CLI 进程信封
      // {code,stdout,stderr} 是跨层形状泄漏，HTTP 契约与其余端点统一为业务字段
      if (!result.ok) return reply(res, 200, { ok: false, error: result.error ?? '导出失败' })
      reply(res, 200, {
        ok: true,
        chapterCount: result.chapterCount,
        unit: result.unit,
        files: result.files,
      })
    } finally {
      release()
    }
  },
  })
}