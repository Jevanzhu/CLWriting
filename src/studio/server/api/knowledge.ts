/**
 * 知识层端点（#8.3）：knowledge 校验 + learn 文风收割闭环。
 *
 * - POST /api/books/:name/knowledge-check → spawn clwriting knowledge check → manifest 校验报告
 * - POST /api/books/:name/learn           → learnFromBook 产候选（规则打分，不涉大模型）
 * - POST /api/books/:name/learn-commit    body {samples, quotes} → commitSamples + commitQuotes 入库
 *
 * learn 候选制（品味归人）：产候选 → 作者勾选 → 入库，不自动入库。
 * learn 仅长篇（learnFromBook 扫 定稿/正文/；短篇无此结构，返错）。
 * knowledge/learn-commit 调内核函数（不 spawn CLI，非交互）；knowledge-check spawn CLI（确定性）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { route } from '../router.js'
import { readBooks } from '../../../install/books.js'
import { learnFromBook } from '../../../learn/index.js'
import { commitSamples, commitQuotes } from '../../../learn/commit.js'
import type { SampleCandidate, QuoteCandidate } from '../../../learn/index.js'
import { runClwritingCli } from '../cli-runner.js'

interface KnowledgeCtx {
  workDir: string | null
  token: string
}

export function registerKnowledgeRoutes(ctx: KnowledgeCtx): void {
  // knowledge check（spawn CLI 校验 manifest）
  route('POST', '/api/books/:name/knowledge-check', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    if (!checkToken(req, ctx.token)) return reply(res, 403, { error: 'token 校验失败' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书：${params['name']}` })
    const result = await runClwritingCli(['knowledge', 'check'], join(ctx.workDir, entry.path))
    reply(res, result.ok ? 200 : 500, result)
  })

  // learn 产候选（调内核 learnFromBook，规则打分不涉大模型）
  route('POST', '/api/books/:name/learn', (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    if (!checkToken(req, ctx.token)) return reply(res, 403, { error: 'token 校验失败' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书：${params['name']}` })
    const result = learnFromBook(join(ctx.workDir, entry.path))
    if (!result.ok) return reply(res, 400, { error: result.error })
    reply(res, 200, { samples: result.samples ?? [], quotes: result.quotes ?? [] })
  })

  // learn 入库（作者勾选后调内核 commitSamples/commitQuotes）
  route('POST', '/api/books/:name/learn-commit', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    if (!checkToken(req, ctx.token)) return reply(res, 403, { error: 'token 校验失败' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书：${params['name']}` })
    const body = await readJson(req)
    const samples = Array.isArray(body['samples']) ? (body['samples'] as SampleCandidate[]) : []
    const quotes = Array.isArray(body['quotes']) ? (body['quotes'] as QuoteCandidate[]) : []
    const bookRoot = join(ctx.workDir, entry.path)
    const sampleFiles = samples.length ? commitSamples(bookRoot, samples) : []
    const quoteFiles = quotes.length ? commitQuotes(bookRoot, quotes) : []
    reply(res, 200, { ok: true, sampleFiles, quoteFiles })
  })
}

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
