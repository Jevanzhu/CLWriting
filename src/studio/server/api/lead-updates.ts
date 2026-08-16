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
import { join } from 'node:path'
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { generateLeadUpdateDraft } from '../../../process/lead-update-draft.js'
import { acquireTaskGate } from './task-gate.js' // RB-SV-P2-2：长任务并发闸

interface LeadUpdateCtx {
  workDir: string | null
  userDataPath: string | null
}

export function registerLeadUpdateRoutes(ctx: LeadUpdateCtx): void {
  route('POST', '/api/books/:name/lead-updates', async (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: '没有这本书:' + params['name'] })
    // RB-SV-P2-2：长任务并发闸（AI 草拟分钟级，覆盖落盘 工作区/账本推进.md）
    const release = acquireTaskGate(params['name']!, 'lead-updates')
    if (!release) return reply(res, 409, { error: '本书正在草拟账本推进，请等待完成后再试' })
    try {
      const body = await readJson(_req)
      const chapter = Number(body['chapter'])
      if (!Number.isInteger(chapter) || chapter < 1) return reply(res, 400, { error: 'chapter 需为正整数' })

      const bookRoot = join(ctx.workDir, entry.path)
      // 复用共享生成函数（self-heal 写稿完成后也走这里），业务拒绝/落盘错误统一在此映射
      const result = await generateLeadUpdateDraft(bookRoot, chapter, ctx.userDataPath)
      if (!result.ok) {
        const status = result.code === 'rejected' ? 400 : result.code === 'not-found' ? 404 : 500
        return reply(res, status, { error: result.error })
      }
      reply(res, 200, { ok: true, path: '工作区/账本推进.md', count: result.count })
    } finally {
      release()
    }
  })
}
