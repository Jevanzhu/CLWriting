/**
 * 机检端点 + 共享机检函数（M12 块3 B3.1，editor 组）：
 *
 * POST /api/books/:name/documents/:docId/check
 *   docId → 正文文档 → runAllChecks → CheckReport 直返（即算即显，**不落信封**）。
 *
 * runCheckForDocument（导出，三审端点 B0.2 复用）：
 *   absPath → readDraft → rebuild → runAllChecks → CheckReport（含 byproducts.leadChanges）。
 *
 * 无 AI 依赖、断网可用。流程照搬 cli/check.ts：rebuild 缓存（长篇）→ runAllChecks；
 * 账本两端闭合（declaredLeadIds/actualLeadIds）草稿目录有细纲时取，正文目录缺省安全。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { route } from '../router.js'
import { reply } from '../http.js'
import { safeManifestPath } from '../../../fs/safe-path.js'
import { readBooks } from '../../../install/books.js'
import { readManifest } from '../../../document/manifest.js'
import { readAnalysis } from '../../../document/analysis.js'
import { readBookConfig } from '../../../format/yaml.js'
import { readDraft, finalChapterFileName } from '../../../format/draft.js'
import { rebuild } from '../../../cache/rebuild.js'
import { runAllChecks, hasRed } from '../../../check/runner.js'
import { readOutlineLeads } from '../../../process/materials.js'
import { leadEvidenceMatchesBody, readChapterLeadUpdates } from '../../../process/lead-updates.js'
import { readChapterDir } from '../../../format/chapters.js'
import { deriveStatusFull } from '../../../document/status.js'
import { computeRevision } from '../../../document/revision.js'
import type { CheckReport } from '../../../check/types.js'
import type { ChapterMeta, BookConfig } from '../../../format/types.js'

interface CheckCtx {
  workDir: string | null
}

/** 机检结果：成功带 report + chapter + body（三审端点复用 chapter/body）；失败带 code（映射 HTTP 状态）。 */
export type CheckOutcome =
  | { ok: true; report: CheckReport; hasRed: boolean; chapter: ChapterMeta; body: string }
  | { ok: false; code: 'NOT_CHAPTER' | 'REBUILD_FAIL' | 'CHECK_ERROR'; error: string; details?: unknown }

/**
 * 对单个文档跑机检（absPath → CheckReport）。
 * 三审端点 B0.2 复用：buildReviewPacket 的 checkReport 输入由此产出（byproducts.leadChanges 供账本核对）。
 */
export function runCheckForDocument(bookRoot: string, absPath: string): CheckOutcome {
  const config = readBookConfig(join(bookRoot, 'book.yaml')).config
  const isShort = (config.kind ?? 'long') === 'short'
  // rebuild 条件：长篇恒走；短篇有布线才走（连续故事用账本检查）
  const hasWiring = existsSync(join(bookRoot, '布线'))

  const cachePath = join(bookRoot, '.cache', 'index.db')
  if (!isShort || hasWiring) {
    const rebuilt = rebuild(bookRoot, cachePath)
    if (rebuilt.errors.length > 0) {
      return {
        ok: false,
        code: 'REBUILD_FAIL',
        error: '源文件解析失败，先修这些文件',
        details: rebuilt.errors.slice(0, 5),
      }
    }
  }

  const db = (!isShort || hasWiring) ? new DatabaseSync(cachePath) : null
  try {
    return checkWithDb(bookRoot, absPath, db, config, isShort)
  } finally {
    if (db) db.close()
  }
}

/**
 * 扫 `写作/正文` 取全书最高已定稿章号（账本「未来章」基准，T9b 修复）。
 * 短篇无章号概念（篇号承载于 ChapterMeta.章号，但短篇不走账本检查）→ 返回 undefined。
 * 已定稿 = manifest 有 finalizedRevision（去 git：不再用 untracked 排除草稿）。
 */
function maxWrittenChapterOf(bookRoot: string, isShort: boolean): number | undefined {
  if (isShort) return undefined
  const bodyDir = join(bookRoot, '写作', '正文')
  if (!existsSync(bodyDir)) return undefined
  // 排除未定稿（无 finalizedRevision）的草稿——不算"已写"基准（防账本「未来章」检查误判）
  const manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  const finalized = new Set<string>()
  for (const e of manifest.entries.values()) {
    if (e.nodeType === 'document' && e.finalizedRevision) finalized.add(e.path)
  }
  const { chapters } = readChapterDir(bodyDir)
  let max = 0
  for (const ch of chapters) {
    if (!ch._path) continue
    const rel = relative(bookRoot, ch._path)
    if (!finalized.has(rel)) continue
    if (ch.章号 > max) max = ch.章号
  }
  return max > 0 ? max : undefined
}

/**
 * 对单文档跑机检（复用外部 db；长篇 db 必填、短篇传 null）。
 *
 * T9b 树红点聚合 rebuild 一次后循环调此（避免每章 rebuild 的 O(N²)）；
 * 机检端点经 runCheckForDocument（rebuild + 调此）间接复用。
 * readDraft / leads 组装与原 runCheckForDocument 逐字一致，机检/三审端点零感知。
 */
export function checkWithDb(
  bookRoot: string,
  absPath: string,
  db: DatabaseSync | null,
  config: BookConfig,
  isShort: boolean,
  maxWrittenChapter?: number,
): CheckOutcome {
  const draft = readDraft(absPath, isShort)
  if (!draft.ok) return { ok: false, code: 'NOT_CHAPTER', error: draft.reason }
  try {
    // 全书最高已定稿章号：调用方传入则用（树红点聚合已扫过全书，避免重复扫描）；
    // 未传（单章 check 端点）时扫描一次 写作/正文 取最大章号。
    // 用途：账本「凭空声称未来章」#1 检查的参照基准（T9b 修复）。
    const maxChapter = maxWrittenChapter ?? maxWrittenChapterOf(bookRoot, isShort)
    // 账本数据：长篇恒组装；短篇有布线才组装（连续故事用账本检查）
    const useLeads = !isShort || existsSync(join(bookRoot, '布线'))
    const declaredLeadIds = useLeads ? readOutlineLeads(bookRoot) : undefined
    const actualLeadIds = useLeads
      ? readChapterLeadUpdates(bookRoot)
          .filter((u) => leadEvidenceMatchesBody(draft.body, u.证据))
          .map((u) => u.leadId)
      : undefined
    const report: CheckReport = runAllChecks({
      ...(db ? { db } : {}),
      bookRoot,
      config,
      chapter: draft.chapter,
      body: draft.body,
      fileName: finalChapterFileName(draft.chapter, isShort),
      declaredLeadIds,
      actualLeadIds,
      maxWrittenChapter: maxChapter,
    })
    return { ok: true, report, hasRed: hasRed(report), chapter: draft.chapter, body: draft.body }
  } catch (e) {
    return { ok: false, code: 'CHECK_ERROR', error: e instanceof Error ? e.message : String(e) }
  }
}

/** CheckOutcome.code → HTTP 状态。 */
export function checkOutcomeStatus(code: 'NOT_CHAPTER' | 'REBUILD_FAIL' | 'CHECK_ERROR'): number {
  if (code === 'NOT_CHAPTER') return 400
  return 500
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
      const config = readBookConfig(join(bookRoot, 'book.yaml')).config
      const isShort = (config.kind ?? 'long') === 'short'
      const hasWiring = existsSync(join(bookRoot, '布线'))
      const cachePath = join(bookRoot, '.cache', 'index.db')
      let db: DatabaseSync | null = null
      let rebuildFailed = false
      if (!isShort || hasWiring) {
        const rebuilt = rebuild(bookRoot, cachePath)
        if (rebuilt.errors.length > 0) {
          // rebuild 失败：机检 red 强依赖 db 不可算，降级——db 留 null 循环跳过机检、只算 verdict
          // （verdict 驳回不依赖 db；单章解析失败不应连累全树 verdict 红点）
          rebuildFailed = true
        } else {
          db = new DatabaseSync(cachePath)
        }
      }
      try {
        const manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl')).entries
        const pathToDocId = new Map<string, string>()
        for (const [docId, m] of manifest) pathToDocId.set(m.path, docId)
        const issues: Record<string, { hasRed: boolean; verdictRejected: boolean }> = {}
        const bodyDir = join(bookRoot, '写作', '正文')
        if (existsSync(bodyDir)) {
          const { chapters } = readChapterDir(bodyDir)
          // 定稿态（final/published）= 作者已确认，不参与树红点聚合（根本性解决）：
          // 跳过机检 + verdict 检查；作者仍可通过 CheckPanel 单章主动查看机检。
          const entryByPath = new Map<string, import('../../../document/manifest.js').ManifestEntry>()
          for (const m of manifest.values()) entryByPath.set(m.path, m)
          // 全书最高已定稿章号：循环前扫一次，传给每章 checkWithDb 作「未来章」基准
          // （避免每章内部重复扫描的 O(N²)；T9b 修复）
          let maxChapter = 0
          for (const c of chapters) if (c.章号 > maxChapter) maxChapter = c.章号
          const maxWritten = isShort ? undefined : maxChapter > 0 ? maxChapter : undefined
          for (const ch of chapters) {
            if (!ch._path) continue
            const relPath = relative(bookRoot, ch._path)
            // 定稿态跳过——不在树上打扰已确认的章节
            const entry = entryByPath.get(relPath) ?? null
            const rev = existsSync(join(bookRoot, relPath)) ? computeRevision(join(bookRoot, relPath)) : null
            const st = deriveStatusFull(bookRoot, relPath, entry, rev)
            if (st === 'final' || st === 'published') continue
            const docId = pathToDocId.get(relPath)
            if (!docId) continue
            let hasRed = false
            if (!rebuildFailed) {
              const outcome = checkWithDb(bookRoot, ch._path, db, config, isShort, maxWritten)
              hasRed = outcome.ok ? outcome.hasRed : false
            }
            const reviewEnv = readAnalysis(bookRoot, docId, 'review')
            const verdict = (reviewEnv?.payload as { verdict?: { approved: boolean } } | undefined)?.verdict
            const verdictRejected = !!verdict && !verdict.approved
            if (hasRed || verdictRejected) issues[docId] = { hasRed, verdictRejected }
          }
        }
        reply(res, 200, {
          ok: true,
          issues,
          ...(rebuildFailed ? { warning: '机检索引构建失败，仅显示审稿驳回红点' } : {}),
        })
      } finally {
        if (db) db.close()
      }
    },
  )
}
