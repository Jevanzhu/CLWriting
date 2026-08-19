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
import { acquireTaskGate } from './task-gate.js' // RB-SV-P2-2：长任务并发闸

interface LeadUpdateCtx {
  workDir: string | null
  userDataPath: string | null
}

export function registerLeadUpdateRoutes(ctx: LeadUpdateCtx): void {
  defineRoute('books.lead-updates', {
    method: 'POST',
    path: '/api/books/:name/lead-updates',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    // RB-SV-P2-2：长任务并发闸（AI 草拟分钟级，覆盖落盘 工作区/账本推进.md）
    const release = acquireTaskGate(params['name']!, 'lead-updates')
    if (!release) return replyError(res, 409, 'BUSY', '本书正在草拟账本推进，请等待完成后再试')
    try {
      const body = await readJson(_req)
      const chapter = Number(body['chapter'])
      if (!Number.isInteger(chapter) || chapter < 1) return replyError(res, 400, 'BAD_INPUT', 'chapter 需为正整数')

      const bookRoot = r.bookRoot
      // 复用共享生成函数（self-heal 写稿完成后也走这里），业务拒绝/落盘错误统一在此映射
      const result = await generateLeadUpdateDraft(bookRoot, chapter, ctx.userDataPath)
      if (!result.ok) {
        // rejected(业务拒绝)→400 BAD_INPUT；not-found(章不存在)→404 NOT_FOUND；其余 →500 ERROR
        const status = result.code === 'rejected' ? 400 : result.code === 'not-found' ? 404 : 500
        const code = result.code === 'rejected' ? 'BAD_INPUT' : result.code === 'not-found' ? 'NOT_FOUND' : 'ERROR'
        return replyError(res, status, code, result.error)
      }
      reply(res, 200, { ok: true, path: '工作区/账本推进.md', count: result.count })
    } finally {
      release()
    }
  },
  })
}
