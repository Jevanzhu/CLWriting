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
import { defineRoute } from './schema.js'
import { checkToken, readJson, reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { learnFromBook } from '../../../learn/index.js'
import { commitSamples, commitQuotes } from '../../../learn/commit.js'
import type { LearnResult, SampleCandidate, QuoteCandidate } from '../../../learn/index.js'
import { acquireTaskGate } from './task-gate.js' // RB-SV-P2-2：长任务并发闸
interface KnowledgeCtx {
  workDir: string | null
  token: string
}

// ── R66-28（十四轮）：/learn 全书扫描的并发闸 + TTL 缓存 ──────────────────────
// learnFromBook 同步整读全书定稿正文（Node 请求线程阻塞秒级），此前既无并发闸也无缓存：
// 重复点击 = 双跑双扫；health/files/documents 三处同型已修，此处漏网。口径对齐 health.ts
// styleScanCache：5s TTL + 书键 Map FIFO 上限，纯 TTL 无写路径失效挂点（learn 候选只读
// 落盘 工作区/learn候选，书内容变化最迟 5s 可见）。
const LEARN_CACHE_TTL = 5000
const LEARN_CACHE_MAX = 32
const learnCache = new Map<string, { result: LearnResult; ts: number }>()
/** R66-28：TTL 测试注入口（先例同 health.ts __setStyleScanTtlForTest）——真实 5s 墙钟
 *  依赖会让「失效重扫」用例慢机假红，测试注入短档消除。仅测试用。 */
let learnTtlMs: number | null = null
export function __setLearnTtlForTest(ms: number | null): void {
  learnTtlMs = ms
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
  defineRoute('books.learn', {
    method: 'POST',
    path: '/api/books/:name/learn',
    handler: ({ params }, req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.workDir) return replyError(res, 400, 'NO_WORKDIR', '未定位到工作目录')
    if (!checkToken(req, ctx.token)) return replyError(res, 403, 'FORBIDDEN', 'token 校验失败')
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    // R66-28（十四轮）：全书同步扫描既无并发闸也无缓存——重复点击双跑双扫（秒级阻塞
    // 请求线程）。套 acquireTaskGate 同款并发闸（learnFromBook 同步执行，release 同步
    // finally 释放即可），扫描结果按书 5s TTL 缓存（口径见 learnCache 头注）。
    const release = acquireTaskGate(params['name']!, 'learn')
    if (!release) return replyError(res, 409, 'BUSY', '本书正在收割文风候选，请等待完成后再试')
    try {
      const now = Date.now()
      const cached = learnCache.get(r.bookRoot)
      let result: LearnResult
      if (cached && now - cached.ts < (learnTtlMs ?? LEARN_CACHE_TTL)) {
        result = cached.result // R66-28：TTL 命中跳过全书重扫
      } else {
        result = learnFromBook(r.bookRoot)
        // 只缓存成功结果——失败（无定稿正文/解析失败）多为输入问题，重试应现算
        if (result.ok) {
          // 简单 FIFO 淘汰（Map 保插入序）：超上限丢最旧条目，防长期运行的书库累积
          if (learnCache.size >= LEARN_CACHE_MAX) {
            const oldest = learnCache.keys().next().value
            if (oldest !== undefined) learnCache.delete(oldest)
          }
          learnCache.set(r.bookRoot, { result, ts: now })
        }
      }
      if (!result.ok) return replyError(res, 400, 'BAD_INPUT', result.error ?? '学习产出候选失败')
      reply(res, 200, { samples: result.samples ?? [], quotes: result.quotes ?? [] })
    } finally {
      release()
    }
  },
  })

  // learn 入库（作者勾选后调内核 commitSamples/commitQuotes）
  defineRoute('books.learn-commit', {
    method: 'POST',
    path: '/api/books/:name/learn-commit',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.workDir) return replyError(res, 400, 'NO_WORKDIR', '未定位到工作目录')
    if (!checkToken(req, ctx.token)) return replyError(res, 403, 'FORBIDDEN', 'token 校验失败')
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    const body = await readJson(req)
    const samples = Array.isArray(body['samples']) ? (body['samples'] as unknown[]).filter(isSampleCandidate) : []
    const quotes = Array.isArray(body['quotes']) ? (body['quotes'] as unknown[]).filter(isQuoteCandidate) : []
    const bookRoot = r.bookRoot
    const sampleFiles = samples.length ? commitSamples(bookRoot, samples) : []
    const quoteFiles = quotes.length ? commitQuotes(bookRoot, quotes) : []
    reply(res, 200, { ok: true, sampleFiles, quoteFiles })
  },
  })
}
