/**
 * 账本推进声明端点（W-P1-3 右端：AI 草拟 + 作者确认）。
 *
 * POST /api/books/:name/lead-updates  body {chapter}
 *   → 生成逻辑在 process/lead-update-draft.ts（self-heal 写稿完成后共用），
 *     此端点仅做 book 解析 + 调用 + 响应映射。
 *
 * prompt 自含任务说明（system prompt 为空），纯文本产出。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { readJson, reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { generateLeadUpdateDraft } from '../../../process/lead-update-draft.js'
import { acquireTaskGate, orchestrationBusyFor } from './task-gate.js' // RB-SV-P2-2：长任务并发闸
import { getDriver, ensureSession } from '../../../driver/index.js' // R0912-P2-①：中断通道注册面
import type { Session } from '../../../driver/types.js'

interface LeadUpdateCtx {
  workDir: string | null
  userDataPath: string | null
}

export function registerLeadUpdateRoutes(ctx: LeadUpdateCtx): void {
  defineRoute('books.lead-updates', {
    method: 'POST',
    path: '/api/books/:name/lead-updates',
    // R49-8（评审 R49）：本 handler 实际消费请求体（readJson）——参数名去 `_` 前缀
    //（本仓约定 `_` 前缀 = 未使用参数）；按位置传参，注册点无关，纯改名零行为。
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    // R67-13（十五轮）：编排互斥矩阵补角——写稿系编排在途（self-heal/对话/后台收尾）
    // 时拒收生成长任务（细纲/账本是写稿上下文注入源，在途覆盖写 = 混合态上下文）
    const busyOrch = orchestrationBusyFor(params['name']!)
    if (busyOrch) return replyError(res, 409, 'BUSY', busyOrch)
    // RB-SV-P2-2：长任务并发闸（AI 草拟分钟级，覆盖落盘 工作区/账本推进.md）
    const release = acquireTaskGate(params['name']!, 'lead-updates')
    if (!release) return replyError(res, 409, 'BUSY', '本书正在草拟账本推进，请等待完成后再试')
    // R0912-P2-①（2026-09-11 重评-0911c 修复批）：接入中断通道——此前 generateLeadUpdateDraft
    // 不传 signal，/interrupt 对在途草拟完全无效且 driver.isRunning 假空闲（假成功）。接法
    // 照抄 stream.ts spawn/self-heal 的 register/unregister 形态：编排段新建 ctrl →
    // driver.registerCtrl（owner='lead-updates:<书名>'，含书名使跨书并发互不误伤；同书重入
    // 已被任务闸 409 挡住，同 owner 串行换新安全）→ ctrl.signal 沿 process 层既有形参
    // （Z-P1-1）透传 runSpec → settle（成功/失败/中断）统一注销。
    const driver = getDriver()
    let registeredSession: Session | null = null
    let registeredCtrl: AbortController | null = null
    try {
      const session = await ensureSession(params['name']!, ctx.workDir!)
      registeredSession = session
      const ctrl = new AbortController()
      driver.registerCtrl?.(session, ctrl, `lead-updates:${params['name']!}`)
      registeredCtrl = ctrl
      const body = await readJson(req)
      const chapter = Number(body['chapter'])
      if (!Number.isInteger(chapter) || chapter < 1) return replyError(res, 400, 'BAD_INPUT', 'chapter 需为正整数')

      const bookRoot = r.bookRoot
      // 复用共享生成函数（self-heal 写稿完成后也走这里），业务拒绝/落盘错误统一在此映射
      const result = await generateLeadUpdateDraft(bookRoot, chapter, ctx.userDataPath, ctrl.signal)
      if (!result.ok) {
        // R0912-P2-①：中断收口——process 层把 runSpec 的 ABORTED 坍缩为 failed，此处按
        // ctrl 信号如实映射 499 人话信封（对齐 outline/rewrite 既有 ABORTED→499 先例）
        if (ctrl.signal.aborted) return replyError(res, 499, 'ABORTED', '已中断')
        // rejected(业务拒绝)→400 BAD_INPUT；not-found(章不存在)→404 NOT_FOUND；其余 →500 ERROR
        const status = result.code === 'rejected' ? 400 : result.code === 'not-found' ? 404 : 500
        const code = result.code === 'rejected' ? 'BAD_INPUT' : result.code === 'not-found' ? 'NOT_FOUND' : 'ERROR'
        return replyError(res, status, code, result.error)
      }
      reply(res, 200, { ok: true, path: '工作区/账本推进.md', count: result.count })
    } finally {
      // R0912-P2-①：settle（成功/失败/中断）统一注销——isRunning 归 false（cc X-P2-11 口径）；
      // ensureSession 失败（未注册）时跳过
      if (registeredCtrl && registeredSession) driver.unregisterCtrl?.(registeredSession, registeredCtrl)
      release()
    }
  },
  })
}
