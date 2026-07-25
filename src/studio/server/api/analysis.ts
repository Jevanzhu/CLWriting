/**
 * 分析信封读取端点（M12 B0.2/B4，editor 组）：
 * GET /api/books/:name/documents/:docId/analysis/:kind
 *   → 读 项目/分析/<docId>.json 中该 kind 的信封 + stale 标志（正文变更 → 过期）。
 *
 * 无 AI 依赖；前端打开文档时读存量信封展示（三审意见 / 体验分 / 情绪曲线 …）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { route } from '../router.js'
import { reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readManifest } from '../../../document/manifest.js'
import { readAnalysis, isStale, type AnalysisKind } from '../../../document/analysis.js'

interface AnalysisCtx {
  workDir: string | null
}

export function registerAnalysisRoutes(ctx: AnalysisCtx): void {
  route(
    'GET',
    '/api/books/:name/documents/:docId/analysis/:kind',
    (_req: IncomingMessage, res: ServerResponse, params) => {
      if (!ctx.workDir) return reply(res, 400, { ok: false, code: 'NO_WORKDIR', error: '未定位到工作目录' })
      const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
      if (!entry) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `没有这本书：${params['name']}` })
      const bookRoot = join(ctx.workDir, entry.path)
      const docId = params['docId'] ?? ''
      const kind = (params['kind'] ?? '') as AnalysisKind
      const m = readManifest(join(bookRoot, '项目', '文档清单.jsonl')).entries.get(docId)
      if (!m) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `文档ID未登记：${docId}` })

      const env = readAnalysis(bookRoot, docId, kind)
      if (!env) return reply(res, 404, { ok: false, code: 'NO_ENVELOPE', error: '无存量分析' })

      // stale：当前正文 hash 与信封 sourceHash 不符 → 过期
      const absPath = join(bookRoot, m.path)
      let stale = false
      if (existsSync(absPath)) {
        try {
          stale = isStale(env, readFileSync(absPath, 'utf-8'))
        } catch {
          stale = true
        }
      }
      reply(res, 200, { ok: true, envelope: env, stale })
    },
  )
}
