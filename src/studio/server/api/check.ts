/**
 * 机检端点（M12 块3 B3.1，editor 组）：
 * POST /api/books/:name/documents/:docId/check
 *   docId → 正文文档 → runAllChecks → CheckReport 直返（即算即显，**不落信封**）。
 *
 * 无 AI 依赖、断网可用：本地规则检查（禁词/复读/句式/字数/账本/成长线/fm…）。
 * 流程照搬 cli/check.ts：rebuild 缓存（长篇）→ runAllChecks；输入换 docId（O-a
 * 直读正文区任意文档），fileName 用定稿命名规则（与 CLI 一致）。
 *
 * 账本两端闭合（declaredLeadIds/actualLeadIds）是草稿阶段专属校验，正文文档
 * 所在目录无细纲/账本推进，此处不传（缺省安全，通用项 + db 账本项照跑）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { route } from '../router.js'
import { reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readManifest } from '../../../document/manifest.js'
import { readBookConfig } from '../../../format/yaml.js'
import { readDraft, finalChapterFileName } from '../../../format/draft.js'
import { rebuild } from '../../../cache/rebuild.js'
import { runAllChecks, hasRed } from '../../../check/runner.js'
import { readOutlineLeads } from '../../../process/materials.js'
import { leadEvidenceMatchesBody, readChapterLeadUpdates } from '../../../process/lead-updates.js'
import type { CheckReport } from '../../../check/types.js'

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

      const absPath = join(bookRoot, m.path)
      if (!existsSync(absPath)) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `文档不存在：${m.path}` })

      // config + 长短篇分支（readBookConfig 失败时返回 DEFAULT_CONFIG，不致命）
      const config = readBookConfig(join(bookRoot, 'book.yaml')).config
      const isShort = (config.kind ?? 'long') === 'short'

      // 复用 readDraft：正文文档 → ChapterMeta + body（长篇 readChapter / 短篇 readPiece）
      const draft = readDraft(absPath, isShort)
      if (!draft.ok) return reply(res, 400, { ok: false, code: 'NOT_CHAPTER', error: draft.reason })

      // 长篇 rebuild 缓存（幂等；账本/成长线项强依赖 index.db）；短篇不依赖 db 跳过
      const cachePath = join(bookRoot, '.cache', 'index.db')
      if (!isShort) {
        const rebuilt = rebuild(bookRoot, cachePath)
        if (rebuilt.errors.length > 0) {
          return reply(res, 500, {
            ok: false,
            code: 'REBUILD_FAIL',
            error: '源文件解析失败，先修这些文件',
            details: rebuilt.errors.slice(0, 5),
          })
        }
      }

      const db = isShort ? null : new DatabaseSync(cachePath)
      try {
        // 账本两端闭合（长篇草稿专属）：草稿目录有细纲/账本推进时取；正文目录无则缺省
        let declaredLeadIds: string[] | undefined
        let actualLeadIds: string[] | undefined
        if (!isShort) {
          const workDir = dirname(absPath)
          declaredLeadIds = readOutlineLeads(workDir)
          actualLeadIds = readChapterLeadUpdates(workDir)
            .filter((u) => leadEvidenceMatchesBody(draft.body, u.证据))
            .map((u) => u.leadId)
        }
        const report: CheckReport = runAllChecks({
          ...(db ? { db } : {}),
          bookRoot,
          config,
          chapter: draft.chapter,
          body: draft.body,
          fileName: finalChapterFileName(draft.chapter, isShort),
          declaredLeadIds,
          actualLeadIds,
        })
        reply(res, 200, { ok: true, report, hasRed: hasRed(report) })
      } catch (e) {
        reply(res, 500, { ok: false, code: 'CHECK_ERROR', error: e instanceof Error ? e.message : String(e) })
      } finally {
        if (db) db.close()
      }
    },
  )
}
