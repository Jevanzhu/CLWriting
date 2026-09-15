/**
 * 单文档机检执行（P1-8 架构下沉：从 studio/server/api/check 下沉内核）。
 *
 * 供三审端点（review.ts）、机检端点（check.ts）、树红点聚合、AI 编排层（orchestrate）共用。
 * 无 AI 依赖、断网可用。流程照搬 cli/check.ts：rebuild 缓存（长篇）→ runAllChecks；
 * 账本两端闭合（declaredLeadIds/actualLeadIds）草稿目录有细纲时取，正文目录缺省安全。
 *
 * R0916-5f（2026-09-16，⑤④产品巨件拆分波2 · 缝 A）：树红点聚合族（TREE_ISSUES_
 * YIELD_EVERY/TreeIssuesResult/collectTreeIssues/collectTreeIssuesAsync/
 * collectTreeIssuesCore/__setLeadsBookDegradeForTest/__setChapterCheckDegradeForTest）
 * 纯移动拆出至 run-tree-issues.ts（零行为变化），本文件残核 = 单章机检链 + 批量预扫
 *（readCheckConfig/openCheckDb/pushDegradedYellow/runCheckForDocument/checkWithDb/
 * checkOutcomeStatus/maxWrittenChapterOf/BatchCheckContext/scanChapterUpdatesByChapter）；
 * 其中 readCheckConfig/openCheckDb/maxWrittenChapterOf/scanChapterUpdatesByChapter 自
 * 本批起 export（原模块私有，升 export 供拆出件复用，见 run-tree-issues.ts 头注）。
 * 树红点聚合族既有导出由下方具名 re-export 桥接，全库 'check/run.js' import 面零改动。
 */
import { join, relative, basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync } from 'node:fs'
import { readBookConfig } from '../format/yaml.js'
import { applyGlobalDefaults } from '../format/global-defaults.js'
import { readDraft } from '../format/draft.js'
import { rebuild } from '../cache/rebuild.js'
import { runAllChecks, hasRed, effectiveShort, promoteStrictShort } from './runner.js'
import { outlineDeclarationForChapter, type OutlineDeclaration } from './outline-leads.js'
import {
  leadEvidenceMatchesBody,
  readChapterUpdatesForChapterChecked,
  readLeadUpdatesAtChecked,
  readLeadUpdateChapterTag,
  type ChapterUpdatesResult,
  LEAD_UPDATES_FILE,
  LEAD_UPDATES_ARCHIVE_DIR,
} from './lead-updates.js'
import { readChapterDir } from '../format/chapters.js'
import { readManifest, type ManifestEntry } from '../document/manifest.js'
import { docJoinKey, normalizeWinSeparators } from '../fs/safe-path.js'
import type { CheckReport, CheckItem } from './types.js'
import type { ChapterMeta, BookConfig } from '../format/types.js'
import { log, errMsg } from '../log/index.js'

// R0916-5f（2026-09-16，⑤④产品拆分波2 · 缝 A）：树红点聚合族已纯移动拆出至
// run-tree-issues.ts——逐名 re-export 桥接，既有 'check/run.js' import 方零感知
//（与 studio/server/api/check.ts 的 P1-8 下沉兼容桥同款）。
export {
  collectTreeIssues,
  collectTreeIssuesAsync,
  __setLeadsBookDegradeForTest,
  __setChapterCheckDegradeForTest,
} from './run-tree-issues.js'

/** 机检结果：成功带 report + chapter + body（三审端点复用 chapter/body）；失败带 code（映射 HTTP 状态）。 */
export type CheckOutcome =
  | { ok: true; report: CheckReport; hasRed: boolean; chapter: ChapterMeta; body: string }
  | { ok: false; code: 'NOT_CHAPTER' | 'REBUILD_FAIL' | 'CHECK_ERROR'; error: string; details?: unknown }

/**
 * P3（复审-0914-优化修复批）：单章端点（runCheckForDocument）与树聚合
 * （collectTreeIssuesCore）共用的「读配置→托底」前奏——B-P2-7 的 .ok 检查 + warn 与
 * applyGlobalDefaults 托底两处逐字同构。degradedError 供单章侧 R29-5 黄项用原文
 * （树聚合黄项无处落，只吃 warn——见 collectTreeIssuesCore 注）。
 */
export function readCheckConfig(
  bookRoot: string,
  userDataPath: string | null,
): { config: BookConfig; degradedError: string | null } {
  // B-P2-7：检查 .ok，损坏时 warn 留诊断（config 回落 DEFAULT_CONFIG，不阻断）
  const cfgResult = readBookConfig(join(bookRoot, 'book.yaml'))
  if (!cfgResult.ok) log.warn('check', `book.yaml 降级: ${cfgResult.error.message}`)
  // 全局托底：short.strict 等未设时回落 global.json——runner 的 promoteStrictShort
  // 读的是这里传下去的 config，服务端各入口须传 userDataPath（不传=书级直读，测试/CLI 兼容）
  return {
    config: applyGlobalDefaults(cfgResult.config, userDataPath),
    degradedError: cfgResult.ok ? null : cfgResult.error.message,
  }
}

/**
 * P3（复审-0914-优化修复批）：「rebuild→开库→PRAGMA」前奏参数化——单章端点与树聚合
 * 两处逐字同构（~35 行），仅两轴不同，作参数收编：
 * - throttleSourceProbe：单章链 R47-11 的增量探测 3s TTL 节流 opt-in（连查/轮询去抖），
 *   树聚合 rebuild 不节流（rebuild.ts 节流块注口径）。
 * - failMode：'envelope'（单章 M-9（2026-08-21）：硬异常归 REBUILD_FAIL 信封出端点，
 *   此前穿透成 500 裸异常）/ 'fail-open'（树聚合 M-9 同批降级：warn 留痕 +
 *   rebuildFailed=true，只算 verdict 不拦树——与缓存层「读写失败跳过缓存走全量」红线
 *   对齐）。PRAGMA 并入同一失败链（2026-08-24 审计 C4 口径：exec 抛错即关库不留句柄，
 *   单章侧契约不变、树聚合侧由调用方 finally 收口）。
 */
export function openCheckDb(
  bookRoot: string,
  hasWiring: boolean,
  opts: { throttleSourceProbe: boolean; failMode: 'envelope' | 'fail-open' },
): { db: DatabaseSync | null; rebuildFailed: boolean; fail?: { error: string; details?: unknown } } {
  // rebuild 条件：有布线（账本/成长线依赖 index.db）才走；无布线（独立短篇）跳过
  if (!hasWiring) return { db: null, rebuildFailed: false }
  const cachePath = join(bookRoot, '.cache', 'index.db')
  const failOpen = (message: string): { db: null; rebuildFailed: true } => {
    log.warn('check', message)
    return { db: null, rebuildFailed: true }
  }
  try {
    // R47-11（四十七轮）：单章机检链的增量探测 opt-in 3s TTL 节流——四棵源树逐文件
    // readdir+stat 在 SMB/网盘卷上单遍秒级，连查/轮询按请求次数放大；取舍与口径见
    // rebuild.ts 节流块注（树聚合 collectTreeIssuesCore 的 rebuild 不节流，见函数头注）
    const rebuilt = rebuild(bookRoot, cachePath, opts.throttleSourceProbe ? { throttleSourceProbe: true } : undefined)
    if (rebuilt.errors.length > 0) {
      if (opts.failMode === 'envelope') {
        return {
          db: null,
          rebuildFailed: false,
          fail: { error: '源文件解析失败，先修这些文件', details: rebuilt.errors.slice(0, 5) },
        }
      }
      // rebuild 失败：机检 red 强依赖 db 不可算，降级——db 留 null 循环跳过机检、只算 verdict
      //（verdict 驳回不依赖 db；单章解析失败不应连累全树 verdict 红点）
      return { db: null, rebuildFailed: true }
    }
    const db = new DatabaseSync(cachePath)
    try {
      // 与 rebuild 同款：并发下（树红点聚合 + rebuild 同跑）等锁 5s 而非立即 SQLITE_BUSY
      db.exec('PRAGMA busy_timeout = 5000')
      return { db, rebuildFailed: false }
    } catch (e) {
      db.close() // 审计 C4：PRAGMA 抛错（库损坏/锁超时）不留已开句柄
      return opts.failMode === 'envelope'
        ? { db: null, rebuildFailed: false, fail: { error: `缓存库不可用：${errMsg(e)}` } }
        : failOpen(`树红点聚合降级（rebuild/开库失败，只算 verdict）：${errMsg(e)}`)
    }
  } catch (e) {
    return opts.failMode === 'envelope'
      ? { db: null, rebuildFailed: false, fail: { error: `缓存库不可用：${errMsg(e)}` } }
      : failOpen(`树红点聚合降级（rebuild/开库失败，只算 verdict）：${errMsg(e)}`)
  }
}

/**
 * F5（复审-0914-优化修复批）：降级黄项「后置 push + strict 短篇升红」三连同构收编
 * ——原在 runCheckForDocument（book.yaml 降级 R29-5）与 checkWithDb（账本兑现侧
 * R31-3 / 声明侧 R33D-14）逐字复制。section 名 / checkId / level / 升红语义逐位不变，
 * 纯机械去重。
 */
function pushDegradedYellow(
  report: CheckReport,
  config: BookConfig,
  name: string,
  checkId: string,
  message: string,
  chapter?: number,
): void {
  const item: CheckItem =
    chapter === undefined
      ? { checkId, level: 'yellow', message }
      : { checkId, level: 'yellow', message, chapter }
  report.sections.push({ name, items: [item] })
  // R51-E-N2（五十一轮）：后置推入不过 runner 的报告内升红路径——严格短篇下
  // degraded/unreadable 族同升红（「配置降级/检查没跑成」不可绿灯过定稿闸）。
  // 重评-P2-4（2026-09-09 全量代码重评）：strict 生效判定走 effectiveShort
  // （kind==='short' 门控）——长篇误写 short 段不升红，与 runner 报告内路径同源。
  if (effectiveShort(config)?.strict) promoteStrictShort(report.sections.slice(-1))
}

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
  const { config, degradedError } = readCheckConfig(bookRoot, userDataPath ?? null)
  const hasWiring = existsSync(join(bookRoot, '布线'))
  // M-9（2026-08-21）：rebuild/开库硬异常归 REBUILD_FAIL 出口（此前穿透成 500 裸异常，
  // 端点契约本就为这类失败预留了 code）——R47-11 节流 opt-in，见 openCheckDb 头注
  const opened = openCheckDb(bookRoot, hasWiring, { throttleSourceProbe: true, failMode: 'envelope' })
  if (opened.fail) {
    const envelope: Extract<CheckOutcome, { ok: false }> = {
      ok: false,
      code: 'REBUILD_FAIL',
      error: opened.fail.error,
    }
    if (opened.fail.details !== undefined) envelope.details = opened.fail.details
    return envelope
  }
  const db = opened.db
  try {
    // R29-5（二十九轮）：book.yaml 降级黄项透出——config 回落默认仍能跑，但阈值/词表/
    // 账本类配置本轮未生效，作者只看 warn 日志无从知晓；在机检报告里透出黄项（面板可见，
    // 不驱动红闸）让「降级事实」与「机检结果」同屏。（R51-E-N2 升红语义见 pushDegradedYellow 注）
    const outcome = checkWithDb(bookRoot, absPath, db, config, undefined, { draftText: opts?.draftText })
    if (outcome.ok && degradedError !== null) {
      pushDegradedYellow(
        outcome.report,
        config,
        'book.yaml',
        'book-config-degraded',
        `book.yaml 解析失败，本轮机检按默认配置降级执行（${degradedError}）——书级阈值/词表/账本配置未生效，修复后请重查。`,
        outcome.chapter.章号,
      )
    }
    return outcome
  } finally {
    if (db) db.close()
  }
}

/**
 * 扫 `写作/正文` 取全书最高已定稿章号（账本「未来章」基准，T9b 修复）。
 * 无布线不走账本检查（无全书最高章号基准需求）→ 返回 undefined。
 * 已定稿 = manifest 有 finalizedRevision（去 git：不再用 untracked 排除草稿）。
 */
export function maxWrittenChapterOf(
  bookRoot: string,
  preScanned?: ChapterMeta[],
  manifestEntries?: Map<string, ManifestEntry>,
): number | undefined {
  const bodyDir = join(bookRoot, '写作', '正文')
  // P5-管线（第七轮）：接受调用方预扫的正文章列表（批量路径 bodyChapters 一扫两用），
  // 原先内部再 readChapterDir 一遍 = 全书正文双遍扫描
  const chapters = preScanned ?? (existsSync(bodyDir) ? readChapterDir(bodyDir).chapters : [])
  if (chapters.length === 0) return undefined
  // 排除未定稿（无 finalizedRevision）的草稿——不算"已写"基准（防账本「未来章」检查误判）
  // P3（复审-0914-优化修复批）：树聚合侧接受已读 entries（collectTreeIssuesCore 聚合头
  // 已 readManifest 整读）——原实现此处内部再整读同一清单 = 单请求双读；单章路径不传
  // 照旧自读（语义等价）。
  const entries = manifestEntries ?? readManifest(join(bookRoot, '项目', '文档清单.jsonl')).entries
  const finalized = new Set<string>()
  for (const e of entries.values()) {
    // R42-5（四十二轮）：join 键折叠（platformCaseFold 单源：win32/darwin 折叠 + NFC；
    // R51-D-2 起 darwin 也折叠）——外部 case-only 改名 / NFD 文件名后精确串失配，
    // 定稿章被当草稿 → maxWritten 基准低估 → 账本「未来章」假红
    if (e.nodeType === 'document' && e.finalizedRevision) finalized.add(docJoinKey(e.path))
  }
  let max = 0
  for (const ch of chapters) {
    if (!ch._path) continue
    // M-4（第六轮）：relative() 在 Windows 产反斜杠而 manifest 键是正斜杠——不归一
    // 全部章误判未定稿（同款已修：export/index.ts RB-KN-P2-3、state.ts relativePath）
    // 复审-0913-mac适配 P3-2：归一收窄 win32-only——posix 上字面 `\` 文件名保持原样，
    // 与 manifest 侧 docJoinKey 双侧同口径（两侧均不再扭曲）
    const rel = normalizeWinSeparators(relative(bookRoot, ch._path))
    if (!finalized.has(docJoinKey(rel))) continue // R42-5：双侧同键（扫描路径侧折叠）
    if (ch.章号 > max) max = ch.章号
  }
  // S2（阶段 24）：并入感知——合并最高定稿章后源章摘除（正文文件 + manifest 定稿集
  // 均已无该章号），预扫值会低估使既有履历行「第N章」被判 lead-chapter-future 假红
  // （设计 §5.4 检查器改口：future 基准 = max(现值, 并入 在档最大源章号)）。
  // .cache 删损重建场景（state.ts 兜底族）同面覆盖：基准消费点在此单点收口。
  let mergedMax = 0
  for (const ch of chapters) {
    for (const src of ch.并入 ?? []) if (src > mergedMax) mergedMax = src
  }
  if (mergedMax > max) max = mergedMax
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
   *  还原 readChapterUpdatesForChapter 拼装口径）；不传则单章路径现读（语义等价）。
   *  R31-3（三十一轮）：闭包升级为读失败感知版 ChapterUpdatesResult——unreadable 时
   *  调用方跳过两端闭合（不再把「清单未知」当「未兑现」误报红硬阻断定稿）。 */
  leadUpdatesForChapter?: (chapterNo: number) => ChapterUpdatesResult
  /** R32-16（三十二轮）：细纲声明批内 memo——细纲是覆盖写单文件，批量聚合 N 章
   *  此前逐章 existsSync+read+parse 同一文件（CC-P1-3 预扫漏项，仅性能）。闭包
   *  首调读+parse 一次，其后按章号出三态；不传则单章路径现读（语义等价）。
   *  R33D-14：返回类型扩 OutlineDeclaration（known:false 带 reason）。 */
  outlineDeclarationFor?: (chapterNo: number) => OutlineDeclaration
  /** P3（复审-0914-优化修复批）：布线在盘与否——collectTreeIssuesCore 聚合头已判
   *  （rebuild/开库决策同源），章循环内 checkWithDb 不再逐章 existsSync；不传则
   *  单章路径照旧现判（语义等价）。 */
  hasWiring?: boolean
}

/**
 * R65-24（十三轮）：批量路径的账本推进预扫——主文件标签 + 正文一次读、.账本推进暂存/
 * 第N章.md 目录一次扫，返回按章取数的闭包（与逐章调 readChapterUpdatesForChapter 逐条
 * 等价：无标签主文件对每章生效、带章标签主文件只对本章生效、归档按章名配对）。
 * R31-3（三十一轮）：读失败不再静默折算成空清单——经 checked 读取透传 unreadable
 * （主文件读失败对所有本章生效章可见；归档文件读失败仅对该章可见），单文件读失败
 * 不阻断批量机检本体，但两端闭合对该章降级跳过（fail-noisy，见 checkWithDb 黄项）。
 */
export function scanChapterUpdatesByChapter(bookRoot: string): (chapterNo: number) => ChapterUpdatesResult {
  const mainPath = join(bookRoot, LEAD_UPDATES_FILE)
  const mainTag = readLeadUpdateChapterTag(mainPath) // 无文件/读失败 → null（宽容口径）
  const mainRead = readLeadUpdatesAtChecked(mainPath)
  const mainResult: ChapterUpdatesResult = { updates: mainRead ?? [], unreadable: mainRead === null }
  const archiveByChapter = new Map<number, ChapterUpdatesResult>()
  const archiveDir = join(bookRoot, LEAD_UPDATES_ARCHIVE_DIR)
  if (existsSync(archiveDir)) {
    // R37-9（三十七轮）：existsSync→readdirSync 间隙目录被瞬删/异常迁移（TOCTOU，同
    // R65-16 口径）时 ENOENT 直穿炸整条批量机检链路（端点 500）——降级空列表 + warn
    // 留痕（归档账本暂不进预扫，主文件口径不受影响），ENOTDIR（路径被文件占用）同降级
    let archivedFiles: string[] = []
    try {
      archivedFiles = readdirSync(archiveDir)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        log.warn('check', `归档目录读取失败（${archiveDir}，${code}），本轮归档账本推进按空处理`)
      } else {
        throw e
      }
    }
    for (const f of archivedFiles) {
      const m = f.match(/^第(\d+)章\.md$/i)
      // R38-9：i 标志——归档文件 .MD 大写扩展名不再漏配对（其余命名如 ._ 资源文件照旧不入）
      if (!m) continue
      const read = readLeadUpdatesAtChecked(join(archiveDir, f))
      archiveByChapter.set(Number(m[1]), { updates: read ?? [], unreadable: read === null })
    }
  }
  return (chapterNo: number): ChapterUpdatesResult => {
    const mainActive = mainTag === null || mainTag === chapterNo
    const archive = archiveByChapter.get(chapterNo)
    return {
      updates: [
        ...(mainActive ? mainResult.updates : []),
        ...(archive?.updates ?? []),
      ],
      unreadable: (mainActive && mainResult.unreadable) || (archive?.unreadable ?? false),
    }
  }
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
    // P3（复审-0914-优化修复批）：布线判定批量路径走 batch 透传（聚合头已判），仅单章路径现判
    const hasWiring = batch?.hasWiring ?? existsSync(join(bookRoot, '布线'))
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
    // R32-16：batch 预扫闭包优先（细纲单文件批内 memo）；未传 batch（单章 check 端点）现读
    const declaration = useLeads
      ? (batch?.outlineDeclarationFor?.(draft.chapter.章号) ?? outlineDeclarationForChapter(bookRoot, draft.chapter.章号))
      : undefined
    const declaredLeadIds = declaration?.known ? declaration.leads : undefined
    // R61-14（第六十一轮）：实际侧同口径按被检章过滤（V-P2-14 声明侧同向）——
    // 他章证据不作本章「已兑现」参照。
    // R65-24（十三轮）：actual 侧改走 readChapterUpdatesForChapter 单源（主文件（属于
    // 本章时）+ 工作区/.账本推进暂存/第N章.md，内含 in-scope 判定）——此前只读主文件：
    // 批量连写书的归档章推进被无视，误报 lead-declared-not-done 红（定稿闸与履历回写
    // 自 ff-P1-1 已统一本函数，机检是最后缺口）。batch 预扫闭包同口径（CC-P1-3 消每章重读）
    // R31-3（三十一轮）：兑现侧读失败（权限/瞬态占用）≠「无推进」——unreadable 时
    // actualLeadIds 传 undefined 跳过两端闭合（对齐声明侧 R70-15 known:false 口径，
    // 防把瞬态故障当作者过错产 lead-declared-not-done 假红硬阻断定稿），黄项降级见下方。
    //（win 线 R33-5 同因独立修复，口径一致，合并取本侧 ChapterUpdatesResult 形状。）
    const updatesResult = useLeads
      ? (batch?.leadUpdatesForChapter?.(draft.chapter.章号) ?? readChapterUpdatesForChapterChecked(bookRoot, draft.chapter.章号))
      : undefined
    const actualLeadIds = updatesResult && !updatesResult.unreadable
      ? updatesResult.updates
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
      skipLeadsBookChecks: opts?.skipLeadsBookChecks === true,
    })
    // R31-3（三十一轮）：兑现侧读失败的黄项降级（fail-noisy 不可静默）——跳过闭合的
    // 事实随报告透出（对齐 checkNewNames roster-unreadable / R29-5 book-config-degraded
    // 的降级黄项口径），作者只看面板即知本轮「声明↔兑现」未比对、修复后须重查。
    // 树红点聚合缓存只存 {hasRed, verdictRejected} 布尔、不缓存黄项条目，降级黄项
    // 不会被缓存固化（hasRed=false 只表示本轮无红，属账本全书性红项同一缓存语义）。
    // F5：push + strict 升红收编 pushDegradedYellow（R51-E-N2 语义见其注）。
    if (updatesResult?.unreadable) {
      pushDegradedYellow(
        report,
        config,
        '账本推进',
        'lead-updates-unreadable',
        '账本推进文件读取失败（权限/瞬态占用），本章「声明↔兑现」两端闭合本轮跳过——修复读取后请重查，闭合未知期间请勿定稿该章。',
        draft.chapter.章号,
      )
    }
    // R33D-14（三十三轮）：声明侧读失败的黄项降级（对齐兑现侧 R31-3 fail-noisy 口径）
    // ——known:false 且 reason='read-failed' 时本章两端闭合同样被跳过，此前零留痕；
    // chapter-mismatch（细纲属他章，批量连写常态）维持静默，不算故障。
    if (declaration && !declaration.known && declaration.reason === 'read-failed') {
      pushDegradedYellow(
        report,
        config,
        '账本推进',
        'lead-outline-unreadable',
        '细纲文件读取失败（权限/瞬态占用），本章「声明↔兑现」两端闭合本轮跳过——修复读取后请重查，闭合未知期间请勿定稿该章。',
        draft.chapter.章号,
      )
    }
    return { ok: true, report, hasRed: hasRed(report), chapter: draft.chapter, body: draft.body }
  } catch (e) {
    // 重审-11（2026-09-07 全量代码重审 §四.11）：异常转 CHECK_ERROR 信封时补 warn
    // 留痕——树聚合路径对单章机检失败已有同款（collectTreeIssues 的「章机检失败（红点
    // 可能缺失）」），单章端点此前静默：CHECK_ERROR 只存在于响应信封，服务日志零线索。
    // tag 'check' 对齐本文件现有用法；带文档路径与异常信息。
    log.warn('check', `单章机检失败（CHECK_ERROR，红点缺失）：${absPath}——${errMsg(e)}`)
    return { ok: false, code: 'CHECK_ERROR', error: errMsg(e) }
  }
}

/** CheckOutcome.code → HTTP 状态。 */
export function checkOutcomeStatus(code: 'NOT_CHAPTER' | 'REBUILD_FAIL' | 'CHECK_ERROR'): number {
  if (code === 'NOT_CHAPTER') return 400
  return 500
}
