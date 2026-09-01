/**
 * 单文档机检执行（P1-8 架构下沉：从 studio/server/api/check 下沉内核）。
 *
 * 供三审端点（review.ts）、机检端点（check.ts）、树红点聚合、AI 编排层（orchestrate）共用。
 * 无 AI 依赖、断网可用。流程照搬 cli/check.ts：rebuild 缓存（长篇）→ runAllChecks；
 * 账本两端闭合（declaredLeadIds/actualLeadIds）草稿目录有细纲时取，正文目录缺省安全。
 */
import { join, relative, basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readBookConfig } from '../format/yaml.js'
import { applyGlobalDefaults } from '../format/global-defaults.js'
import { readDraft } from '../format/draft.js'
import { rebuild } from '../cache/rebuild.js'
import { runAllChecks, hasRed, enabledLeadTypes } from './runner.js'
import { outlineDeclarationForChapter } from './outline-leads.js'
import {
  leadEvidenceMatchesBody,
  readChapterUpdatesForChapterChecked,
  readLeadUpdatesAt,
  readLeadUpdateChapterTag,
  LEAD_UPDATES_FILE,
  LEAD_UPDATES_ARCHIVE_DIR,
} from './lead-updates.js'
import { readChapterDir } from '../format/chapters.js'
import { readManifest } from '../document/manifest.js'
import { deriveStatus } from '../document/status.js'
import { probeCachedRevision, probeCachedPublished } from '../document/tree.js'
import { existingAnalysisPath } from '../document/analysis.js'
import { syncTreeIssuesEpoch, readTreeIssuesCache, writeTreeIssuesCache, computeLeadsBookFp, readLeadsBookRed, writeLeadsBookRed, computeTreeIssuesGlobalFp } from './tree-issues-cache.js'
import { checkLeadsBookItems } from './leads.js'
import type { CheckReport } from './types.js'
import type { ChapterMeta, BookConfig } from '../format/types.js'
import type { ChapterLeadUpdate } from './lead-updates.js'
import { log } from '../log/index.js'

/** 机检结果：成功带 report + chapter + body（三审端点复用 chapter/body）；失败带 code（映射 HTTP 状态）。 */
export type CheckOutcome =
  | { ok: true; report: CheckReport; hasRed: boolean; chapter: ChapterMeta; body: string }
  | { ok: false; code: 'NOT_CHAPTER' | 'REBUILD_FAIL' | 'CHECK_ERROR'; error: string; details?: unknown }

/**
 * 对单个文档跑机检（absPath → CheckReport）。
 * 三审端点 B0.2 复用：buildReviewPacket 的 checkReport 输入由此产出（byproducts.leadChanges 供账本核对）。
 * R63-7（十一轮）：opts.draftText 传入时按预读文本解析草稿（不读文件）——三审端点
 * 单次读取取 buffer，sourceHash/draftHash/机检 body 三源同拍（三次独立读会来自三个时刻，
 * 机检窗口内保存 → hash 无任何单一文件状态与之对应）。
 */
export function runCheckForDocument(
  bookRoot: string,
  absPath: string,
  userDataPath?: string | null,
  opts?: { draftText?: string },
): CheckOutcome {
  // B-P2-7：检查 .ok，损坏时 warn 留诊断（config 回落 DEFAULT_CONFIG，不阻断）
  const cfgResult = readBookConfig(join(bookRoot, 'book.yaml'))
  if (!cfgResult.ok) log.warn('check', `book.yaml 降级: ${cfgResult.error.message}`)
  // 全局托底：short.strict 等未设时回落 global.json——runner 的 promoteStrictShort
  // 读的是这里传下去的 config，服务端各入口须传 userDataPath（不传=书级直读，测试/CLI 兼容）
  const config = applyGlobalDefaults(cfgResult.config, userDataPath ?? null)
  // rebuild 条件：有布线（账本/成长线依赖 index.db）才走；无布线（独立短篇）跳过
  const hasWiring = existsSync(join(bookRoot, '布线'))

  const cachePath = join(bookRoot, '.cache', 'index.db')
  let db: DatabaseSync | null = null
  if (hasWiring) {
    // M-9（2026-08-21）：rebuild/开库硬异常归 REBUILD_FAIL 出口（此前穿透成 500 裸异常，
    // 端点契约本就为这类失败预留了 code）
    try {
      const rebuilt = rebuild(bookRoot, cachePath)
      if (rebuilt.errors.length > 0) {
        return {
          ok: false,
          code: 'REBUILD_FAIL',
          error: '源文件解析失败，先修这些文件',
          details: rebuilt.errors.slice(0, 5),
        }
      }
      db = new DatabaseSync(cachePath)
    } catch (e) {
      return {
        ok: false,
        code: 'REBUILD_FAIL',
        error: `缓存库不可用：${e instanceof Error ? e.message : String(e)}`,
      }
    }
  }
  try {
    // 内存闸（2026-08-24 审计 C4）：PRAGMA 段并入大 try——此前在开库 try/catch 内，
    // exec 抛错（库损坏/锁超时）走 catch 直接 return，db 已开未关（泄漏句柄 + WAL）；
    // 并入后由本层 finally 收口 close（对照同文件 collectTreeIssues 的大 finally 口径），
    // REBUILD_FAIL 契约不变
    if (db) {
      try {
        // 与 rebuild 同款：并发下（树红点聚合 + rebuild 同跑）等锁 5s 而非立即 SQLITE_BUSY
        db.exec('PRAGMA busy_timeout = 5000')
      } catch (e) {
        return {
          ok: false,
          code: 'REBUILD_FAIL',
          error: `缓存库不可用：${e instanceof Error ? e.message : String(e)}`,
        }
      }
    }
    return checkWithDb(bookRoot, absPath, db, config, undefined, { draftText: opts?.draftText })
  } finally {
    if (db) db.close()
  }
}

/**
 * 扫 `写作/正文` 取全书最高已定稿章号（账本「未来章」基准，T9b 修复）。
 * 无布线不走账本检查（无全书最高章号基准需求）→ 返回 undefined。
 * 已定稿 = manifest 有 finalizedRevision（去 git：不再用 untracked 排除草稿）。
 */
function maxWrittenChapterOf(bookRoot: string, preScanned?: ChapterMeta[]): number | undefined {
  const bodyDir = join(bookRoot, '写作', '正文')
  // P5-管线（第七轮）：接受调用方预扫的正文章列表（批量路径 bodyChapters 一扫两用），
  // 原先内部再 readChapterDir 一遍 = 全书正文双遍扫描
  const chapters = preScanned ?? (existsSync(bodyDir) ? readChapterDir(bodyDir).chapters : [])
  if (chapters.length === 0) return undefined
  // 排除未定稿（无 finalizedRevision）的草稿——不算"已写"基准（防账本「未来章」检查误判）
  const manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  const finalized = new Set<string>()
  for (const e of manifest.entries.values()) {
    if (e.nodeType === 'document' && e.finalizedRevision) finalized.add(e.path)
  }
  let max = 0
  for (const ch of chapters) {
    if (!ch._path) continue
    // M-4（第六轮）：relative() 在 Windows 产反斜杠而 manifest 键是正斜杠——不归一
    // 全部章误判未定稿（同款已修：export/index.ts RB-KN-P2-3、state.ts relativePath）
    const rel = relative(bookRoot, ch._path).replace(/\\/g, '/')
    if (!finalized.has(rel)) continue
    if (ch.章号 > max) max = ch.章号
  }
  if (max > 0) return max
  // R69-17（十七轮）：零定稿书回退全书最高现存章号——与树聚合（collectTreeIssues
  // maxWritten ?? maxExisting）同口径；此前返回 undefined 让单章侧回落被检章自身
  // 章号，复检低章时同一履历行「树不红、单章面板红」口径分裂。
  const maxExisting = chapters.reduce((m, c) => Math.max(m, c.章号), 0)
  return maxExisting > 0 ? maxExisting : undefined
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
  /** R65-24（十三轮）：每章账本推进预扫（主文件 + 归档暂存两源一次读齐，闭包按章
   *  还原 readChapterUpdatesForChapter 拼装口径）；不传则单章路径现读（语义等价） */
  leadUpdatesForChapter?: (chapterNo: number) => ChapterLeadUpdate[]
}

/**
 * R65-24（十三轮）：批量路径的账本推进预扫——主文件标签 + 正文一次读、.账本推进暂存/
 * 第N章.md 目录一次扫，返回按章取数的闭包（与逐章调 readChapterUpdatesForChapter 逐条
 * 等价：无标签主文件对每章生效、带章标签主文件只对本章生效、归档按章名配对）。
 * 单文件读失败按空降级（readLeadUpdatesAt 的 X-P2-5 口径，不阻断批量机检）。
 */
function scanChapterUpdatesByChapter(bookRoot: string): (chapterNo: number) => ChapterLeadUpdate[] {
  const mainPath = join(bookRoot, LEAD_UPDATES_FILE)
  const mainTag = readLeadUpdateChapterTag(mainPath) // 无文件/读失败 → null（宽容口径）
  const mainUpdates = readLeadUpdatesAt(mainPath)
  const archiveByChapter = new Map<number, ChapterLeadUpdate[]>()
  const archiveDir = join(bookRoot, LEAD_UPDATES_ARCHIVE_DIR)
  if (existsSync(archiveDir)) {
    for (const f of readdirSync(archiveDir)) {
      const m = f.match(/^第(\d+)章\.md$/)
      if (!m) continue // 非本章归档命名（含 ._ 资源文件）不入预扫
      archiveByChapter.set(Number(m[1]), readLeadUpdatesAt(join(archiveDir, f)))
    }
  }
  return (chapterNo: number): ChapterLeadUpdate[] => [
    ...(mainTag === null || mainTag === chapterNo ? mainUpdates : []),
    ...(archiveByChapter.get(chapterNo) ?? []),
  ]
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
  opts?: { skipLeadsBookChecks?: boolean; draftText?: string },
): CheckOutcome {
  // R63-7：draftText（预读快照）传入时按它解析，不读文件——见 runCheckForDocument 头注
  const draft = readDraft(absPath, opts?.draftText)
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
    // R69-2（十七轮）：声明侧三态——细纲自带章号 ≠ 被检章 = 声明未知（批量连写常态：
    // 细纲@首章、其余章推进落归档），此时 declaredLeadIds 传 undefined 跳过两端闭合，
    // 不再把「未知」当「未声明」误报 lead-done-not-declared（曾硬阻断批量定稿闸）。
    const declaration = useLeads ? outlineDeclarationForChapter(bookRoot, draft.chapter.章号) : undefined
    const declaredLeadIds = declaration?.known ? declaration.leads : undefined
    // R61-14（第六十一轮）：实际侧同口径按被检章过滤（V-P2-14 声明侧同向）——
    // 他章证据不作本章「已兑现」参照。
    // R65-24（十三轮）：actual 侧改走 readChapterUpdatesForChapter 单源（主文件（属于
    // 本章时）+ 工作区/.账本推进暂存/第N章.md，内含 in-scope 判定）——此前只读主文件：
    // 批量连写书的归档章推进被无视，误报 lead-declared-not-done 红（定稿闸与履历回写
    // 自 ff-P1-1 已统一本函数，机检是最后缺口）。batch 预扫闭包同口径（CC-P1-3 消每章重读）
    // R33-5（三十三轮）：兑现侧读失败 ≠ 未兑现——actualLeadIds 传 undefined 跳过两端
    // 闭合（对齐声明侧 R69-2 known:false 口径；读失败按空曾产假红硬拦定稿）。
    const batchUpdates = batch?.leadUpdatesForChapter?.(draft.chapter.章号)
    const actualRead =
      batchUpdates !== undefined
        ? ({ ok: true as const, updates: batchUpdates } as const)
        : readChapterUpdatesForChapterChecked(bookRoot, draft.chapter.章号)
    const actualLeadIds = useLeads
      ? actualRead.ok
        ? actualRead.updates.filter((u) => leadEvidenceMatchesBody(draft.body, u.证据)).map((u) => u.leadId)
        : undefined
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
      skipLeadsBookChecks: opts?.skipLeadsBookChecks === true,
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

/** R62-7 测试注入：强制账本全书性红项计算抛错——验证 leadsBookDegraded 透出路径
 *  （真实损坏多被 readLeadsBookRed 自愈吞掉,难确定性触发）。生产恒 false。 */
let __leadsBookDegradeForTest = false
export function __setLeadsBookDegradeForTest(v: boolean): void {
  __leadsBookDegradeForTest = v
}

/** R65-5（十三轮）测试注入：强制章级机检失败——验证 chaptersDegraded 透出路径
 *  （真实失败多为瞬态竞态/名册 ENOENT，难确定性触发）。生产恒 false。 */
let __chapterCheckDegradeForTest = false
export function __setChapterCheckDegradeForTest(v: boolean): void {
  __chapterCheckDegradeForTest = v
}

/** 树红点聚合：扫正文章节，返回 { docId: { hasRed, verdictRejected } }（仅含有 issue 的 docId）。 */
export function collectTreeIssues(
  bookRoot: string,
  readReviewVerdict: (docId: string) => { approved: boolean } | undefined,
  userDataPath?: string | null,
): { issues: Record<string, { hasRed: boolean; verdictRejected: boolean }>; rebuildFailed: boolean; leadsBookDegraded: boolean; chaptersDegraded: number } {
  // B-P2-7：检查 .ok，损坏时 warn 留诊断（config 回落 DEFAULT_CONFIG，不阻断）
  const cfgResult = readBookConfig(join(bookRoot, 'book.yaml'))
  if (!cfgResult.ok) log.warn('check', `book.yaml 降级: ${cfgResult.error.message}`)
  // 全局托底：同 runCheckForDocument——树红点聚合也吃 short.strict 生效值
  const config = applyGlobalDefaults(cfgResult.config, userDataPath ?? null)
  const hasWiring = existsSync(join(bookRoot, '布线'))
  const cachePath = join(bookRoot, '.cache', 'index.db')
  let db: DatabaseSync | null = null
  let rebuildFailed = false
  // R65-5（十三轮）：单章机检失败章计数（透出 warning，见下方 checkFailed 分支）
  let chaptersDegraded = 0
  if (hasWiring) {
    // M-9（2026-08-21）：rebuild / 开库 / PRAGMA 的硬异常按 fail-open 降级（warn + 留痕），
    // 不再穿透成 500——与缓存层头注释「读写失败跳过缓存走全量路径」红线对齐。此前只有
    // 「rebuild 报错列表非空」这一种失败形态走了降级，库损坏/锁超时直接把树红点端点打挂。
    try {
      const rebuilt = rebuild(bookRoot, cachePath)
      if (rebuilt.errors.length > 0) {
        // rebuild 失败：机检 red 强依赖 db 不可算，降级——db 留 null 循环跳过机检、只算 verdict
        // （verdict 驳回不依赖 db；单章解析失败不应连累全树 verdict 红点）
        rebuildFailed = true
      } else {
        db = new DatabaseSync(cachePath)
        // 同 runCheckForDocument：树红点聚合与机检端点/rebuild 可并发，等锁而非 SQLITE_BUSY
        db.exec('PRAGMA busy_timeout = 5000')
      }
    } catch (e) {
      rebuildFailed = true
      log.warn('check', `树红点聚合降级（rebuild/开库失败，只算 verdict）：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  try {
    const manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl')).entries
    const pathToDocId = new Map<string, string>()
    for (const [docId, m] of manifest) pathToDocId.set(m.path, docId)
    const issues: Record<string, { hasRed: boolean; verdictRejected: boolean }> = {}
    const bodyDir = join(bookRoot, '写作', '正文')
    // A1（批 1）：增量缓存——只重查指纹变过的章。仅对有布线的书启用（长篇才是
    // 数百章规模；短篇不开 .cache/index.db，行为与从前完全一致）。表缺席/纪元
    // 同步失败 → cacheEnabled=false 走现行全量路径（语义无损降级）。
    let cacheEnabled = false
    // R70-14（十八轮）：纪元 fp 写前复核基线——fp 在聚合开头计算、行写入在其后，
    // 外部编辑器/第二进程恰在窗口内改纪元输入时旧行按新输入视角陈旧落表（单请求
    // 周期陈旧、下一聚合自愈，但该周期红点错）。写入前复核 fp 未变才落缓存。
    let epochFp0: string | null = null
    if (db) {
      try {
        syncTreeIssuesEpoch(db, bookRoot, userDataPath ?? null)
        epochFp0 = computeTreeIssuesGlobalFp(bookRoot, userDataPath ?? null)
        cacheEnabled = true
      } catch {
        cacheEnabled = false
      }
    }
    // H-1（2026-08-21）：账本全书性红项（章号一致/引文命中/状态闭合）——本书一次计算，
    // 按「纪元 + 正文目录指纹」独立缓存（tree_issues_meta leads_book_*），不进章级行。
    // 此前它们进每章 report 的 hasRed，却只按本章 stat 失效：改第 N 章正文补/删引文后
    // 其余章缓存红点陈旧（假红残留或漏红）。指纹含正文目录摘要——改任何一章都会重算
    // 这一项（正确性所需），章级行的增量性不受拖累。计算失败 fail-open：不落缓存、
    // 本轮按无红处理（下轮重试），不拦树。
    // 全书最高已定稿章号：一次预扫两处共用——leads 全书性红项的未来章基准 + 章循环
    // batch（H-1 新增消费方；不共用会把 readChapterDir 调用次数抬高回去，CC-P1-3 的
    // 调用次数回归锚会红）。P5-管线（第七轮）：bodyChapters 列表直接传入
    // maxWrittenChapterOf——原实现内部重扫一遍正文（「一次预扫」注释与实现漂移）
    const bodyChapters = existsSync(bodyDir) ? readChapterDir(bodyDir).chapters : []
    const maxWritten = maxWrittenChapterOf(bookRoot, bodyChapters)
    let leadsBookRed = false
    // R62-7：账本全书性红项计算失败的可视标志——此前静默降级为「无红」，持续性失败
    // 期间全树永不显示账本红项且响应无 warning（fail-open 方向是漏红，与 rebuildFailed
    // 处理不对称）；随响应透出让前端留痕
    let leadsBookDegraded = false
    if (db && !rebuildFailed) {
      try {
        if (__leadsBookDegradeForTest) throw new Error('R62-7 注入：账本全书性红项读取失败')
        const leadsFp = computeLeadsBookFp(bookRoot, userDataPath ?? null)
        const cachedRed = readLeadsBookRed(db, leadsFp)
        if (cachedRed !== null) {
          leadsBookRed = cachedRed
        } else {
          // 第五轮：零定稿章（新书/清单损坏）时 maxWritten 为 null——回退全书最高现存
          // 章号，与单章侧 futureBaselineChapter ?? chapter.章号 同向；此前 ?? 0 会把
          // 新书预写的全部非回填履历报 lead-chapter-future（聚合全树红 vs 单章面板
          // 无红的口径分裂，首轮定稿后才自愈）
          const maxExisting = bodyChapters.reduce((m, c) => Math.max(m, c.章号), 0)
          leadsBookRed = checkLeadsBookItems(db, bookRoot, maxWritten ?? maxExisting, enabledLeadTypes(config)).some(
            (i) => i.level === 'red',
          )
          writeLeadsBookRed(db, leadsFp, leadsBookRed)
        }
      } catch (e) {
        leadsBookDegraded = true
        log.warn('check', `账本全书性红项计算失败（本轮降级为无，不落缓存）：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (existsSync(bodyDir)) {
      const chapters = bodyChapters
      // 定稿态（final/published）= 作者已确认，不参与树红点聚合（根本性解决）：
      // 跳过机检 + verdict 检查；作者仍可通过 CheckPanel 单章主动查看机检。
      const entryByPath = new Map<string, import('../document/manifest.js').ManifestEntry>()
      for (const m of manifest.values()) entryByPath.set(m.path, m)
      // B-P1-1：统一用 maxWrittenChapterOf（仅计已定稿章），与单章 checkWithDb 端点一致。
      // 旧实现遍历所有 chapters（含未定稿草稿），导致树红点聚合与单章机检的"最高已写章号"基准不一致。
      // CC-P1-3：三项预扫提升到循环外——此前每章 checkWithDb 内各现扫一遍（大纲/章纲 全量
      // readChapterDir + 工作区/账本推进 整读），大书数百章 O(N²) 文件读阻塞事件循环秒级；
      // 单请求内共享一份（章纲/账本推进只在编辑时变，跨请求由增量 rebuild/probe 缓存兜住）
      const batch: BatchCheckContext = {
        maxWrittenChapter: maxWritten,
        outlineChapters: existsSync(join(bookRoot, '大纲', '章纲'))
          ? readChapterDir(join(bookRoot, '大纲', '章纲')).chapters
          : [],
        // R65-24：批量预扫同口径走「主文件 + 归档暂存」两源（此前 readChapterLeadUpdates
        // 只读主文件——归档章实际侧失明，与单章端点统一后此处一并统一）
        leadUpdatesForChapter: scanChapterUpdatesByChapter(bookRoot),
      }
      // R71-20：写前纪元复核改轮内缓存——原实现每 miss 章重算一次 computeTreeIssuesGlobalFp
      // （递归 readdir+stat 全输入树），任一全局输入变动清表后全书 miss，数百章书一次聚合
      // 数百次全树遍历（同步路径性能回退）。循环前算一次比较即可：语义为「本轮聚合窗口内
      // 纪元与轮首一致才落缓存」——与逐章复核等价且口径更严（原实现窗口内漂移反而引入
      // 前后章判定不一致的误判空间）。epochFp0 为 null（纪元同步失败、缓存禁用）时不算。
      const epochFpNow = epochFp0 === null ? null : computeTreeIssuesGlobalFp(bookRoot, userDataPath ?? null)
      for (const ch of chapters) {
        if (!ch._path) continue
        // M-4（第六轮）：同上归一——entryByPath/pathToDocId 的键与 manifest/树同用正斜杠
        const relPath = relative(bookRoot, ch._path).replace(/\\/g, '/')
        // 定稿态跳过——不在树上打扰已确认的章节
        const entry = entryByPath.get(relPath) ?? null
        // CC-P1-3：字节指纹走 probeCache（stat 级命中零读零哈希，与树 W-P2-4 同口径），
        // 替代每章 computeRevision 整读 + SHA-256
        const rev = probeCachedRevision(bookRoot, relPath)
        // #6（中级遗留）：published 判定同样走 probeCache——此前 deriveStatusFull →
        // readPublished 对 final 章整读定稿稿且不吃缓存，成熟书 O(final 章数) 整读/请求，
        // 削弱 A1 收益。probe 的 published 与树视图同口径（W-P2-4 单次读探针）
        const base = deriveStatus(relPath, entry, rev)
        const st = base === 'final' && probeCachedPublished(bookRoot, relPath) ? 'published' : base
        if (st === 'final' || st === 'published') continue
        const docId = pathToDocId.get(relPath)
        if (!docId) continue
        // A1（批 1）：章级指纹 = 正文 stat + 裁决信封 stat（信封改动=verdict 变，
        // 自动失效；无信封=verdict_fp NULL）。全中 → 直接取缓存聚合，零机检零重读。
        let chapterSt: { mtimeMs: number; size: number }
        try {
          chapterSt = statSync(ch._path)
        } catch {
          continue // 竞态消失（回收站/删除）：本条跳过
        }
        const envAbs = existingAnalysisPath(bookRoot, docId) // R68-3：双候选读侧定位（信封 stat 指纹不吃单候选分裂）
        let verdictFp: string | null = null
        if (envAbs) {
          try {
            const es = statSync(envAbs)
            verdictFp = `${es.mtimeMs}:${es.size}`
          } catch {
            verdictFp = null // 信封竞态消失：按无信封处理
          }
        }
        if (cacheEnabled && db) {
          const cached = readTreeIssuesCache(db, relPath, chapterSt.mtimeMs, chapterSt.size, verdictFp)
          if (cached) {
            // 章级行只存章作用域 hasRed（H-1 拆分后），全书性红项在此合并展示
            const mergedRed = cached.hasRed || leadsBookRed
            if (mergedRed || cached.verdictRejected) {
              issues[docId] = { hasRed: mergedRed, verdictRejected: cached.verdictRejected }
            }
            continue
          }
        }
        let hasRed = false
        let checkFailed = false
        if (!rebuildFailed) {
          // H-1：树红点聚合的章级检查跳过账本全书性条目（独立缓存见上），章级行因此
          // 只依赖「本章 stat + 纪元」，跨章陈旧窗口消除
          const outcome = __chapterCheckDegradeForTest
            ? ({ ok: false } as const)
            : checkWithDb(bookRoot, ch._path, db, config, batch, { skipLeadsBookChecks: true })
          if (outcome.ok) hasRed = outcome.hasRed
          else checkFailed = true
        }
        // R65-5（十三轮）：单章机检失败计数透出——与 R62-7 的 leadsBookDegraded 同口径，
        // 此前 checkFailed 只影响「不落缓存」，持续性失败（名册竞态/账本损坏）期间该章
        // 红点缺失且响应零提示（fail-open 漏红不可见）
        if (checkFailed) {
          chaptersDegraded++
          log.warn('check', `章机检失败（红点可能缺失）：${relPath}`)
        }
        const verdict = readReviewVerdict(docId)
        const verdictRejected = !!verdict && !verdict.approved
        // 检查失败（瞬态异常：SQLITE_BUSY 超时/名册 ENOENT 竞态）不落缓存——此前无条件
        // writeTreeIssuesCache 会把「未检出」固化为假阴性，指纹不变期间红点永久消失、
        // 后续请求直命中坏缓存；不写则下轮重试。verdict 与缓存互不连带。
        // 注意写入的是章作用域 hasRed（不含 leadsBookRed），合并只在展示层发生。
        // R70-14：窗口内纪元变了则本轮不落缓存（下轮重算）。R71-20：比较用轮内缓存值
        const epochStable = epochFp0 !== null && epochFpNow === epochFp0
        if (!checkFailed && cacheEnabled && db && epochStable) writeTreeIssuesCache(db, relPath, chapterSt.mtimeMs, chapterSt.size, verdictFp, { hasRed, verdictRejected })
        const mergedRed = hasRed || leadsBookRed
        if (mergedRed || verdictRejected) issues[docId] = { hasRed: mergedRed, verdictRejected }
      }
    }
    return { issues, rebuildFailed, leadsBookDegraded, chaptersDegraded }
  } finally {
    if (db) db.close()
  }
}