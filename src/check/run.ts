/**
 * 单文档机检执行（P1-8 架构下沉：从 studio/server/api/check 下沉内核）。
 *
 * 供三审端点（review.ts）、机检端点（check.ts）、树红点聚合、AI 编排层（orchestrate）共用。
 * 无 AI 依赖、断网可用。流程照搬 cli/check.ts：rebuild 缓存（长篇）→ runAllChecks；
 * 账本两端闭合（declaredLeadIds/actualLeadIds）草稿目录有细纲时取，正文目录缺省安全。
 */
import { join, relative, basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { readBookConfig } from '../format/yaml.js'
import { applyGlobalDefaults } from '../format/global-defaults.js'
import { readDraft } from '../format/draft.js'
import { rebuild } from '../cache/rebuild.js'
import { runAllChecks, hasRed } from './runner.js'
import { readOutlineLeads } from './outline-leads.js'
import { leadEvidenceMatchesBody, readChapterLeadUpdates } from './lead-updates.js'
import { readChapterDir } from '../format/chapters.js'
import { readManifest } from '../document/manifest.js'
import { deriveStatusFull } from '../document/status.js'
import { probeCachedRevision } from '../document/tree.js'
import type { CheckReport } from './types.js'
import type { ChapterMeta, BookConfig } from '../format/types.js'
import type { ChapterLeadUpdate } from './lead-updates.js'

/** 机检结果：成功带 report + chapter + body（三审端点复用 chapter/body）；失败带 code（映射 HTTP 状态）。 */
export type CheckOutcome =
  | { ok: true; report: CheckReport; hasRed: boolean; chapter: ChapterMeta; body: string }
  | { ok: false; code: 'NOT_CHAPTER' | 'REBUILD_FAIL' | 'CHECK_ERROR'; error: string; details?: unknown }

/**
 * 对单个文档跑机检（absPath → CheckReport）。
 * 三审端点 B0.2 复用：buildReviewPacket 的 checkReport 输入由此产出（byproducts.leadChanges 供账本核对）。
 */
export function runCheckForDocument(bookRoot: string, absPath: string, userDataPath?: string | null): CheckOutcome {
  // B-P2-7：检查 .ok，损坏时 warn 留诊断（config 回落 DEFAULT_CONFIG，不阻断）
  const cfgResult = readBookConfig(join(bookRoot, 'book.yaml'))
  if (!cfgResult.ok) console.warn(`[check] book.yaml 降级: ${cfgResult.error.message}`)
  // 全局托底：short.strict 等未设时回落 global.json——runner 的 promoteStrictShort
  // 读的是这里传下去的 config，服务端各入口须传 userDataPath（不传=书级直读，测试/CLI 兼容）
  const config = applyGlobalDefaults(cfgResult.config, userDataPath ?? null)
  // rebuild 条件：有布线（账本/成长线依赖 index.db）才走；无布线（独立短篇）跳过
  const hasWiring = existsSync(join(bookRoot, '布线'))

  const cachePath = join(bookRoot, '.cache', 'index.db')
  if (hasWiring) {
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

  const db = hasWiring ? new DatabaseSync(cachePath) : null
  try {
    return checkWithDb(bookRoot, absPath, db, config)
  } finally {
    if (db) db.close()
  }
}

/**
 * 扫 `写作/正文` 取全书最高已定稿章号（账本「未来章」基准，T9b 修复）。
 * 无布线不走账本检查（无全书最高章号基准需求）→ 返回 undefined。
 * 已定稿 = manifest 有 finalizedRevision（去 git：不再用 untracked 排除草稿）。
 */
function maxWrittenChapterOf(bookRoot: string): number | undefined {
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
 * 批量机检的预扫共享上下文（CC-P1-3）：树红点聚合一次扫描、逐章复用。
 * 此前三项数据每章在 checkWithDb 内现扫/现读——大书数百章时 O(N²) 文件读
 * 单请求阻塞事件循环秒级；不传则单章端点行为不变（每章现扫，语义等价）。
 */
export interface BatchCheckContext {
  /** 全书最高已定稿章号（maxWrittenChapterOf 预扫结果） */
  maxWrittenChapter?: number
  /** 大纲/章纲 章列表（targetWords 查表用；空数组 = 无章纲目录） */
  outlineChapters?: ChapterMeta[]
  /** 工作区/账本推进.md 解析结果（无文件时为空数组） */
  leadUpdates?: ChapterLeadUpdate[]
}

/**
 * 对单文档跑机检（复用外部 db；有布线 db 必填、无布线传 null）。
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
  batch?: BatchCheckContext,
): CheckOutcome {
  const draft = readDraft(absPath)
  if (!draft.ok) return { ok: false, code: 'NOT_CHAPTER', error: draft.reason }
  try {
    const hasWiring = existsSync(join(bookRoot, '布线'))
    // 全书最高已定稿章号：batch 存在即视为已预扫（树红点聚合循环外已扫过全书），
    // 直接用 batch.maxWrittenChapter——即使为 undefined（无定稿章）也是预扫的合法结果，
    // 不再回扫；未传 batch（单章 check 端点）时才扫描一次 写作/正文 取最大章号。
    // 用途：账本「凭空声称未来章」#1 检查的参照基准（T9b 修复）。
    // 优化：无布线时账本检查不运行，跳过全书扫描
    const maxChapter = hasWiring
      ? (batch ? batch.maxWrittenChapter : maxWrittenChapterOf(bookRoot))
      : batch?.maxWrittenChapter
    // 账本数据：有布线才组装（连续故事用账本检查）
    const useLeads = hasWiring
    // V-P2-14：细纲声明按被检章过滤（细纲单文件覆盖写，旧草稿复检不得对上新章声明）
    const declaredLeadIds = useLeads ? readOutlineLeads(bookRoot, draft.chapter.章号) : undefined
    const actualLeadIds = useLeads
      ? (batch?.leadUpdates ?? readChapterLeadUpdates(bookRoot))
          .filter((u) => leadEvidenceMatchesBody(draft.body, u.证据))
          .map((u) => u.leadId)
      : undefined
    // W-P2-11：word-count 黄项数据源接线——章纲（大纲/章纲/）fm 字数目标 已入 ChapterMeta，
    // 正文 ChapterMeta 无此字段（宿主写稿不产），按章号查同章章纲取 字数目标 作 targetWords。
    // 未设（无章纲 / 无 字数目标）→ undefined → 检查器 targetWords 0 → 不检也不提示（决策 C 第 3 条）。
    // CC-P1-3：批量聚合经 batch 传预扫列表；单章端点现扫（只消除批量时的每章重扫）
    const outlineDir = join(bookRoot, '大纲', '章纲')
    const outlineList =
      batch?.outlineChapters ?? (existsSync(outlineDir) ? readChapterDir(outlineDir).chapters : [])
    const targetWords = outlineList.find((c) => c.章号 === draft.chapter.章号)?.字数目标
    const report: CheckReport = runAllChecks({
      ...(db ? { db } : {}),
      bookRoot,
      config,
      chapter: draft.chapter,
      body: draft.body,
      // V-P1-5：必须用真实文件名（从章号自身合成则 fm-chapter-mismatch 恒不触发，
      // 章号≠文件名的红项在生产链路全部失效）。非数字文件名（如 前言.md）在检查器内不报红。
      fileName: basename(absPath),
      declaredLeadIds,
      actualLeadIds,
      maxWrittenChapter: maxChapter,
      targetWords,
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

/** 树红点聚合：扫正文章节，返回 { docId: { hasRed, verdictRejected } }（仅含有 issue 的 docId）。 */
export function collectTreeIssues(
  bookRoot: string,
  readReviewVerdict: (docId: string) => { approved: boolean } | undefined,
  userDataPath?: string | null,
): { issues: Record<string, { hasRed: boolean; verdictRejected: boolean }>; rebuildFailed: boolean } {
  // B-P2-7：检查 .ok，损坏时 warn 留诊断（config 回落 DEFAULT_CONFIG，不阻断）
  const cfgResult = readBookConfig(join(bookRoot, 'book.yaml'))
  if (!cfgResult.ok) console.warn(`[check] book.yaml 降级: ${cfgResult.error.message}`)
  // 全局托底：同 runCheckForDocument——树红点聚合也吃 short.strict 生效值
  const config = applyGlobalDefaults(cfgResult.config, userDataPath ?? null)
  const hasWiring = existsSync(join(bookRoot, '布线'))
  const cachePath = join(bookRoot, '.cache', 'index.db')
  let db: DatabaseSync | null = null
  let rebuildFailed = false
  if (hasWiring) {
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
      const entryByPath = new Map<string, import('../document/manifest.js').ManifestEntry>()
      for (const m of manifest.values()) entryByPath.set(m.path, m)
      // B-P1-1：统一用 maxWrittenChapterOf（仅计已定稿章），与单章 checkWithDb 端点一致。
      // 旧实现遍历所有 chapters（含未定稿草稿），导致树红点聚合与单章机检的"最高已写章号"基准不一致。
      const maxWritten = maxWrittenChapterOf(bookRoot)
      // CC-P1-3：三项预扫提升到循环外——此前每章 checkWithDb 内各现扫一遍（大纲/章纲 全量
      // readChapterDir + 工作区/账本推进 整读），大书数百章 O(N²) 文件读阻塞事件循环秒级；
      // 单请求内共享一份（章纲/账本推进只在编辑时变，跨请求由增量 rebuild/probe 缓存兜住）
      const batch: BatchCheckContext = {
        maxWrittenChapter: maxWritten,
        outlineChapters: existsSync(join(bookRoot, '大纲', '章纲'))
          ? readChapterDir(join(bookRoot, '大纲', '章纲')).chapters
          : [],
        leadUpdates: readChapterLeadUpdates(bookRoot),
      }
      for (const ch of chapters) {
        if (!ch._path) continue
        const relPath = relative(bookRoot, ch._path)
        // 定稿态跳过——不在树上打扰已确认的章节
        const entry = entryByPath.get(relPath) ?? null
        // CC-P1-3：字节指纹走 probeCache（stat 级命中零读零哈希，与树 W-P2-4 同口径），
        // 替代每章 computeRevision 整读 + SHA-256
        const rev = probeCachedRevision(bookRoot, relPath)
        const st = deriveStatusFull(bookRoot, relPath, entry, rev)
        if (st === 'final' || st === 'published') continue
        const docId = pathToDocId.get(relPath)
        if (!docId) continue
        let hasRed = false
        if (!rebuildFailed) {
          const outcome = checkWithDb(bookRoot, ch._path, db, config, batch)
          hasRed = outcome.ok ? outcome.hasRed : false
        }
        const verdict = readReviewVerdict(docId)
        const verdictRejected = !!verdict && !verdict.approved
        if (hasRed || verdictRejected) issues[docId] = { hasRed, verdictRejected }
      }
    }
    return { issues, rebuildFailed }
  } finally {
    if (db) db.close()
  }
}