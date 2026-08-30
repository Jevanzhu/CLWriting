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
// R27-62（二十七轮）：等待面封顶——此前 FIFO 队列无界、等待无超时：队首 worker 挂死
// 时全体 waiter 无限滞留（前端转圈、全局导出不可用且无出口）。排队上限防请求堆积
// 雪崩；单 waiter 超时给滞留者明确出口（导出是分钟级任务，10min 足够宽）。超限/
// 超时回 503 BUSY（可重试语义），与单书 task-gate 409 口径区分。
const MAX_EXPORT_WAITERS = 8
let exportWaitTimeoutMs = 10 * 60_000
/** R27-62 测试钩子：注入等待超时（毫秒），回归测超时出口用。 */
export function __setExportWaitTimeoutForTest(ms: number): void {
  exportWaitTimeoutMs = ms
}
export class ExportSlotWaitError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'ExportSlotWaitError'
  }
}
let activeExportWorkers = 0
const exportWaiters: Array<() => void> = []

/**
 * 释放函数（R65-45 批注见 acquireExportSlot）：名额转移语义——release 时若有
 * waiter，不自减计数、直接 shift 队列并 resolve（名额直接转移给 waiter，waiter
 * 恢复后不再自增）；无 waiter 才自减。released 门防重复释放（二次转移/二次自减
 * 都会破坏计数不变量）。
 */
function makeExportSlotReleaser(): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    const next = exportWaiters.shift()
    if (next) {
      next() // 名额转移：activeExportWorkers 不变（waiter 恢复后不再自增）
      return
    }
    activeExportWorkers--
  }
}

export async function acquireExportSlot(): Promise<() => void> {
  if (activeExportWorkers >= MAX_EXPORT_WORKERS) {
    // R27-62（二十七轮）：队列封顶——超限直接拒（不无限堆积）
    if (exportWaiters.length >= MAX_EXPORT_WAITERS) {
      throw new ExportSlotWaitError(`导出排队已达上限（${MAX_EXPORT_WAITERS}），请稍后重试`)
    }
    // R27-62（二十七轮）：等待限时——resolve 与 timeout 竞速，先到者定局（单线程
    // 事件循环下二者互斥执行）；超时方把自己从队列摘除再抛错，防 release shift 到
    // 已废弃的 waiter 名额转移落空
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const idx = exportWaiters.indexOf(wrapped)
        if (idx !== -1) exportWaiters.splice(idx, 1)
        reject(new ExportSlotWaitError(`导出排队等待超时（${Math.round(exportWaitTimeoutMs / 60_000)} 分钟），请稍后重试`))
      }, exportWaitTimeoutMs)
      const wrapped = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      exportWaiters.push(wrapped)
    })
    // R65-45（总六十五轮）：名额已由 release 直接转移（release 未自减、直接 resolve
    // 本 waiter）——此处不再自增。原「release 先自减再 resolve、waiter 微任务恢复后
    // 才自增」存在窗口：窗口内新请求查 activeExportWorkers < MAX 即插队直接放行，
    // 瞬时并发超 MAX=2（违反 A1 全局闸设计意图）。转移语义下 FIFO 不变（shift 保序）。
    return makeExportSlotReleaser()
  }
  // 到这里必有空位：同步块内 check+increment 无 await，原子
  activeExportWorkers++
  return makeExportSlotReleaser()
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
      // R72-10（二十轮 D-3）：显式非法值回 400（与全域 fail-fast 口径一致）；缺省
      //（undefined）保留回落 both/generic（兼容不带参调用方）
      const formatRaw = body['format'] === undefined ? 'both' : String(body['format'])
      if (!EXPORT_FORMATS.has(formatRaw)) {
        return replyError(res, 400, 'BAD_INPUT', `非法导出格式「${formatRaw}」，允许：${[...EXPORT_FORMATS].join(' / ')}`)
      }
      const platformRaw = body['platform'] === undefined ? 'generic' : String(body['platform'])
      if (!PLATFORMS.has(platformRaw)) {
        return replyError(res, 400, 'BAD_INPUT', `非法导出平台「${platformRaw}」，允许：${[...PLATFORMS].join(' / ')}`)
      }
      const format: ExportFormat = formatRaw as ExportFormat
      const platform: ExportPlatform = platformRaw as ExportPlatform
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
    } catch (e) {
      // R27-62（二十七轮）：排队超限/超时给 503 信封（可重试），不再直穿 500 兜底
      if (e instanceof ExportSlotWaitError) {
        return replyError(res, 503, 'BUSY', e.message)
      }
      throw e
    } finally {
      releaseGlobal?.()
      release()
    }
  },
  })
}