/**
 * 导入 / 导出 / RAG 端点（#8.4）：spawn clwriting export / import / enable-rag。
 *
 * - POST /api/books/:name/export    body {format, platform?} → 干净导出定稿（剥 front matter）
 * - POST /api/import                 body {sourcePath, name?, kind?, genre?} → 导入 v0.2 正文（length-routing 分流长短篇）
 * - POST /api/books/:name/enable-rag body {endpoint, model, key?, useEnv?} → 启用 RAG 插件
 *
 * 确定性 CLI（不涉大模型）。enable-rag 的 key 落本地 .clwriting/rag.secret（gitignore 区，红线 H1 不进 git），
 * 本地回环传输；其余参数（endpoint/model）写 book.yaml 非密段。
 * 写端点带 session token 校验（defense-in-depth，与 settings 一致）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { route } from '../router.js'
import { readBooks } from '../../../install/books.js'
import { runClwritingCli } from '../cli-runner.js'

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
    const format = EXPORT_FORMATS.has(String(body['format'])) ? String(body['format']) : 'both'
    const args = ['export', '--format', format]
    if (PLATFORMS.has(String(body['platform']))) args.push('--platform', String(body['platform']))
    const result = await runClwritingCli(args, join(ctx.workDir, entry.path))
    reply(res, result.ok ? 200 : 500, result)
  })

  // 导入 v0.2 正文（作用于工作目录，建新书；length-routing 自动分流长短篇）
  route('POST', '/api/import', async (req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    if (!checkToken(req, ctx.token)) return reply(res, 403, { error: 'token 校验失败' })
    const body = await readJson(req)
    const sourcePath = typeof body['sourcePath'] === 'string' ? body['sourcePath'].trim() : ''
    if (!sourcePath) return reply(res, 400, { error: '缺少 sourcePath（v0.2 正文路径）' })
    const args = ['import', sourcePath]
    if (typeof body['name'] === 'string' && body['name'].trim()) args.push('--name', body['name'].trim())
    if (body['kind'] === 'long' || body['kind'] === 'short') args.push('--kind', body['kind'])
    if (typeof body['genre'] === 'string' && body['genre'].trim()) args.push('--genre', body['genre'].trim())
    const result = await runClwritingCli(args, ctx.workDir)
    reply(res, result.ok ? 200 : 500, result)
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
    const args = ['enable-rag', '--endpoint', endpoint, '--model', model]
    const useEnv = body['useEnv'] === true
    if (!useEnv && typeof body['key'] === 'string' && body['key']) args.push('--key', body['key'])
    if (useEnv) args.push('--use-env')
    const result = await runClwritingCli(args, join(ctx.workDir, entry.path))
    reply(res, result.ok ? 200 : 500, result)
  })
}

/** session token 校验（写端点 defense-in-depth） */
function checkToken(req: IncomingMessage, token: string): boolean {
  return req.headers['x-studio-token'] === token
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let buf = ''
    req.on('data', (c) => {
      buf += c
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(buf || '{}'))
      } catch {
        resolve({})
      }
    })
  })
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
