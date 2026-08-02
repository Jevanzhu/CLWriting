/**
 * 导出端点（#8.4）：直调内核 exportBook。
 *
 * - POST /api/books/:name/export    body {format, platform?} → 干净导出定稿（剥 front matter）
 *
 * 确定性操作（不涉大模型），直调内核函数。
 * 写端点带 session token 校验（defense-in-depth）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { route } from '../router.js'
import { checkToken, readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { exportBook, type ExportFormat, type ExportPlatform } from '../../../export/index.js'

interface IoCtx {
  workDir: string | null
  token: string
}

const EXPORT_FORMATS = new Set(['merged', 'split', 'both'])
const PLATFORMS = new Set(['generic', 'wechat', 'zhihu-salt', 'fanqie', 'xiaohongshu'])

export function registerIoRoutes(ctx: IoCtx): void {
  // 导出定稿
  route('POST', '/api/books/:name/export', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    if (!checkToken(req, ctx.token)) return reply(res, 403, { error: 'token 校验失败' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书：${params['name']}` })
    const body = await readJson(req)
    const format: ExportFormat = EXPORT_FORMATS.has(String(body['format'])) ? (String(body['format']) as ExportFormat) : 'both'
    const platform: ExportPlatform = PLATFORMS.has(String(body['platform'])) ? (String(body['platform']) as ExportPlatform) : 'generic'
    const result = exportBook({ bookRoot: join(ctx.workDir, entry.path), format, platform })
    // 业务失败编码在 body.ok,不用 500（前端 apiJson 会当异常抛,吞诊断信息）
    if (!result.ok) return reply(res, 200, { ok: false, code: 1, stdout: '', stderr: result.error ?? '导出失败' })
    reply(res, 200, {
      ok: true,
      code: 0,
      stdout: `已导出 ${result.chapterCount} ${result.unit}：\n${result.files.join('\n')}`,
      stderr: '',
    })
  })
}