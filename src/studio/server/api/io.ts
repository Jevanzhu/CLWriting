/**
 * 导出端点（#8.4）：内核 exportBook 经 worker 线程执行。
 *
 * - POST /api/books/:name/export    body {format, platform?} → 干净导出定稿（剥 front matter）
 *
 * 确定性操作（不涉大模型）。B-24（第六十轮补修）：内核为全同步 IO（S4 留档），
 * 直调会独占服务进程事件循环（大书导出期间全部书的 SSE 心跳/保存停摆）——改经
 * run-async.ts 卸载 worker 线程，服务进程只等消息（内核零改动）。
 * 写端点带 session token 校验（defense-in-depth）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { checkToken, readJson, reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { runExportBookAsync } from '../../../export/run-async.js'
import type { ExportFormat, ExportPlatform } from '../../../export/index.js'
import { SUBMISSION_PLATFORMS } from '../../../metrics/short-index.js'
import { acquireTaskGate } from './task-gate.js' // S3（五十九轮）：export 并发闸

interface IoCtx {
  workDir: string | null
  token: string
}

const EXPORT_FORMATS = new Set(['merged', 'split', 'both'])
const PLATFORMS = new Set(SUBMISSION_PLATFORMS)

// 内存闸（2026-08-24 审计 A1）：全局导出 worker 并发闸——task-gate 只按书限并发，
// 跨书同时导出会各自 spawn worker（src 形态每线程还独立挂 tsx loader + 内核模块图），
// 峰值线性叠加（19GB 事故的乘法项之一）。全局同时在跑 export worker ≤2，超出排队
//（不 409——跨书导出可等，用户无感；单书并发仍走 task-gate 409 语义不变）。
// acquireExportSlot 导出仅供测试断言排队/放行。
const MAX_EXPORT_WORKERS = 2
let activeExportWorkers = 0
const exportWaiters: Array<() => void> = []

export async function acquireExportSlot(): Promise<() => void> {
  if (activeExportWorkers >= MAX_EXPORT_WORKERS) {
    await new Promise<void>((resolve) => exportWaiters.push(resolve))
  }
  // 到这里必有空位：either 上面没到 cap（同步块内 check+increment 无 await，原子），
  // or 前一个 release 已把名额让给我们（release 先 shift 再 resolve，此处 increment）
  activeExportWorkers++
  return () => {
    activeExportWorkers--
    const next = exportWaiters.shift()
    if (next) next()
  }
}

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
    // 并发第二请求 409（与 analyze/batch-finalize 闸同口径）。闸留本进程持闸跨
    // await（worker 执行期间仍占闸，并发语义不变）。
    const release = acquireTaskGate(params['name']!, 'export')
    if (!release) return replyError(res, 409, 'BUSY', '本书已有导出任务在跑，请等待完成后再试')
    let releaseGlobal: (() => void) | null = null
    try {
      const body = await readJson(req)
      const format: ExportFormat = EXPORT_FORMATS.has(String(body['format'])) ? (String(body['format']) as ExportFormat) : 'both'
      const platform: ExportPlatform = PLATFORMS.has(String(body['platform'])) ? (String(body['platform']) as ExportPlatform) : 'generic'
      releaseGlobal = await acquireExportSlot()
      const result = await runExportBookAsync({ bookRoot: r.bookRoot, format, platform })
      // B-23（第六十轮补修）：业务失败回 422 错误信封——原 200 {ok:false} 是全域
      // 错误信封唯一豁免点，旧注释「apiJson 当异常抛吞诊断信息」已被 dv-01 错误
      // 信封判别取代（有信封 → body.error 完整保留，ExportDialog catch 后原样展示）。
      // ii 批：成功负载为域形状（chapterCount/unit/files），不透传 CLI 进程信封
      if (!result.ok) return replyError(res, 422, 'EXPORT_FAILED', result.error ?? '导出失败')
      reply(res, 200, {
        ok: true,
        chapterCount: result.chapterCount,
        unit: result.unit,
        files: result.files,
      })
    } finally {
      releaseGlobal?.()
      release()
    }
  },
  })
}