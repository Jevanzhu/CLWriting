/**
 * 导入 / 导出 / RAG 端点（#8.4）：直调内核（exportBook / importV02Book / enableRag），不再 spawn CLI。
 *
 * - POST /api/books/:name/export    body {format, platform?} → 干净导出定稿（剥 front matter）
 * - POST /api/import                 body {sourcePath, name?, kind?, genre?} → 导入 v0.2 正文（length-routing 分流长短篇）
 * - POST /api/books/:name/enable-rag body {endpoint, model, key?, useEnv?} → 启用 RAG 插件
 *
 * 确定性操作（不涉大模型），直调内核函数。enable-rag 的 key 落本地 .clwriting/rag.secret
 * （gitignore 区，红线 H1 不进 git），本地回环传输；其余参数（endpoint/model）写 book.yaml 非密段。
 * 写端点带 session token 校验（defense-in-depth，与 settings 一致）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { route } from '../router.js'
import { checkToken, readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { exportBook, type ExportFormat, type ExportPlatform } from '../../../export/index.js'
import { importV02Book } from '../../../import/index.js'
import { enableRag } from '../../../rag/config.js'

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

  // 导入 v0.2 正文（作用于工作目录，建新书；length-routing 自动分流长短篇）
  route('POST', '/api/import', async (req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    if (!checkToken(req, ctx.token)) return reply(res, 403, { error: 'token 校验失败' })
    const body = await readJson(req)
    const sourcePath = typeof body['sourcePath'] === 'string' ? body['sourcePath'].trim() : ''
    if (!sourcePath) return reply(res, 400, { error: '缺少 sourcePath（v0.2 正文路径）' })
    const kind = body['kind'] === 'long' || body['kind'] === 'short' ? (body['kind'] as 'long' | 'short') : undefined
    const result = importV02Book({
      sourcePath,
      workDir: ctx.workDir,
      ...(typeof body['name'] === 'string' && body['name'].trim() ? { name: body['name'].trim() } : {}),
      ...(kind ? { kind } : {}),
      ...(typeof body['genre'] === 'string' && body['genre'].trim() ? { genre: body['genre'].trim() } : {}),
    })
    if (!result.ok) return reply(res, 200, { ok: false, code: 1, stdout: '', stderr: result.error ?? '导入失败' })
    reply(res, 200, {
      ok: true,
      code: 0,
      stdout: `已导入《${result.bookName ?? ''}》（${result.kind === 'short' ? '短篇' : '长篇'}，${result.chapterCount ?? 0} ${result.kind === 'short' ? '篇' : '章'}）`,
      stderr: '',
    })
  })

  // 启用 RAG 插件（key 落本地 rag.secret，不进 git）
  route('POST', '/api/books/:name/enable-rag', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    if (!checkToken(req, ctx.token)) return reply(res, 403, { error: 'token 校验失败' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书：${params['name']}` })
    const body = await readJson(req)
    const endpoint = typeof body['endpoint'] === 'string' ? body['endpoint'].trim() : ''
    const model = typeof body['model'] === 'string' ? body['model'].trim() : ''
    if (!endpoint || !model) return reply(res, 400, { error: '需要 endpoint 和 model' })
    const useEnv = body['useEnv'] === true
    const key = !useEnv && typeof body['key'] === 'string' && body['key'] ? (body['key'] as string) : undefined
    const result = enableRag(join(ctx.workDir, entry.path), ctx.workDir, {
      endpoint,
      model,
      ...(key ? { apiKey: key } : {}),
      ...(useEnv ? { useEnv: true } : {}),
    })
    if (!result.ok) return reply(res, 200, { ok: false, code: 1, stdout: '', stderr: result.reason })
    reply(res, 200, { ok: true, code: 0, stdout: 'RAG 插件已启用', stderr: '' })
  })
}