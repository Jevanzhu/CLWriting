/**
 * 知识层端点（#8.3）：learn 文风收割闭环。
 *
 * - POST /api/books/:name/learn           → learnFromBook 产候选（规则打分，不涉大模型）
 * - POST /api/books/:name/learn-commit    body {samples, quotes} → commitSamples + commitQuotes 入库
 *
 * learn 候选制（品味归人）：产候选 → 作者勾选 → 入库，不自动入库。
 * 均直接调内核函数（不 spawn CLI，非交互）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { route } from '../router.js'
import { checkToken, readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { learnFromBook } from '../../../learn/index.js'
import { commitSamples, commitQuotes } from '../../../learn/commit.js'
import type { SampleCandidate, QuoteCandidate } from '../../../learn/index.js'
interface KnowledgeCtx {
  workDir: string | null
  token: string
}

/** 校验 SampleCandidate 形状（防外部提交畸形数据经 as 断言绕过） */
function isSampleCandidate(v: unknown): v is SampleCandidate {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o['场景'] === 'string' && typeof o['正文'] === 'string' && typeof o['出处'] === 'string'
}

/** 校验 QuoteCandidate 形状 */
function isQuoteCandidate(v: unknown): v is QuoteCandidate {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o['场景'] === 'string' && typeof o['正文'] === 'string' && typeof o['出处'] === 'string'
}

export function registerKnowledgeRoutes(ctx: KnowledgeCtx): void {
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
    const samples = Array.isArray(body['samples']) ? (body['samples'] as unknown[]).filter(isSampleCandidate) : []
    const quotes = Array.isArray(body['quotes']) ? (body['quotes'] as unknown[]).filter(isQuoteCandidate) : []
    const bookRoot = join(ctx.workDir, entry.path)
    const sampleFiles = samples.length ? commitSamples(bookRoot, samples) : []
    const quoteFiles = quotes.length ? commitQuotes(bookRoot, quotes) : []
    reply(res, 200, { ok: true, sampleFiles, quoteFiles })
  })
}
