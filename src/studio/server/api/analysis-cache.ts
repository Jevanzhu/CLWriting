/**
 * 分析端点缓存族（analysis.ts 的缓存与聚合计算落地档）。
 *
 * 内容 = 两条书键 TTL 缓存壳（style-corpus 文风语料采样 / analysis-overview 全书聚合）：
 * 阈值与上限常量、删书/改名失效挂点与自登记、analysis-overview 的两级探针
 *（便宜目录指纹 + 每文件 stat 全量签名）与异步分批计算体。缓存实例与 forget* 导出即观测面
 *（生产对象，非测试专用 API）：回归用例直读 stats()/直调失效挂点。
 *
 * 为什么独立成档：审阅包（analysis-ops.ts）与路由声明面（analysis.ts）都要取这两条缓存，
 * 缓存若留在任一侧即成运行时环——缓存族单源本档、两侧单向 import 本档，模块图无环。
 * 失效语义不变量：写侧失效挂点由信封落盘路径调用（analyze / analyze-style）；
 * 删书/改名经 registerBookKeyedCache 自登记的成对挂点清理（同名重建书不读陈数据）；
 * TTL 只作探针不可见变化的兜底（≤5s），探针命中即跳过 manifest 整读 + 信封全读。
 *
 * 依赖方向单向（无环）：本档 → ttl-cache / cache-registry / rhythm（stat 签名单源）/
 * document（manifest、分析信封）/ fs / log / progress（让出口径）；不 import analysis.ts
 * 与 analysis-ops.ts，顶层求值常量（两条缓存实例）单源本档，绝不经环回引。
 */
import { join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { readManifest } from '../../../document/manifest.js' // analysis-overview 全量遍历（非 docId 单查）
import { readAnalysisKinds, readBookAnalysis } from '../../../document/analysis.js'
import { createTtlProbeCache } from '../ttl-cache.js' // TTL+探针+FIFO 缓存壳单源
import { registerBookKeyedCache } from '../cache-registry.js' // 书键缓存登记表（登记制单源）
import { sigStatFor } from './rhythm.js' // stat 签名单源（原本地同构副本收敛，单源落点 rhythm.ts 既有两 import 方不变）
import { yieldToEventLoop, SCAN_YIELD_EVERY } from './progress.js' // MISS 读循环逐块让出（范式；起主路径下沉 worker，此为回落面）
import type { FullStyleStats } from '../../../metrics/style.js'

// 内存闸（审计）：analyze-style 每次全书重读正文（allBodies 数组 + join 整书
// 大串同驻）——采样正文与全文 stats 按书缓存 5s，重跑/续跑不再重扫。口径对齐 overview.ts
// stateCache：5s TTL + 书键 Map FIFO 上限；overview 无写路径失效挂点（纯 TTL），此处同口径
// ——保存/定稿后最迟 5s 自愈（envelope.sourceHash 与实际进 prompt 的采样同刻同源，不破 stale 判定）。
export interface StyleCorpusResult {
  fullStats: FullStyleStats
  sampleText: string
}
/** 删书/改名失效挂点（同 health.ts forgetStyleScanCache 口径）。 */
export function forgetStyleCorpusCache(bookRoot: string): void {
  styleCorpusCache.forget(bookRoot)
}

// 登记制（模块顶层自登记）：删/改名后同名重建书不读陈文风语料采样（TTL 5s 兜底自愈）。
registerBookKeyedCache('style-corpus', forgetStyleCorpusCache)
const STYLE_CORPUS_TTL = 5000
/** 收尾：__setStyleCorpusTtlForTest 删除——TTL 覆盖档改组装根
 * RouteOverrides 注入（ctx.styleCorpusTtlMs 逐调用传入，随实例隔离）。 */
const STYLE_CORPUS_MAX = 32

/** 缓存壳收编 ttl-cache.ts 通用件（原本地 Map + FIFO +
 * 过期逐出 +写侧全表清扫本地壳删除；命中/失效时序/逐出序逐位
 *  不变——纯 TTL + 异步计算 + FIFO 32 + sweepExpiredOnWrite，见 ttl-cache.ts 头部
 *  收敛映射表；计算体闭包 per-request 章列表/规则，经 get(key, compute) 逐调用传入）。 */
export const styleCorpusCache = createTtlProbeCache<string, StyleCorpusResult>({
  name: 'style-corpus',
  keyOf: (k) => k,
  max: STYLE_CORPUS_MAX,
  ttl: () => STYLE_CORPUS_TTL,
  sweepExpiredOnWrite: true,
})

// ── analysis-overview 全书聚合 5s TTL 缓存 ─────────────────
// 端点遍历 manifest + 分析目录全部信封（长书同步 IO 数百次），工作台进页/轮询/刷新
// 反复触发。手法对齐 search.ts（mtime 探针 + TTL）：**每文件 mtime/size 探针**
// （方案偏离记档：只探目录集 mtime，但 overview 信封是内容写——改写既有文件不
// 触碰目录 mtime，dir-only 探针会让「直写盘后立即 GET 断言新鲜度」的既有测试（低-5
// 坏形状守卫）退化为 5s 可见窗）；TTL 5s 兜底探针不可见的变化（mtime 粒度
// 粗 / 同拍同尺寸重写 / 计算期间的外部写）。写侧另挂同文件失效点（analyze /
// analyze-style 落盘后 forgetAnalysisOverviewCache）；删书/改名生命周期清理按
// forgetBookKeyedCaches 家族约定导出（books.ts 接线不在本批允许清单内，TTL 兜底自愈）。
// 每文件 stat 签名之上再叠两级探针——第一级便宜目录指纹（见
// analysisOverviewProbe）命中即跳过签名 walk 本身（前端 3s 轮询此前每 poll 全量
// stat 重算签名）；指纹覆盖边界见该函数头注。
const ANALYSIS_OVERVIEW_TTL_MS = 5000
const ANALYSIS_OVERVIEW_MAX = 32

export interface AnalysisOverviewResult {
  scoreTrend: { 章号: number; 标题: string; score: number; dims: Record<string, number> }[]
  emotionTrend: { 章号: number; 标题: string; emotion: number; label: string }[]
  hooksTrend: { 章号: number; 标题: string; density: string; hookCount: number }[]
  allChapters: { 章号: number; docId: string }[]
  style: unknown
}
/** 2--④：缓存条目加 probeTs——探针取值时刻
 * （节流窗起点，见 getAnalysisOverviewCached；先例 snapshots.ts 同款）。
 * 条目五字段（probe/probeTs/sig/ts/value）形态随壳体
 *  收编 ttl-cache.ts 通用件（原本地 Map 删除，转写注见该件 judge）。 */
/** 收尾：__setAnalysisOverviewTtlForTest 删除——TTL 覆盖档改组装根
 * RouteOverrides 注入（getAnalysisOverviewCached 覆盖尾参，随实例隔离）。 */
/** 写侧失效挂点——analyze/analyze-style 信封落盘后调用（本文件内写路径）。 */
export function forgetAnalysisOverviewCache(bookRoot: string): void {
  analysisOverviewCache.forget(bookRoot)
}

// 登记制（模块顶层自登记）：删/改名后同名重建书不读陈分析聚合（写侧失效同函数；
// 防同名重建书读陈聚合）。本模块两缓存（style-corpus / analysis-overview）各自登记。
registerBookKeyedCache('analysis-overview', forgetAnalysisOverviewCache)
/** 钩子收敛： 2--④ 的 6 个观测钩子（__analysisOverview
 *  ScanCount/SigCount/ProbeCount 与各自 reset）连同路由层自持计数闭包一并删除——计数
 *  收编进缓存壳（ttl-cache.ts 的 stats），回归用例改读下面导出的缓存实例自身的
 *  stats/resetStats。导出实例即观测面：该对象本就是生产对象（getAnalysisOverview
 *  Cached / forgetAnalysisOverviewCache 的载体），非测试专用 API。 */

/** stat 的 size:mtimeMs 签名（缺失/占位文件 → '-'；Read 失败按缺失处理）。
 *  mtimeMs 保留亚毫秒小数（同 search.ts dirSignature 口径），降低同毫秒重写漏探针概率。
 * 本地同构副本删除——单源收编 rhythm.ts sigStatFor
 *  （overview/settings 既有 import 方同源），本文件改 import，调用点行为逐字不变。 */

/** overview 的盘面签名——manifest size:mtime + 分析目录每个 json 文件的
 *  name:size:mtime（读侧内容全部由签名覆盖：命中即跳过 manifest 整读 + 信封全读）。
 * 目录缺失/被文件占位（形态）→ 固定标记，下次仍按 miss 重算（不缓存错形状）。 */
function analysisOverviewSignature(bookRoot: string): string {
  const parts: string[] = [`m:${sigStatFor(join(bookRoot, '项目', '文档清单.jsonl'))}`]
  const analysisDir = join(bookRoot, '项目', '分析')
  let names: string[]
  try {
    names = readdirSync(analysisDir).filter((f) => f.endsWith('.json')) // 含 __book__.json（style 信封同属读面）
  } catch {
    parts.push('<unreadable>')
    return parts.join(',')
  }
  for (const f of names.sort()) {
    parts.push(`${f}:${sigStatFor(join(analysisDir, f))}`)
  }
  return parts.join(',')
}

/** analysis-overview 两级探针的第一级——便宜目录指纹（先例
 * search.ts dirSignature 的 statSync(dir).mtimeMs，按本端点全量签名的实际
 *  读面设计构成）：
 *  - manifest（项目/文档清单.jsonl）size:mtimeMs——manifest 是单文件内容写（原子
 *    rename 重写、不改父目录条目集），目录 mtime 探不到，必须以文件 stat 入指纹；
 *  - 项目/分析 目录 mtime——信封目录为平铺 json：增删改名可见；应用侧全部信封写
 *    路径（writeAnalysis/writeBookAnalysisAsync）走 atomicWriteFile 同目录 rename
 *    落盘——rename 替换目录条目会刷目录 mtime，故「重写既有信封（re-analyze）」
 * 「非 rename 的就地内容改写」（外部编辑器直写盘面）一级探针不可见，由 TTL 到期
 *  覆盖边界（如实）：目录 mtime 只反映直接子项增删/改名与同目录 rename 落盘——
 *  「非 rename 的就地内容改写」（外部编辑器直写盘面）一级探针不可见，由 TTL 到期
 * （≤5s）走第二级全量签名重算兜底（与「TTL 兜底探针不可见变化」既有口径
 * 一致；头注记档的每文件 stat 全量签名保留为第二级，就地直写的即时可见
 *  语义由两级结构共同承担）。
 */
function analysisOverviewProbe(bookRoot: string): string {
  return [
    `m:${sigStatFor(join(bookRoot, '项目', '文档清单.jsonl'))}`,
    `d:${sigStatFor(join(bookRoot, '项目', '分析'))}`,
  ].join(',')
}

/** analysis-overview 聚合查询两级探针化（每文件 mtime/size
 * 探针 + 5s TTL 缓存壳之上加便宜目录指纹）。前端 3s 轮询此前每 poll 都全量重算
 * 每文件 stat 签名（长书数百次）；现在第一级 O(1) stat（manifest + 分析目录）未变即
 * 复用，指纹变化才走第二级（原全量签名），签名仍一致（指纹抖动，如原子写
 * tmp 中间态已消失）则回填指纹复用结果。导出供回归测试直测（同 searchBookCached
 * 口径）。壳体收编 ttl-cache.ts 通用件（两级判定/
 * 顺手逐出/FIFO 时序逐位不变，转写注见该件 judge；本文件为 analysis 侧
 * 同族位）。 收尾：ttlOverrideMs = 逐调用 TTL 覆盖档（组装根
 * RouteOverrides 经 handler 传入；直测面亦可显式传——undefined = 生产口径 5s）。 */
export function getAnalysisOverviewCached(
  bookRoot: string,
  ttlOverrideMs?: number | null,
): Promise<AnalysisOverviewResult> {
  return analysisOverviewCache.get(bookRoot, undefined, ttlOverrideMs ?? undefined)
}

/** 缓存壳实例——两级探针（probe + signature）+ 异步计算 +
 * FIFO 32，见 ttl-cache.ts 头部收敛映射表。导出供回归用例读 stats()
 *  观测（探针/全量签名 计数收编在壳内，路由层计数闭包已删）。 */
export const analysisOverviewCache = createTtlProbeCache<string, AnalysisOverviewResult>({
  name: 'analysis-overview',
  keyOf: (k) => k,
  max: ANALYSIS_OVERVIEW_MAX,
  ttl: () => ANALYSIS_OVERVIEW_TTL_MS,
  probe: analysisOverviewProbe,
  signature: analysisOverviewSignature,
  computeAsync: computeAnalysisOverviewAsync,
})

/** overview 计算体（原 handler 内联逻辑原样下沉，行为不变）。
 * 改异步分批让出——readManifest 整读 + allChapters 收集为
 *  轻量同步段，与逐信封读段之间让出一次（computeProgressAsync 口径）；逐 doc
 * readAnalysisKinds 读循环每 SCAN_YIELD_EVERY（25）doc 让出一次（同款，
 *  对齐 overview/progress 既有纪律）——两级探针已把常态压 O(1)，指纹变化（保存/
 *  分析落盘后首查）即 2000 章级同步读单 tick 的问题收敛。结果与同步版逐位一致。 */
async function computeAnalysisOverviewAsync(bookRoot: string): Promise<AnalysisOverviewResult> {
  const manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  const analysisDir = join(bookRoot, '项目', '分析')

  const scoreTrend: { 章号: number; 标题: string; score: number; dims: Record<string, number> }[] = []
  const emotionTrend: { 章号: number; 标题: string; emotion: number; label: string }[] = []
  const hooksTrend: { 章号: number; 标题: string; density: string; hookCount: number }[] = []
  // 所有正文章节章号→docId 映射（供前端逐章/批量分析）
  const allChapters: { 章号: number; docId: string }[] = []

  // 先收集 allChapters（遍历 manifest 正文档档）
  for (const [id, me] of manifest.entries) {
    if (me.nodeType !== 'document' || !me.path.startsWith('写作/正文/')) continue
    const filename = me.path.split('/').pop() ?? ''
    const numMatch = filename.match(/^(\d+)-/)
    if (!numMatch) continue
    // 16+ 位数字文件名 parseInt 失真（超 2^53 浮点化）不入趋势
    // 数据——非安全整数按无章号处理（对齐 words.ts parseChapterFileName 口径）
    const 章号 = parseInt(numMatch[1]!, 10)
    if (!Number.isSafeInteger(章号)) continue
    allChapters.push({ 章号, docId: id })
  }
  allChapters.sort((a, b) => a.章号 - b.章号)
  // manifest 段与逐信封读段之间让出（段间让出口径）
  await yieldToEventLoop()

  if (existsSync(analysisDir)) {
    // existsSync→readdir 间竞态（目录被移/删）会让 ENOENT/ENOTDIR
    // 裸穿端点 500——包守卫降级为空趋势（信封缺失本就跳过，口径一致）
    let files: string[]
    try {
      files = readdirSync(analysisDir).filter((f) => f.endsWith('.json') && f !== '__book__.json')
    } catch {
      files = []
    }
    let processed = 0
    for (const file of files) {
      // 每 25 doc 让出一次（含跳过项——计数按目录条目，不按实际读数）
      if (++processed % SCAN_YIELD_EVERY === 0) await yieldToEventLoop()
      const docId = file.replace(/\.json$/, '')
      const me = manifest.entries.get(docId)
      if (!me || !me.path.startsWith('写作/正文/')) continue
      // 从文件名 NN-标题.md 提取章号/标题
      const filename = me.path.split('/').pop() ?? ''
      const numMatch = filename.match(/^(\d+)-/)
      if (!numMatch) continue
      const 章号 = parseInt(numMatch[1]!, 10)
      // 同上 allChapters 收集处——非安全整数（16+ 位数字名失真值）
      // 按无章号跳过，不入 score/emotion/hooks 趋势
      if (!Number.isSafeInteger(章号)) continue
      const 标题 = filename.replace(/^\d+-/, '').replace(/\.md$/, '')

      // 三 kind 合一次读盘（此前每 kind 各整读同一 JSON 一遍，
      // 长书 overview 同步 IO 上千次阻塞事件循环秒级）
      const envs = readAnalysisKinds(bookRoot, docId, ['score', 'emotion', 'hooks'])
      const scoreEnv = envs['score']
      if (scoreEnv?.payload) {
        // 低-5：形状守卫（对齐同函数 hooks 的 a 口径）——score 缺失/
        // 非数字、dims 非对象时跳过该章，不让坏信封把 NaN/undefined 塞进趋势
        const p = scoreEnv.payload as { score?: unknown; dims?: unknown }
        if (typeof p.score === 'number' && typeof p.dims === 'object' && p.dims !== null && !Array.isArray(p.dims)) {
          scoreTrend.push({ 章号, 标题, score: p.score, dims: p.dims as Record<string, number> })
        }
      }
      const emotionEnv = envs['emotion']
      if (emotionEnv?.payload) {
        // tool_use 后 payload 为 { segments: [...] }；兼容旧版裸数组
        // 低-5：形状守卫（对齐 hooks 的 a 口径）——segments 非数组、
        // 末段 emotion 非数字/label 非字符串时跳过该章，防 NaN 进趋势
        const raw = emotionEnv.payload
        const arr = Array.isArray(raw)
          ? (raw as { emotion: unknown; label: unknown }[])
          : Array.isArray((raw as { segments?: unknown }).segments)
            ? (raw as { segments: { emotion: unknown; label: unknown }[] }).segments
            : []
        const last = arr.length > 0 ? arr[arr.length - 1]! : undefined // 末段值（章末情绪 = 下章起点）
        if (last && typeof last.emotion === 'number' && typeof last.label === 'string') {
          emotionTrend.push({ 章号, 标题, emotion: last.emotion, label: last.label })
        }
      }
      const hooksEnv = envs['hooks']
      if (hooksEnv?.payload) {
        // a：形状守卫——坏信封（hooks 非数组/density 缺失）跳过该章，
        // 不让一章的坏数据 TypeError 拖垮整个 overview 端点
        const p = hooksEnv.payload as { hooks?: unknown; density?: unknown }
        if (Array.isArray(p.hooks) && typeof p.density === 'string') {
          hooksTrend.push({ 章号, 标题, density: p.density, hookCount: p.hooks.length })
        }
      }
    }
  }

  scoreTrend.sort((a, b) => a.章号 - b.章号)
  emotionTrend.sort((a, b) => a.章号 - b.章号)
  hooksTrend.sort((a, b) => a.章号 - b.章号)

  const styleEnv = readBookAnalysis(bookRoot, 'style')
  return { scoreTrend, emotionTrend, hooksTrend, allChapters, style: styleEnv?.payload ?? null }
}
