/**
 * 项目总览 REST 端点（#7.2）。
 *
 * GET /api/books/:name/overview → 身份 + 进度 + 状态机位置 + 卷结构
 *
 * 状态机经 detectState（自包含：内部 rebuild index.db 幂等 + journal 崩溃自愈 + assembleStatus；
 * R35-5 起异步，调用方 await；G3 短时缓存 5s，且 R37-19 起只有成功结果落缓存）。失败不崩
 *（返 state:0 + 错误，不落缓存）。
 *
 * R37-20（三十七轮）注释如实化：此前本文件注释给人「已缓存/无阻塞」的整体印象，实态是
 * 只有 state 判定有缓存——timeline（逐章 statSync 按日聚合）/ progress（readChapterDir
 * 全书扫描）/ recentDoc（再扫一遍正文目录）均无缓存、每请求全量算；卷列表 listVolumes
 * 只扫一层目录（轻，非全书）。R37-3 起 timeline/progress 改走逐块让出的 async 扫描
 *（statSync 循环每 25 章让出一次，原语共享 progress.ts），大书聚合期间其它请求/SSE
 * 心跳可跑；但 readChapterDir 扫描段本身仍是单段同步（内核不在本批边界，热路径有
 * CC-P1-3 stat 级元数据缓存兜住，冷路径变更章整读仍属该段）。投影缓存归 R37-16 批，
 * 本文件不引入。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, relative } from 'node:path'
import { readdirSync, existsSync, statSync } from 'node:fs'
import { defineRoute } from './schema.js'
import { reply, replyError } from '../http.js'
import { resolveBookOrReply } from '../book-context.js'
import { readBookConfig } from '../../../format/yaml.js'
import { applyGlobalDefaults } from '../../../format/global-defaults.js'
import { isMdFileName } from '../../../format/filename.js'
import type { BookConfig } from '../../../format/types.js'
import { readChapterDir } from '../../../format/chapters.js'
import type { ChapterMeta } from '../../../format/types.js'
import { finalizedPathSet } from '../../../document/manifest.js'
import { docJoinKey } from '../../../fs/safe-path.js'
import { localDayKey, log, errMsg } from '../../../log/index.js'
import { detectState, STATE_NAMES, type DetectedState } from '../../../state/state.js'
import { trackInFlightWork } from './in-flight-work.js' // R0910-W：rebuild Worker 退出收尾登记
import { computeProgressAsync, yieldToEventLoop, SCAN_YIELD_EVERY } from './progress.js'
import { createTtlProbeCache } from '../ttl-cache.js' // D1（复审-0914-优化修复批）：TTL+探针+FIFO 缓存壳单源
import { sigStatFor } from './rhythm.js' // 精简批（SRV 域）：size:mtimeMs 签名单源（原本地同构副本收敛）
import { redactSecret } from '../../../ai/provider/redact.js' // P2-4：API 错误脱敏

interface OverviewCtx {
  workDir: string | null
  /** APP 级数据目录：genre/target_words/volume_size 喂运行时（状态机+完成度）走全局托底链 */
  userDataPath: string | null
}

// G3：state 判定结果短时缓存。detectState 内部全量 rebuild index.db（clearAllTables 清空重建），
// overview 每次请求都触发会慢（大书几百 ms~秒级）。概览页 stale 5s 可接受；精确态走 /state 或 enter。
// CC-P1-3：原单条目缓存多书交替访问永 miss（P3 观察项）——改多书 Map（key=bookRoot）+ FIFO 上限。
// R37-19（三十七轮）：只有成功路径落缓存——此前 catch 降级态（state:0 + error）同样
// 落缓存，TTL 内数据已修复的后续请求也被假空态挡住（缓存了「失败」而非「结果」）。
type StateOutput = { state: number; name: string; detail: DetectedState | { error: string } }

// ── R47-7（四十七轮）：概览整包短缓存 ──────────────────────────────────────────
// 同族端点（search/tree-issues/analysis-overview/version-stats/rhythm/foreshadows）
// 的「目录指纹 + TTL」缓存壳此前唯 overview 漏网（R37-3 注释「缓存归 R37-16 批，
// 勿在此引入」——该批未落地，本轮收口）：每次开/刷新总览页三路全书扫描（timeline
// 逐定稿章 statSync + progress 正文目录扫 + recentDoc 再扫正文目录取章号最大），
// 2000 章 ≈单请求 3 次目录扫 + ~2000 次 stat。口径对齐 rhythm.ts：stat 指纹
//（book.yaml + 写作/正文 + 项目/文档清单.jsonl + 大纲/卷纲）+ 5s TTL + FIFO 32 +
// forgetBookKeyedCaches 挂点（复用下方 forgetOverviewCache）。staleness 语义与
// stateCache 的「概览页 stale 5s 可接受」一致。
const OVERVIEW_CACHE_TTL_MS = 5000
const OVERVIEW_CACHE_MAX = 32
let overviewTtlMs: number | null = null
/** R47-7：TTL 测试注入口（先例同 __setRhythmCacheTtlForTest）。仅测试用。
 *  R0912-ds41（重评-deepseek-v4.1-flash P3-2）补门收编：消费方 = test/studio/
 *  r0912-ttl-write-clock.test.ts（既有）+ test/studio/r0912-ds41-ttl-gates.test.ts
 * （TTL 命中/过期/指纹失效三态门，本批评门新增）。 */
export function __setOverviewCacheTtlForTest(ms: number | null): void {
  overviewTtlMs = ms
}
/** R47-7 回归观测钩子（先例同 __rhythmScanCountForTest）：MISS → 三路重算计数。
 *  R0912-ds41（重评-deepseek-v4.1-flash P3-2）补门收编：MISS 计数断言面 =
 *  test/studio/r0912-ds41-ttl-gates.test.ts（原评审登记的「只写不读」至此消除）。 */
export function __overviewScanCountForTest(): number {
  return overviewCache.scanCountForTest()
}
export function __resetOverviewScanCountForTest(): void {
  overviewCache.resetScanCountForTest()
}

/** 概览读面指纹：book.yaml（kind/target）+ 写作/正文（timeline/progress/recentDoc）+
 *  项目/文档清单.jsonl（finalizedPathSet 定稿集）+ 大纲/卷纲（volumes）。 */
function overviewSignature(bookRoot: string): string {
  return [
    sigStatFor(join(bookRoot, 'book.yaml')),
    sigStatFor(join(bookRoot, '写作', '正文')),
    sigStatFor(join(bookRoot, '项目', '文档清单.jsonl')),
    sigStatFor(join(bookRoot, '大纲', '卷纲')),
  ].join(',')
}

/** R67-15（十五轮）：删书/改名失效挂点（同 health.ts forgetStyleScanCache 口径）。
 *  R47-7：整包缓存同挂本函数（books.ts forgetBookKeyedCaches 家族零新挂点）。 */
export function forgetOverviewCache(bookRoot: string): void {
  overviewStateCache.forget(bookRoot)
  overviewCache.forget(bookRoot)
}
const STATE_CACHE_TTL = 5000
const STATE_CACHE_MAX = 32

/** 整包缓存值包装：stateOk（state 段成功与否）承载「成功态才落缓存」（R37-19 口径
 *  经 storeIf 表达）；missingYamlPath 承载 book.yaml 缺失的显式 500 出口（R51-RED-2，
 *  不落缓存）。 */
interface OverviewCompute {
  payload: Record<string, unknown>
  stateOk: boolean
  missingYamlPath?: string
}

/** D1（复审-0914-优化修复批）：缓存壳收编 ttl-cache.ts 通用件（原本地 Map + FIFO +
 *  R47-18 过期逐出本地壳删除；命中/失效时序/逐出序逐位不变——单级探针 + FIFO 32，
 *  见 ttl-cache.ts 头部收敛映射表；计算体闭包 ctx/entry，经 get(key, compute) 逐调用
 *  传入；state 段降级/book.yaml 缺失不落缓存由 storeIf 承担）。 */
const overviewCache = createTtlProbeCache<string, OverviewCompute>({
  name: 'overview',
  keyOf: (k) => k,
  max: OVERVIEW_CACHE_MAX,
  ttl: () => overviewTtlMs ?? OVERVIEW_CACHE_TTL_MS,
  probe: overviewSignature,
  storeIf: (v) => v.stateOk && !v.missingYamlPath,
})

/** G3：state 判定结果短时缓存（detectState 内部全量 rebuild index.db）。R37-19：只有
 *  成功路径落缓存——由「计算体抛错即不落缓存」承担；原无 R47-18 过期逐出行，
 *  特记 evictExpiredOnMiss:false（逐条核对后按原样保留）。 */
const overviewStateCache = createTtlProbeCache<string, StateOutput>({
  name: 'overview-state',
  keyOf: (k) => k,
  max: STATE_CACHE_MAX,
  ttl: () => STATE_CACHE_TTL,
  evictExpiredOnMiss: false,
})

export function registerOverviewRoutes(ctx: OverviewCtx): void {
  defineRoute('books.overview', {
    method: 'GET',
    path: '/api/books/:name/overview',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBookOrReply(ctx.workDir, params['name'], res)
    if (!r) return
    const entry = r.entry

    const bookRoot = r.bookRoot
    // R47-7（四十七轮）：整包指纹+TTL 缓存——命中直接回包跳过三路全书扫描；过期条目
    // 顺手逐出（R47-18 同款）。D1（复审-0914-优化修复批）：壳体收编 ttl-cache.ts
    // 通用件（探针/命中判定/逐出/「成功态才落缓存」由通用件 + storeIf 承担，时序逐位
    // 不变；计算体闭包 ctx/entry，经 get(key, compute) 逐调用传入）
    const computed = await overviewCache.get(bookRoot, async (root): Promise<OverviewCompute> => {
      // 总览喂运行时（genre 回显 / target_words 完成度 / volume_size 经状态机）：
      // readBookConfig 结果统一过 applyGlobalDefaults——书级未设回落 global.json → 硬编码
      // R50-C-2（五十轮）：book.yaml 损坏静默降级留痕（对齐 state.ts P3-2 口径）——
      // 错误分支带 DEFAULT_CONFIG 骨架，未判 ok 直接用 .config 会无声回落默认身份
      // R51-RED-2（五十一轮）：recover 合并失同步收口——R48-79 正本契约与 R50-C-2
      // 既有契约按失败模式分流：book.yaml **缺失**（books.jsonl 在册而档案缺位，书
      // 档案不完整）显式 500 拒绝以默认身份代答——静默代答会把假 kind/genre 渲染成
      // 真书档案；**损坏**（存在但解析失败）保持 R50-C-2 口径 200 降级 + warn 留痕
      //（r50-c2 回归钉），作者可见诊断、书不因局部损坏整体不可用。
      const bookYamlPath = join(root, 'book.yaml')
      const cfgResult = readBookConfig(bookYamlPath)
      if (!cfgResult.ok) {
        if (!existsSync(bookYamlPath)) {
          return { payload: {}, stateOk: false, missingYamlPath: bookYamlPath }
        }
        log.warn('overview', `book.yaml 解析降级: ${cfgResult.error.message}`)
      }
      const config = applyGlobalDefaults(cfgResult.config, ctx.userDataPath)
      const kind = config.kind === 'short' ? 'short' : 'long'

      // 状态机（自包含；失败降级 state:0）。G3：命中短时缓存则跳过全量 rebuild。
      // R47-7：state 成功路径标记——降级态（catch state:0）不落整包缓存（R37-19
      //「不缓存失败」口径对整包内的 state 段同样适用）
      let state: StateOutput
      let stateOk = false
      try {
        state = await overviewStateCache.get(root, async (stateRoot): Promise<StateOutput> => {
          // R35-5：detectState 异步化——healMovePending 自愈链的锁等待不再阻塞事件循环
          // R55-B-N（五十五轮）：rebuild 走 worker 通道（同 /api/state 接线）——大书
          // 首进门全量重建卸线程，事件循环不再秒级冻结（SSE 心跳/保存停摆面）
          const detected = await trackInFlightWork(detectState(stateRoot, config, undefined, { rebuildChannel: 'worker' }))
          return { state: detected.state, name: STATE_NAMES[detected.state], detail: detected }
        })
        stateOk = true
      } catch (e) {
        // R37-19：失败态不落缓存——下一请求立即重试（而非被 TTL 挡住拿假空数据）
        state = {
          state: 0,
          name: '状态机判定失败',
          // P2-4：API 错误脱敏
          detail: { error: redactSecret(errMsg(e)) },
        }
      }

      // R46-1（四十六轮）：本 handler 的三个全书投影（timeline / progress / recentDoc）
      // 此前各自 readChapterDir 扫一遍章目录（三连全扫，2000 章书每次打开总览 = 3 次目录
      // 遍历 + 2000+ statSync）——改单趟扫描结果三处复用；timeline 的逐章 statSync 让出
      // 纪律不变。投影缓存（R37-16 登记）仍不引入（指纹壳的成本/一致性权衡未拍板）。
      const { chapters: bodyChapters } = readChapterDir(join(root, '写作', '正文'))
      const timeline = await computeTimeline(root, bodyChapters)
      const shortProfile = kind === 'short' ? extractShortProfile(config) : undefined
      const payload: Record<string, unknown> = {
        identity: {
          name: entry.name,
          kind: entry.kind,
          path: entry.path,
          ...(entry.created_at ? { created_at: entry.created_at } : {}),
          title: config.book.title,
          genre: config.book.genre,
          host: entry.host ?? 'cc',
        },
        progress: withTarget(await computeProgressAsync(root, bodyChapters), config.book.target_words),
        state,
        volumes: listVolumes(root),
        timeline,
        recentDoc: getRecentDoc(root, bodyChapters),
        streak: computeStreak(timeline),
        ...(shortProfile ? { shortProfile } : {}),
      }
      return { payload, stateOk }
    })
    if (computed.missingYamlPath) {
      return replyError(
        res,
        500,
        'IO_ERROR',
        `book.yaml 缺失：${computed.missingYamlPath}（书档案不完整，拒绝以默认配置代答）`,
      )
    }
    reply(res, 200, computed.payload)
  },
  })
}

/** 附完成度：target_words 存在且 words>0 时算 percent（决策 14，直除） */
function withTarget(
  p: { chapters: number; words: number },
  targetWords?: number,
): { chapters: number; words: number; targetWords?: number; percent?: number } {
  if (!targetWords || targetWords <= 0 || p.words <= 0) return p
  return { ...p, targetWords, percent: Math.min(100, Math.round((p.words / targetWords) * 1000) / 10) }
}

/** 卷结构：大纲/卷纲/*.md（长篇） */
function listVolumes(bookRoot: string): { name: string; path: string }[] {
  const dir = join(bookRoot, '大纲', '卷纲')
  if (!existsSync(dir)) return []
  const out: { name: string; path: string }[] = []
  try {
    for (const f of readdirSync(dir)) {
      // R42-39（四十二轮）：.md 判定收敛 isMdFileName（大小写不敏感），剥尾正则同步加 /i
      // ——win 资源管理器改 .MD 后卷列表静默失明；`._` 前缀跳过条件不变。
      if (!isMdFileName(f) || f.startsWith('._')) continue
      out.push({ name: f.replace(/\.md$/i, ''), path: `大纲/卷纲/${f}` })
    }
  } catch {
    // 无卷纲目录
  }
  return out
}

/**
 * 写作热力（#7.2）：已定稿文件 mtime 按日聚合（写作/正文）。
 * 返日期-计数列表供总览页日历热力图。mtime 反映定稿落盘时间（够用，git commit 时间更准但贵）。
 * 低级项（第六轮）：只统计已定稿章——写作中的草稿保存也会刷 mtime，原先被计入
 * 「定稿产出」，热力图/连续天数虚高且与字数日记口径打架。旧书无清单（无法判定）
 * 保持全量口径（与历史行为一致）。
 * R37-3（三十七轮）：原地异步化（模块私有、唯一调用方 handler 已 await）——statSync
 * 逐章循环每 SCAN_YIELD_EVERY（25）章让出一次事件循环；readChapterDir/finalizedPathSet
 * 扫描段边界见文件头 R37-20 注。聚合结果与同步实现逐位一致（r37 回归锚以固定期望守护）。
 */
async function computeTimeline(bookRoot: string, chapters: ChapterMeta[]): Promise<{ date: string; count: number }[]> {
  const files: string[] = []
  for (const c of chapters) if (c._path) files.push(c._path)
  const finalized = finalizedPathSet(bookRoot)
  // R38-14（三十八轮）：定稿集身份折叠（win 大小写不敏感 FS 外部 case-only 改名后
  // 精确匹配失配）；posix 恒等
  const finalizedKeys = finalized === null ? new Set<string>() : new Set([...finalized].map(docJoinKey)) // R41-2：升 docJoinKey（+NFC 归一）
  const byDay = new Map<string, number>()
  let processed = 0
  for (const fp of files) {
    // R37-3：悬停点——每 25 章（条）让出一次
    if (++processed % SCAN_YIELD_EVERY === 0) await yieldToEventLoop()
    if (finalized && !finalizedKeys.has(docJoinKey(relative(bookRoot, fp)))) continue
    let mtime: Date
    try {
      mtime = statSync(fp).mtime
    } catch {
      continue
    }
    const day = localDayKey(mtime) // 第五轮：本地日分桶——与字数日记 todayDate 同口径（此前 UTC 切日，东八区 0-8 点记前一日，热力图/连续天数与日记打架）
    byDay.set(day, (byDay.get(day) ?? 0) + 1)
  }
  return [...byDay.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** 最近一章（按章号最大）—— 供总览页"继续写作"入口。R46-1：章列表由调用方单趟传入。 */
function getRecentDoc(bookRoot: string, chapters: ChapterMeta[]): { no: number; 标题: string; path: string } | null {
  if (chapters.length === 0) return null
  const sorted = [...chapters].sort((a, b) => (b.章号 ?? 0) - (a.章号 ?? 0))
  const last = sorted[0]
  if (!last?._path) return null
  return { no: last.章号, 标题: last.标题, path: relative(bookRoot, last._path).replace(/\\/g, '/') }
}

/** 连续写作天数：从 timeline 末尾往前数连续有产出的天数（允许今天还没写 → 从昨天起算） */
function computeStreak(timeline: { date: string; count: number }[]): number {
  if (timeline.length === 0) return 0
  const dates = new Set(timeline.map((t) => t.date))
  let cursor = new Date()
  // 今天没写 → 从昨天起算（不因"今天还没动笔"就断 streak）；日键与 timeline 同为本地日
  if (!dates.has(localDayKey(cursor))) {
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - 1)
  }
  let streak = 0
  for (;;) {
    const dayStr = localDayKey(cursor)
    if (dates.has(dayStr)) {
      streak++
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - 1)
    } else break
  }
  return streak
}

/** 短篇画像（从 book.yaml.short 提取，总览页缺口分析用） */
function extractShortProfile(config: BookConfig): {
  targetEmotions?: string[]
  targetReversalTypes?: string[]
  targetEndingFlavors?: string[]
  seriesMotifs?: string[]
} | undefined {
  const s = config.short
  if (!s) return undefined
  const out: {
    targetEmotions?: string[]
    targetReversalTypes?: string[]
    targetEndingFlavors?: string[]
    seriesMotifs?: string[]
  } = {}
  if (s.target_emotions?.length) out.targetEmotions = s.target_emotions
  if (s.target_reversal_types?.length) out.targetReversalTypes = s.target_reversal_types
  if (s.target_ending_flavors?.length) out.targetEndingFlavors = s.target_ending_flavors
  if (s.series_motifs?.length) out.seriesMotifs = s.series_motifs
  return Object.keys(out).length > 0 ? out : undefined
}
