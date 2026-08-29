/**
 * 机检端点（M12 块3 B3.1，editor 组）：
 *
 * POST /api/books/:name/documents/:docId/check
 *   docId → 正文文档 → runAllChecks → CheckReport 直返（即算即显，**不落信封**）。
 *
 * 机检执行逻辑已下沉 src/check/run.ts（P1-8 架构治理），此处 re-export 兼容既有调用方
 * （三审端点 review.ts、AI 编排层 orchestrate 均从内核直接 import）。
 *
 * 无 AI 依赖、断网可用。流程照搬 cli/check.ts：rebuild 缓存（长篇）→ runAllChecks；
 * 账本两端闭合（declaredLeadIds/actualLeadIds）草稿目录有细纲时取，正文目录缺省安全。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { defineRoute } from './schema.js'
import { reply, replyError } from '../http.js'
import { resolveBook, resolveDocEntry } from '../book-context.js'
import { safeManifestPath } from '../../../fs/safe-path.js'
import { readAnalysis } from '../../../document/analysis.js'
import { openSessionStore, bookHash } from '../../../events/store.js'
import { QUOTE_OPEN, QUOTE_CLOSE } from '../../../check/quotes.js'
import { HANZI } from '../../../check/count.js' // R64-11：堆砌锚点汉字段单源（与 count.ts 口径一致）
import { checkFalsePositiveEvent } from '../../../events/chain-bridge.js'
import {
  runCheckForDocument,
  collectTreeIssues,
  checkOutcomeStatus,
} from '../../../check/run.js'

// re-export（P1-8 下沉兼容：既有 import 方零感知）
export {
  runCheckForDocument,
  checkOutcomeStatus,
  type CheckOutcome,
} from '../../../check/run.js'

interface CheckCtx {
  workDir: string | null
  /** 全局托底：short.strict 等书级未设键回落 global.json（喂机检的生效值） */
  userDataPath: string | null
}

// ── R75-D-P3b（批 D）：/tree-issues 结果 5s TTL 缓存 ─────────────────────
// collectTreeIssues 每请求同步扫全书定稿正文聚合机检 red + verdict 驳回（大书秒级
// 阻塞事件循环），前端树轮询/反复刷新会反复重扫。缓存口径对齐 health.ts styleScanCache
//（书键 Map + FIFO 上限 + 纯 TTL）：写路径不挂即时失效——保存/定稿/verdict 落盘后
// 最迟 5s 自愈（health.ts 先例同款，避免给每个写端点平添 forget 接线的过度设计）；
// 书删除/改名的生命周期清理走 forgetTreeIssuesCache（R67-15 forgetBookKeyedCaches 接线）。
const treeIssuesCache = new Map<string, { payload: Record<string, unknown>; ts: number }>()
/** R75-D-P3b：删书/改名失效挂点（books.ts forgetBookKeyedCaches 接线；TTL 5s 兜底自愈）。 */
export function forgetTreeIssuesCache(bookRoot: string): void {
  treeIssuesCache.delete(bookRoot)
}
/** R75-D-P3b 回归观测钩子（先例同 health.ts __styleScanCacheHasForTest）——仅测试用。 */
export function __treeIssuesCacheHasForTest(bookRoot: string): boolean {
  return treeIssuesCache.has(bookRoot)
}
/** R75-D-P3b：TTL 测试注入口（先例同 health.ts __setStyleScanTtlForTest）——传 null
 *  恢复默认。仅测试用，勿在生产路径调用。 */
let treeIssuesTtlMs: number | null = null
export function __setTreeIssuesTtlForTest(ms: number | null): void {
  treeIssuesTtlMs = ms
}
const TREE_ISSUES_TTL = 5000
const TREE_ISSUES_CACHE_MAX = 32

export function registerCheckRoutes(ctx: CheckCtx): void {
  defineRoute('books.documents.check', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/check',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)

      const bookRoot = r.bookRoot
      const docId = params['docId'] ?? ''
      const m = resolveDocEntry(bookRoot, docId)
      if (!m) return replyError(res, 404, 'NOT_FOUND', `文档ID未登记：${docId}`)

      const absPath = safeManifestPath(bookRoot, m.path)
      if (!absPath) return replyError(res, 400, 'BAD_PATH', '文档路径非法')
      if (!existsSync(absPath)) return replyError(res, 404, 'NOT_FOUND', `文档不存在：${m.path}`)

      const outcome = runCheckForDocument(bookRoot, absPath, ctx.userDataPath)
      if (!outcome.ok) {
        // N-2（第十二轮）：收编 replyError 单一出口——不再手拼 {ok:false,...} 混合信封
        return replyError(
          res,
          checkOutcomeStatus(outcome.code),
          outcome.code,
          outcome.error,
          outcome.details ? { details: outcome.details } : undefined,
        )
      }
      reply(res, 200, { ok: true, report: outcome.report, hasRed: outcome.hasRed })
    },
  })

  // ── B1（批 6）：机检误报标记 ──────────────────────────────────────
  // POST /documents/:docId/check-false-positive  body { checkId }
  // excerpt 服务端从正文切（命中区间 ±50 字、上限 200）——不信客户端传任意长文本。
  // 落 check/false-positive 事件（workspace 会话）；同章同 checkId 重复标记幂等
  //（append 多条；R64-44 注释对齐：查询侧尚未接线——语料回收消费时按
  //  (chapter, checkId) 取最近一条，当前全仓无读取方）。
  defineRoute('books.documents.check-false-positive', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/check-false-positive',
    parse: (body) => {
      const raw = body as Record<string, unknown>
      const checkId = typeof raw['checkId'] === 'string' ? raw['checkId'].trim() : ''
      if (!checkId) throw new Error('checkId 必填')
      return { checkId }
    },
    handler: async ({ params, input }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      const bookRoot = r.bookRoot
      const docId = params['docId'] ?? ''
      const m = resolveDocEntry(bookRoot, docId)
      if (!m) return replyError(res, 404, 'NOT_FOUND', `文档ID未登记：${docId}`)
      const absPath = safeManifestPath(bookRoot, m.path)
      if (!absPath) return replyError(res, 400, 'BAD_PATH', '文档路径非法')
      if (!existsSync(absPath)) return replyError(res, 404, 'NOT_FOUND', '文档不存在')

      const checkId = input.checkId

      // 复跑机检定位命中区间（机检零 token 纯函数，复跑成本可忽略）
      const outcome = runCheckForDocument(bookRoot, absPath, ctx.userDataPath)
      if (!outcome.ok) return replyError(res, checkOutcomeStatus(outcome.code), outcome.code, outcome.error)
      const items = outcome.report.sections.flatMap((s) => s.items).filter((i) => i.checkId === checkId)
      if (items.length === 0) {
        return replyError(res, 409, 'CONFLICT', `当前机检结果中没有 checkId=${checkId} 的命中（可能已修复，刷新机检后再标）`)
      }

      const excerpt = cutExcerpt(outcome.body, items.map((i) => i.message))
      if (ctx.userDataPath) {
        try {
          const store = openSessionStore(ctx.userDataPath, bookRoot)
          if (store) {
            // M-6：close 收进 finally——workspaceSession/appendEvents 抛错时旧实现
            // 跳过 close，引用计数单例的本次打开滞留到进程结束
            try {
              const sessionId = store.workspaceSession(bookHash(bookRoot))
              store.appendEvents(sessionId, [checkFalsePositiveEvent({ checkId, chapter: outcome.chapter.章号, excerpt, docId })])
            } finally {
              store.close()
            }
          }
        } catch {
          // 观测层：事件落库失败不阻断标记动作（toast 已反馈，语料损失可接受）
        }
      }
      reply(res, 200, { ok: true, checkId, chapter: outcome.chapter.章号, excerpt })
    },
  })

  // GET /tree-issues（T9b 树红点冒泡）：扫定稿正文聚合机检 red + verdict 驳回，
  // 返 { docId: { hasRed, verdictRejected } }（仅含有 issue 的 docId，余省略）。
  // rebuild 一次复用 db 循环 checkWithDb（避免每章 rebuild 的 O(N²)）；rebuild 失败降级空 issues（不阻塞树）。
  defineRoute('books.tree-issues', {
    method: 'GET',
    path: '/api/books/:name/tree-issues',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)

      const bookRoot = r.bookRoot
      // R75-D-P3b：命中短时缓存则跳过全书同步重扫（payload 为纯数据可复用）
      const now = Date.now()
      const ttl = treeIssuesTtlMs ?? TREE_ISSUES_TTL // 测试注入优先
      const cached = treeIssuesCache.get(bookRoot)
      if (cached && now - cached.ts < ttl) {
        reply(res, 200, cached.payload)
        return
      }
      // 聚合逻辑已下沉内核（P1-8）：扫正文 + 机检 + verdict 驳回，返回只有 issue 的 docId
      const { issues, rebuildFailed, leadsBookDegraded, chaptersDegraded } = collectTreeIssues(bookRoot, (docId) => {
        const reviewEnv = readAnalysis(bookRoot, docId, 'review')
        const v = (reviewEnv?.payload as { verdict?: { approved: boolean } } | undefined)?.verdict
        return v ?? undefined
      }, ctx.userDataPath)
      const payload: Record<string, unknown> = {
        ok: true,
        issues,
        // R62-7：账本全书性红项计算失败随响应 warning（与 rebuildFailed 同口径——
        // 此前静默降级为「无红」，持续性失败期间漏红不可见）
        ...(rebuildFailed ? { warning: '机检索引构建失败，仅显示审稿驳回红点' } : {}),
        ...(leadsBookDegraded ? { warning: '账本全书性红项本轮计算失败，账本红点可能缺失' } : {}),
        // R65-5（十三轮）：单章机检失败随响应 warning（第三种降级形态，此前零提示）
        ...(chaptersDegraded > 0 ? { warning: `${chaptersDegraded} 个章节本轮机检失败，对应红点可能缺失` } : {}),
      }
      // R75-D-P3b：FIFO 淘汰同 health.ts（Map 保插入序，超上限丢最旧）
      if (treeIssuesCache.size >= TREE_ISSUES_CACHE_MAX) {
        const oldest = treeIssuesCache.keys().next().value
        if (oldest !== undefined) treeIssuesCache.delete(oldest)
      }
      treeIssuesCache.set(bookRoot, { payload, ts: now })
      reply(res, 200, payload)
    },
  })
}

/** R61-12（第六十一轮）：命中词正则从引号常量派生（收编单源）——此前手写字符类，
 * quotes.ts 补字符时此处漏同步即漂移（本次 ‘’ 即实测漂移点）。 */
const EXCERPT_QUOTED_RE = new RegExp(`[${QUOTE_OPEN}]([^${QUOTE_CLOSE}]{1,40})[${QUOTE_CLOSE}]`, 'g')

/**
 * B1（批 6）：从正文切命中区间 ±50 字摘录（上限 200）。
 * R64-11：导出供回归测试直接驱动（同 repairOrphanSessions 先例）。
 * 命中词取机检 message 里的引号片段（禁词/意象/复读项均带，字符集由
 * check/quotes.ts 单源派生），在正文里定位首个出现；定位不到（如字数类
 * 无具体词）回落正文开头——摘录仍可作为该章该检查的上下文语料。
 */
export function cutExcerpt(body: string, messages: string[]): string {
  const quoted: string[] = []
  for (const msg of messages) {
    for (const m of msg.matchAll(EXCERPT_QUOTED_RE)) {
      if (m[1]!) quoted.push(m[1]!)
    }
    // 堆砌类 message 形态：`眼睛×6`（词×次数）——锚点取 × 前的词
    // R64-11（十二轮）：R62-29 收编第四处——汉字段由 count.ts HANZI 单源派生
    //（基本区 + 扩展 A），硬编码 \u4e00-\u9fff 会漏生僻字人名锚点
    for (const m of msg.matchAll(new RegExp(`([${HANZI}A-Za-z0-9·]{1,20})×\\d+`, 'g'))) {
      if (m[1]!) quoted.push(m[1]!)
    }
  }
  for (const kw of quoted) {
    const idx = body.indexOf(kw)
    if (idx >= 0) {
      const start = Math.max(0, idx - 50)
      const end = Math.min(body.length, idx + kw.length + 50)
      const excerpt = body.slice(start, end)
      return excerpt.length > 200 ? excerpt.slice(0, 200) : excerpt
    }
  }
  return body.slice(0, 200)
}
