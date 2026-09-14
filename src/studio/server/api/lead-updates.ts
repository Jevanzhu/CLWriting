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
import { runGatedGeneration } from './task-gate.js' // P1-2（复审-0914-优化修复批）：长任务门控包装

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
    // R67-13（十五轮）编排互斥预检 + RB-SV-P2-2 任务闸（409 文案逐位保留）+
    // R0912-P2-①（2026-09-11 重评-0911c 修复批）中断通道（owner='lead-updates:<书名>'，
    // ctrl.signal 沿 process 层既有形参 Z-P1-1 透传）——十段复制收编 runGatedGeneration
    // 单源（复审-0914-优化修复批 P1-2，接法头注见 task-gate.ts）。
    return runGatedGeneration(res, {
      book: params['name']!,
      workDir: ctx.workDir!,
      action: 'lead-updates',
      busyText: '本书正在草拟账本推进，请等待完成后再试',
    }, async (ctrl) => {
      const body = await readJson(req)
      const chapter = Number(body['chapter'])
      if (!Number.isInteger(chapter) || chapter < 1) return replyError(res, 400, 'BAD_INPUT', 'chapter 需为正整数')

      const bookRoot = r.bookRoot
      // 复用共享生成函数（self-heal 写稿完成后也走这里），业务拒绝/落盘错误统一在此映射
      const result = await generateLeadUpdateDraft(bookRoot, chapter, ctx.userDataPath, ctrl.signal)
      if (!result.ok) {
        // R0912-P2-①：中断收口——process 层把 runSpec 的 ABORTED 坍缩为 failed，此处按
        // ctrl 信号如实映射 499 人话信封（对齐 outline/rewrite 既有 ABORTED→499 先例；
        // 本端点映射基于 process 层 result.code 分档，语义变体保留端点本地）
        if (ctrl.signal.aborted) return replyError(res, 499, 'ABORTED', '已中断')
        // rejected(业务拒绝)→400 BAD_INPUT；not-found(章不存在)→404 NOT_FOUND；其余 →500 ERROR
        const status = result.code === 'rejected' ? 400 : result.code === 'not-found' ? 404 : 500
        const code = result.code === 'rejected' ? 'BAD_INPUT' : result.code === 'not-found' ? 'NOT_FOUND' : 'ERROR'
        return replyError(res, status, code, result.error)
      }
      reply(res, 200, { ok: true, path: '工作区/账本推进.md', count: result.count })
    })
  },
  })
}
