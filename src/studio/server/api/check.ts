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
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { route } from '../router.js'
import { reply } from '../http.js'
import { safeManifestPath } from '../../../fs/safe-path.js'
import { readBooks } from '../../../install/books.js'
import { readManifest } from '../../../document/manifest.js'
import { readAnalysis } from '../../../document/analysis.js'
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
}

export function registerCheckRoutes(ctx: CheckCtx): void {
  route(
    'POST',
    '/api/books/:name/documents/:docId/check',
    async (_req: IncomingMessage, res: ServerResponse, params) => {
      if (!ctx.workDir) return reply(res, 400, { ok: false, code: 'NO_WORKDIR', error: '未定位到工作目录' })
      const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
      if (!entry) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `没有这本书：${params['name']}` })

      const bookRoot = join(ctx.workDir, entry.path)
      const docId = params['docId'] ?? ''
      const m = readManifest(join(bookRoot, '项目', '文档清单.jsonl')).entries.get(docId)
      if (!m) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `文档ID未登记：${docId}` })

      const absPath = safeManifestPath(bookRoot, m.path)
      if (!absPath) return reply(res, 400, { ok: false, code: 'BAD_PATH', error: '文档路径非法' })
      if (!existsSync(absPath)) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `文档不存在：${m.path}` })

      const outcome = runCheckForDocument(bookRoot, absPath)
      if (!outcome.ok) {
        return reply(res, checkOutcomeStatus(outcome.code), {
          ok: false,
          code: outcome.code,
          error: outcome.error,
          ...(outcome.details ? { details: outcome.details } : {}),
        })
      }
      reply(res, 200, { ok: true, report: outcome.report, hasRed: outcome.hasRed })
    },
  )

  // GET /tree-issues（T9b 树红点冒泡）：扫定稿正文聚合机检 red + verdict 驳回，
  // 返 { docId: { hasRed, verdictRejected } }（仅含有 issue 的 docId，余省略）。
  // rebuild 一次复用 db 循环 checkWithDb（避免每章 rebuild 的 O(N²)）；rebuild 失败降级空 issues（不阻塞树）。
  route(
    'GET',
    '/api/books/:name/tree-issues',
    async (_req: IncomingMessage, res: ServerResponse, params) => {
      if (!ctx.workDir) return reply(res, 400, { ok: false, code: 'NO_WORKDIR', error: '未定位到工作目录' })
      const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
      if (!entry) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `没有这本书：${params['name']}` })

      const bookRoot = join(ctx.workDir, entry.path)
      // 聚合逻辑已下沉内核（P1-8）：扫正文 + 机检 + verdict 驳回，返回只有 issue 的 docId
      const { issues, rebuildFailed } = collectTreeIssues(bookRoot, (docId) => {
        const reviewEnv = readAnalysis(bookRoot, docId, 'review')
        const v = (reviewEnv?.payload as { verdict?: { approved: boolean } } | undefined)?.verdict
        return v ?? undefined
      })
      reply(res, 200, {
        ok: true,
        issues,
        ...(rebuildFailed ? { warning: '机检索引构建失败，仅显示审稿驳回红点' } : {}),
      })
    },
  )
}
