/**
 * 分析端点（M12 B0.2/B4，editor 组）：
 *
 * GET  /api/books/:name/documents/:docId/analysis/:kind
 *   → 读 项目/分析/<docId>.json 中该 kind 的信封 + stale 标志（无 AI 依赖）。
 *
 * POST /api/books/:name/documents/:docId/analyze  body {kind}
 *   → docId → 正文（strip fm）→ 组 prompt → generateTool(submit_<kind>) → 信封落盘
 *   → 信封落盘；kind ∈ {score/emotion/hooks/style}（review 走独立三审端点）。
 *
 * 信封落盘与展示解耦：AI 不可达时存量照常展示，仅「重新分析」置灰（无开关、置灰不隐藏）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, relative } from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { defineRoute } from './schema.js'
import { readJson, reply, replyError } from '../http.js'
import { resolveBook, resolveDocEntry } from '../book-context.js'
import { readManifest } from '../../../document/manifest.js' // analysis-overview 全量遍历（非 docId 单查）
import { readDraft } from '../../../format/draft.js'
import { readChapterDir } from '../../../format/chapters.js'
import type { ChapterMeta } from '../../../format/types.js'
import { readIronRules, computeFullStats, type FullStyleStats } from '../../../metrics/style.js'
import { runSpec } from '../../../ai/tasks/spec.js'
import { analysisSpec } from '../../../ai/tasks/specs.js'
import { resolveTier } from '../../../ai/provider/index.js'
import type { AnalysisKind as ContractKind } from '../../../ai/contract/index.js'
import { readAnalysis, readAnalysisKinds, writeAnalysisAsync, readBookAnalysis, writeBookAnalysisAsync, sourceHashOf, type AnalysisKind } from '../../../document/analysis.js'
import { mapAnalysisToCandidates, persistCandidates } from '../../../format/style-candidate.js'
import { localDayKey } from '../../../log/index.js' // R76-31：候选日键本地日（同 overview/日记口径）
import { safeManifestPath } from '../../../fs/safe-path.js'
import { acquireTaskGate, orchestrationBusyFor } from './task-gate.js' // RB-SV-P2-2：长任务并发闸
import { yieldToEventLoop, SCAN_YIELD_EVERY } from './progress.js' // R39-15：MISS 读循环逐块让出（R37-3 范式）

interface AnalysisCtx {
  workDir: string | null
  userDataPath: string | null
}

// 内存闸（2026-08-24 审计 D3）：analyze-style 每次全书重读正文（allBodies 数组 + join 整书
// 大串同驻）——采样正文与全文 stats 按书缓存 5s，重跑/续跑不再重扫。口径对齐 overview.ts
// stateCache：5s TTL + 书键 Map FIFO 上限；overview 无写路径失效挂点（纯 TTL），此处同口径
// ——保存/定稿后最迟 5s 自愈（envelope.sourceHash 与实际进 prompt 的采样同刻同源，不破 stale 判定）。
interface StyleCorpusResult {
  fullStats: FullStyleStats
  sampleText: string
}
const styleCorpusCache = new Map<string, { result: StyleCorpusResult; ts: number }>()
/** R67-15（十五轮）：删书/改名失效挂点（同 health.ts forgetStyleScanCache 口径）。 */
export function forgetStyleCorpusCache(bookRoot: string): void {
  styleCorpusCache.delete(bookRoot)
}
const STYLE_CORPUS_TTL = 5000
/** R62-21：与 health.ts __setStyleScanTtlForTest 同族注入点——analyze-style 走独立
 *  styleCorpusCache，d3-style-ttl 测试两处 TTL 都要压到短档，否则 analyze-style 的
 *  5s 缓存仍会让「失效」用例真实等待。仅测试用。 */
let styleCorpusTtlMs: number | null = null
export function __setStyleCorpusTtlForTest(ms: number | null): void {
  styleCorpusTtlMs = ms
}
const STYLE_CORPUS_MAX = 32

// ── R36-7（三十六轮）：analysis-overview 全书聚合 5s TTL 缓存 ─────────────────
// 端点遍历 manifest + 分析目录全部信封（长书同步 IO 数百次），工作台进页/轮询/刷新
// 反复触发。手法对齐 search.ts R35-7（mtime 探针 + TTL）：**每文件 mtime/size 探针**
// （方案偏离记档：R35-7 只探目录集 mtime，但 overview 信封是内容写——改写既有文件不
// 触碰目录 mtime，dir-only 探针会让「直写盘后立即 GET 断言新鲜度」的既有测试（低-5
// 坏形状 / R66-27 守卫）退化为 5s 可见窗）；TTL 5s 兜底探针不可见的变化（mtime 粒度
// 粗 / 同拍同尺寸重写 / 计算期间的外部写）。写侧另挂同文件失效点（analyze /
// analyze-style 落盘后 forgetAnalysisOverviewCache）；删书/改名生命周期清理按
// forgetBookKeyedCaches 家族约定导出（books.ts 接线不在本批允许清单内，TTL 兜底自愈）。
// R37-17（三十七轮）：每文件 stat 签名之上再叠两级探针——第一级便宜目录指纹（见
// analysisOverviewProbe）命中即跳过签名 walk 本身（前端 3s 轮询此前每 poll 全量
// stat 重算签名）；指纹覆盖边界见该函数头注。
const ANALYSIS_OVERVIEW_TTL_MS = 5000
const ANALYSIS_OVERVIEW_MAX = 32

interface AnalysisOverviewResult {
  scoreTrend: { 章号: number; 标题: string; score: number; dims: Record<string, number> }[]
  emotionTrend: { 章号: number; 标题: string; emotion: number; label: string }[]
  hooksTrend: { 章号: number; 标题: string; density: string; hookCount: number }[]
  allChapters: { 章号: number; docId: string }[]
  style: unknown
}
const analysisOverviewCache = new Map<string, { probe: string; result: AnalysisOverviewResult; sig: string; ts: number }>()
let analysisOverviewTtlMs: number | null = null
/** R36-7：TTL 测试注入口（先例同 __setStyleCorpusTtlForTest）。仅测试用。 */
export function __setAnalysisOverviewTtlForTest(ms: number | null): void {
  analysisOverviewTtlMs = ms
}
/** R36-7：写侧失效挂点——analyze/analyze-style 信封落盘后调用（本文件内写路径）。 */
export function forgetAnalysisOverviewCache(bookRoot: string): void {
  analysisOverviewCache.delete(bookRoot)
}
/** R36-7 回归观测钩子（生产零调用；先例同 __searchScanCountForTest）：缓存 MISS →
 *  全量重算计数。 */
let analysisOverviewScanCount = 0
export function __analysisOverviewScanCountForTest(): number {
  return analysisOverviewScanCount
}
export function __resetAnalysisOverviewScanCountForTest(): void {
  analysisOverviewScanCount = 0
}
/** R37-17（三十七轮）回归观测钩子（生产零调用）：全量签名（analysisOverviewSignature
 *  每文件 stat walk）执行计数——两级探针命中时应不再增长。 */
let analysisOverviewSigCount = 0
export function __analysisOverviewSigCountForTest(): number {
  return analysisOverviewSigCount
}
export function __resetAnalysisOverviewSigCountForTest(): void {
  analysisOverviewSigCount = 0
}

/** stat 的 size:mtimeMs 签名（缺失/占位文件 → '-'；Read 失败按缺失处理）。
 *  mtimeMs 保留亚毫秒小数（同 search.ts dirSignature 口径），降低同毫秒重写漏探针概率。 */
function sigStatFor(fp: string): string {
  try {
    const st = statSync(fp)
    return `${st.size}:${st.mtimeMs}`
  } catch {
    return '-'
  }
}

/** R36-7：overview 的盘面签名——manifest size:mtime + 分析目录每个 json 文件的
 *  name:size:mtime（读侧内容全部由签名覆盖：命中即跳过 manifest 整读 + 信封全读）。
 *  目录缺失/被文件占位（R66-27 形态）→ 固定标记，下次仍按 miss 重算（不缓存错形状）。 */
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

/** R37-17（三十七轮）：analysis-overview 两级探针的第一级——便宜目录指纹（先例
 *  search.ts R35-7 dirSignature 的 statSync(dir).mtimeMs，按本端点全量签名的实际
 *  读面设计构成）：
 *  - manifest（项目/文档清单.jsonl）size:mtimeMs——manifest 是单文件内容写（原子
 *    rename 重写、不改父目录条目集），目录 mtime 探不到，必须以文件 stat 入指纹；
 *  - 项目/分析 目录 mtime——信封目录为平铺 json：增删改名可见；应用侧全部信封写
 *    路径（writeAnalysis/writeBookAnalysisAsync）走 atomicWriteFile 同目录 rename
 *    落盘——rename 替换目录条目会刷目录 mtime，故「重写既有信封（re-analyze）」
 *    一级探针可见。
 *  覆盖边界（如实）：目录 mtime 只反映直接子项增删/改名与同目录 rename 落盘——
 *  「非 rename 的就地内容改写」（外部编辑器直写盘面）一级探针不可见，由 TTL 到期
 *  （≤5s）走第二级全量签名重算兜底（与 R36-7「TTL 兜底探针不可见变化」既有口径
 *  一致；R36-7 头注记档的每文件 stat 全量签名保留为第二级，就地直写的即时可见
 *  语义由两级结构共同承担）。
 */
function analysisOverviewProbe(bookRoot: string): string {
  return [
    `m:${sigStatFor(join(bookRoot, '项目', '文档清单.jsonl'))}`,
    `d:${sigStatFor(join(bookRoot, '项目', '分析'))}`,
  ].join(',')
}

/** R37-17（三十七轮）：analysis-overview 聚合查询两级探针化（每文件 mtime/size
 *  探针 + 5s TTL 缓存壳之上加便宜目录指纹）。前端 3s 轮询此前每 poll 都全量重算
 *  每文件 stat 签名（长书数百次）；现在第一级 O(1) stat（manifest + 目录）未变即
 *  复用，指纹变化才走第二级（R36-7 原全量签名），签名仍一致（指纹抖动，如原子写
 *  tmp 中间态已消失）则回填指纹复用结果。导出供回归测试直测（同 searchBookCached
 *  口径）。 */
export async function getAnalysisOverviewCached(bookRoot: string): Promise<AnalysisOverviewResult> {
  const now = Date.now()
  const ttl = analysisOverviewTtlMs ?? ANALYSIS_OVERVIEW_TTL_MS
  const cached = analysisOverviewCache.get(bookRoot)
  // 第一级：便宜目录指纹未变（且 TTL 内）→ 直接复用，跳过每文件 stat 签名 walk
  const probe = analysisOverviewProbe(bookRoot)
  if (cached && now - cached.ts < ttl && cached.probe === probe) {
    return cached.result
  }
  // 第二级：指纹变了才全量签名（R36-7 原口径）；签名一致 → 回填指纹、复用结果免重算
  analysisOverviewSigCount += 1
  const sig = analysisOverviewSignature(bookRoot)
  if (cached && now - cached.ts < ttl && cached.sig === sig) {
    cached.probe = probe
    return cached.result
  }
  analysisOverviewScanCount += 1
  // R44-10：MISS 计算体异步分批让出（原同步 computeAnalysisOverview 在指纹变化
  //——保存/分析落盘后首查——时 2000 章级同步读单 tick 冻结事件循环）
  const result = await computeAnalysisOverviewAsync(bookRoot)
  // 简单 FIFO 淘汰（Map 保插入序）：超上限丢最旧条目，防长期运行的书库累积
  if (analysisOverviewCache.size >= ANALYSIS_OVERVIEW_MAX) {
    const oldest = analysisOverviewCache.keys().next().value
    if (oldest !== undefined) analysisOverviewCache.delete(oldest)
  }
  // R44-10：ts 记 set 当刻 Date.now()（R42-16 口径——计算体含逐块让出跨多个 tick）
  analysisOverviewCache.set(bookRoot, { probe, sig, result, ts: Date.now() })
  return result
}

/** R36-7：overview 计算体（原 handler 内联逻辑原样下沉，行为不变）。
 *  R44-10（四十四轮）：改异步分批让出——readManifest 整读 + allChapters 收集为
 *  轻量同步段，与逐信封读段之间让出一次（computeProgressAsync 口径）；逐 doc
 *  readAnalysisKinds 读循环每 SCAN_YIELD_EVERY（25）doc 让出一次（R39-15 同款，
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
    // R43-13（四十三轮）：16+ 位数字文件名 parseInt 失真（超 2^53 浮点化）不入趋势
    // 数据——非安全整数按无章号处理（对齐 words.ts parseChapterFileName R64-20 口径）
    const 章号 = parseInt(numMatch[1]!, 10)
    if (!Number.isSafeInteger(章号)) continue
    allChapters.push({ 章号, docId: id })
  }
  allChapters.sort((a, b) => a.章号 - b.章号)
  // R44-10：manifest 段与逐信封读段之间让出（段间让出口径）
  await yieldToEventLoop()

  if (existsSync(analysisDir)) {
    // R66-27（十四轮）：existsSync→readdir 间竞态（目录被移/删）会让 ENOENT/ENOTDIR
    // 裸穿端点 500——包守卫降级为空趋势（信封缺失本就跳过，口径一致）
    let files: string[]
    try {
      files = readdirSync(analysisDir).filter((f) => f.endsWith('.json') && f !== '__book__.json')
    } catch {
      files = []
    }
    let processed = 0
    for (const file of files) {
      // R44-10：每 25 doc 让出一次（含跳过项——计数按目录条目，不按实际读数）
      if (++processed % SCAN_YIELD_EVERY === 0) await yieldToEventLoop()
      const docId = file.replace(/\.json$/, '')
      const me = manifest.entries.get(docId)
      if (!me || !me.path.startsWith('写作/正文/')) continue
      // 从文件名 NN-标题.md 提取章号/标题
      const filename = me.path.split('/').pop() ?? ''
      const numMatch = filename.match(/^(\d+)-/)
      if (!numMatch) continue
      const 章号 = parseInt(numMatch[1]!, 10)
      // R43-13（四十三轮）：同上 allChapters 收集处——非安全整数（16+ 位数字名失真值）
      // 按无章号跳过，不入 score/emotion/hooks 趋势
      if (!Number.isSafeInteger(章号)) continue
      const 标题 = filename.replace(/^\d+-/, '').replace(/\.md$/, '')

      // R69-27（十七轮）：三 kind 合一次读盘（此前每 kind 各整读同一 JSON 一遍，
      // 长书 overview 同步 IO 上千次阻塞事件循环秒级）
      const envs = readAnalysisKinds(bookRoot, docId, ['score', 'emotion', 'hooks'])
      const scoreEnv = envs['score']
      if (scoreEnv?.payload) {
        // 低-5（第十轮）：形状守卫（对齐同函数 hooks 的 X-P3a 口径）——score 缺失/
        // 非数字、dims 非对象时跳过该章，不让坏信封把 NaN/undefined 塞进趋势
        const p = scoreEnv.payload as { score?: unknown; dims?: unknown }
        if (typeof p.score === 'number' && typeof p.dims === 'object' && p.dims !== null && !Array.isArray(p.dims)) {
          scoreTrend.push({ 章号, 标题, score: p.score, dims: p.dims as Record<string, number> })
        }
      }
      const emotionEnv = envs['emotion']
      if (emotionEnv?.payload) {
        // tool_use 后 payload 为 { segments: [...] }；兼容旧版裸数组
        // 低-5（第十轮）：形状守卫（对齐 hooks 的 X-P3a 口径）——segments 非数组、
        // 末段 emotion 非数字/label 非字符串时跳过该章，防 NaN 进趋势
        const raw = emotionEnv.payload
        const arr = Array.isArray(raw)
          ? (raw as { emotion: unknown; label: unknown }[])
          : (Array.isArray((raw as { segments?: unknown }).segments)
            ? ((raw as { segments: { emotion: unknown; label: unknown }[] }).segments)
            : [])
        const last = arr.length > 0 ? arr[arr.length - 1]! : undefined // 末段值（章末情绪 = 下章起点）
        if (last && typeof last.emotion === 'number' && typeof last.label === 'string') {
          emotionTrend.push({ 章号, 标题, emotion: last.emotion, label: last.label })
        }
      }
      const hooksEnv = envs['hooks']
      if (hooksEnv?.payload) {
        // X-P3a：形状守卫——坏信封（hooks 非数组/density 缺失）跳过该章，
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

/** 跑一次 analyst 生成（runSpec 统一编排；mock 与真实同走 decode）。 */
async function runAnalyst(
  userDataPath: string | null,
  kind: ContractKind,
  prompt: string,
  bookRoot?: string,
  /** Z-1（第五十八轮）：正文/采样注入源（相对书根）——铁律①登记通道 */
  promptFiles?: string[],
): Promise<{ ok: true; payload: unknown } | { ok: false; code: string; error: string }> {
  const out = await runSpec(analysisSpec(kind), { userDataPath, bookRoot, userPrompt: prompt, promptFiles })
  if (!out.ok) return { ok: false, code: 'GEN_FAIL', error: out.error }
  if (out.data.input) return { ok: true, payload: out.data.input }
  return { ok: false, code: 'PARSE_FAIL', error: 'AI 未通过工具提交结构化结果' }
}

/** analyze 端点支持的 kind（review 走独立三审端点，不在此）。 */
const ANALYSIS_KINDS: ReadonlySet<AnalysisKind> = new Set(['score', 'emotion', 'hooks', 'style'])

const ANALYSIS_LABEL: Record<AnalysisKind, string> = {
  review: '三审汇总',
  score: '体验分',
  emotion: '情绪曲线',
  hooks: '钩子密度',
  style: '文风总结',
}

export function registerAnalysisRoutes(ctx: AnalysisCtx): void {
  // 读信封 + stale（无 AI 依赖；打开文档时读存量展示）
  defineRoute('books.documents.analysis', {
    method: 'GET',
    path: '/api/books/:name/documents/:docId/analysis/:kind',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      const bookRoot = r.bookRoot
      const docId = params['docId'] ?? ''
      const kind = (params['kind'] ?? '') as AnalysisKind
      const m = resolveDocEntry(bookRoot, docId)
      if (!m) return replyError(res, 404, 'NOT_FOUND', `文档ID未登记：${docId}`)

      const env = readAnalysis(bookRoot, docId, kind)
      if (!env) return replyError(res, 404, 'NO_ENVELOPE', '无存量分析')

      // stale：当前正文 hash 与信封 sourceHash 不符 → 过期
      const absPath = safeManifestPath(bookRoot, m.path)
      if (!absPath) return replyError(res, 400, 'BAD_PATH', '文档路径不合法')
      let stale = false
      if (existsSync(absPath)) {
        try {
          stale = isStaleEnv(env, readFileSync(absPath, 'utf-8'))
        } catch {
          stale = true
        }
      }
      reply(res, 200, { ok: true, envelope: env, stale })
    },
  })

  // 重新分析（B4.0）：kind → generateTool(submit_<kind>) → 落信封
  defineRoute('books.documents.analyze', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/analyze',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      // R67-13（十五轮）：编排互斥矩阵补角——写稿系编排在途（self-heal/对话/后台收尾）
      // 时拒收生成长任务（细纲/账本是写稿上下文注入源，在途覆盖写 = 混合态上下文）
      const busyOrch = orchestrationBusyFor(params['name']!)
      if (busyOrch) return replyError(res, 409, 'BUSY', busyOrch)
      // RB-SV-P2-2：长任务并发闸（分钟级 AI 分析，重复点击=双倍费用）
      const release = acquireTaskGate(params['name']!, 'analyze')
      if (!release) return replyError(res, 409, 'BUSY', '本书已有分析任务在跑，请等待完成后再试')
      try {
        const reqBody = await readJson(req)
        const kind = String(reqBody['kind'] ?? '').trim() as AnalysisKind
        if (!ANALYSIS_KINDS.has(kind)) {
          return replyError(res, 400, 'BAD_KIND', 'kind 需为 score/emotion/hooks/style 之一')
        }

        const bookRoot = r.bookRoot
        const docId = params['docId'] ?? ''
        const m = resolveDocEntry(bookRoot, docId)
        if (!m) return replyError(res, 404, 'NOT_FOUND', `文档ID未登记：${docId}`)
        const absPath = safeManifestPath(bookRoot, m.path)
        if (!absPath) return replyError(res, 400, 'BAD_PATH', '文档路径不合法')
        if (!existsSync(absPath)) return replyError(res, 404, 'NOT_FOUND', `文档不存在：${m.path}`)

        // R66-26（十四轮）：sourceHash 与进 prompt 的正文分两次读盘——readDraft 一读、
        // sourceHashOf(readFileSync) 二读，两读之间作者保存会让 body（进 prompt）与
        // sourceHash 对应不同稿（stale 判定错配）。仿 review.ts R63-7 同型：单次读取取
        // buffer，readDraft 经 content 吃同一快照；existsSync 后 µs 级竞态删除（R64-10 口径）
        // 的 ENOENT 由守卫转人话 500，不再裸穿 dispatch。
        let draftBuf: Buffer
        try {
          draftBuf = readFileSync(absPath)
        } catch {
          return replyError(res, 500, 'IO_ERROR', '读不到正文文件（可能已被移动或删除），请刷新后再试')
        }
        const draftText = draftBuf.toString('utf-8')
        const draft = readDraft(absPath, draftText)
        if (!draft.ok) return replyError(res, 400, 'NOT_CHAPTER', draft.reason)
        const { body, chapter } = draft
        const sourceHash = sourceHashOf(draftText)

        const prompt = buildAnalystPrompt(kind, body, chapter, bookRoot)
        const result = await runAnalyst(ctx.userDataPath, kind as ContractKind, prompt, bookRoot, [m.path])
        if (!result.ok) return replyError(res, 500, result.code, result.error)
        const payload = result.payload

        const envelope = {
          generatedAt: new Date().toISOString(),
          model: process.env['CLWRITING_DRIVER'] === 'mock' ? 'mock' : resolveTier(ctx.userDataPath, 'assistant').model,
          sourceHash, // 进 prompt 时的稿（见上）——与 payload 同源，不重读
          payload,
        }
        // R34D-19（三十四轮）：写信封走异步孪生（锁等待不阻塞服务事件循环）
        await writeAnalysisAsync(bookRoot, docId, kind, envelope)
        // R36-7：信封落盘 → overview 缓存失效（探针/TTL 兜底）
        forgetAnalysisOverviewCache(bookRoot)
        reply(res, 200, { ok: true, envelope })
      } finally {
        release()
      }
    },
  })

  // AI 章节标签识别：generateTool(submit_tags) → 结构化返回（不落信封；前端拿结果写 fm）。
  defineRoute('books.documents.autotag', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/autotag',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      // R67-13（十五轮）：编排互斥矩阵补角——写稿系编排在途（self-heal/对话/后台收尾）
      // 时拒收生成长任务（细纲/账本是写稿上下文注入源，在途覆盖写 = 混合态上下文）
      const busyOrch = orchestrationBusyFor(params['name']!)
      if (busyOrch) return replyError(res, 409, 'BUSY', busyOrch)
      // RB-SV-P2-2：长任务并发闸
      const release = acquireTaskGate(params['name']!, 'autotag')
      if (!release) return replyError(res, 409, 'BUSY', '本书已在识别章节标签，请等待完成后再试')
      try {
        const bookRoot = r.bookRoot
        const docId = params['docId'] ?? ''
        const m = resolveDocEntry(bookRoot, docId)
        if (!m) return replyError(res, 404, 'NOT_FOUND', `文档ID未登记：${docId}`)
        const absPath = safeManifestPath(bookRoot, m.path)
        if (!absPath) return replyError(res, 400, 'BAD_PATH', '文档路径不合法')
        if (!existsSync(absPath)) return replyError(res, 404, 'NOT_FOUND', `文档不存在：${m.path}`)

        const draft = readDraft(absPath)
        if (!draft.ok) return replyError(res, 400, 'NOT_CHAPTER', draft.reason)
        const { body, chapter } = draft

        const prompt = [
          '[kind:tags]',
          '',
          `## 任务\n对第 ${chapter.章号} 章正文做章节标签识别（钩子/情绪/场景），只读不改稿。`,
          '',
          `## 正文\n${body}`,
        ].join('\n')

        const result = await runAnalyst(ctx.userDataPath, 'tags', prompt, bookRoot, [m.path])
        if (!result.ok) return replyError(res, 500, result.code, result.error)
        const payload = result.payload as Record<string, unknown>

        // 校验：只保留合法选项内的字段（防 AI 产出越界值）
        const ALLOWED_TAGS: Record<string, ReadonlySet<string>> = {
          钩子类型: new Set(['危机钩', '悬念钩', '渴望钩', '情绪钩', '选择钩']),
          钩子强弱: new Set(['强', '中', '弱']),
          情绪定位: new Set(['压抑', '铺垫', '小爽', '大爽', '转折']),
          场景: new Set(['战斗', '对话', '抒情', '叙事铺陈', '爽点高潮']),
        }
        const tags: Record<string, string> = {}
        for (const key of Object.keys(ALLOWED_TAGS)) {
          const allowed = ALLOWED_TAGS[key]
          const v = String(payload[key] ?? '').trim()
          if (allowed && allowed.has(v)) tags[key] = v
        }
        reply(res, 200, { ok: true, tags })
      } finally {
        release()
      }
    },
  })

  // AI 推断目标情绪/核心反转：generateTool(submit_infer_meta) → 结构化返回（不落信封；前端写 fm）。
  // 与 autotag 同构——读正文 → AI 反推 → 返回；长短篇通用（正文 fm 均有这两字段）。
  defineRoute('books.documents.infer-meta', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/infer-meta',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      // R67-13（十五轮）：编排互斥矩阵补角——写稿系编排在途（self-heal/对话/后台收尾）
      // 时拒收生成长任务（细纲/账本是写稿上下文注入源，在途覆盖写 = 混合态上下文）
      const busyOrch = orchestrationBusyFor(params['name']!)
      if (busyOrch) return replyError(res, 409, 'BUSY', busyOrch)
      // RB-SV-P2-2：长任务并发闸
      const release = acquireTaskGate(params['name']!, 'infer-meta')
      if (!release) return replyError(res, 409, 'BUSY', '本书已在推断目标情绪，请等待完成后再试')
      try {
        const bookRoot = r.bookRoot
        const docId = params['docId'] ?? ''
        const m = resolveDocEntry(bookRoot, docId)
        if (!m) return replyError(res, 404, 'NOT_FOUND', `文档ID未登记：${docId}`)
        const absPath = safeManifestPath(bookRoot, m.path)
        if (!absPath) return replyError(res, 400, 'BAD_PATH', '文档路径不合法')
        if (!existsSync(absPath)) return replyError(res, 404, 'NOT_FOUND', `文档不存在：${m.path}`)

        const draft = readDraft(absPath)
        if (!draft.ok) return replyError(res, 400, 'NOT_CHAPTER', draft.reason)
        const { body, chapter } = draft

        const prompt = [
          '[kind:infer_meta]',
          '',
          `## 任务\n对第 ${chapter.章号} 章正文做目标情绪与核心反转识别，只读不改稿。`,
          '- 目标情绪：本章正文最终在读者心中落地的核心情绪（一句话，如「从压抑到释然的救赎」）',
          '- 核心反转：本章核心反转点（铺垫→反转→收尾一句话概述；无明显反转的章留空字符串）',
          '',
          `## 正文\n${body}`,
        ].join('\n')

        const result = await runAnalyst(ctx.userDataPath, 'infer_meta', prompt, bookRoot, [m.path])
        if (!result.ok) return replyError(res, 500, result.code, result.error)
        const payload = result.payload as { 目标情绪?: string; 核心反转?: string }

        const meta: Record<string, string> = {}
        const emotion = String(payload.目标情绪 ?? '').trim()
        const reversal = String(payload.核心反转 ?? '').trim()
        if (emotion) meta.目标情绪 = emotion
        if (reversal) meta.核心反转 = reversal
        reply(res, 200, { ok: true, meta })
      } finally {
        release()
      }
    },
  })

  // ── 全书聚合趋势：遍历 分析/<docId>.json 拼趋势序列（无 AI 依赖）──
  defineRoute('books.analysis-overview', {
    method: 'GET',
    path: '/api/books/:name/analysis-overview',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      // R36-7：mtime 探针 + 5s TTL 缓存壳（命中即跳过 manifest 整读 + 信封全读；
      // 计算体见 computeAnalysisOverviewAsync，行为与改前逐位一致）
      // R44-10：MISS 计算体异步分批让出，handler 相应 async（同文件 analyze 等
      // async handler 同款，dispatch try/catch 兜底 → 500）
      const ov = await getAnalysisOverviewCached(r.bookRoot)
      reply(res, 200, {
        ok: true,
        scoreTrend: ov.scoreTrend,
        emotionTrend: ov.emotionTrend,
        hooksTrend: ov.hooksTrend,
        style: ov.style,
        allChapters: ov.allChapters,
      })
    },
  })

  // ── 全书文风分析：全文 stats + 最近 10 章采样 → AI → __book__.json ──
  defineRoute('books.analyze-style', {
    method: 'POST',
    path: '/api/books/:name/analyze-style',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      // R67-13（十五轮）：编排互斥矩阵补角——写稿系编排在途（self-heal/对话/后台收尾）
      // 时拒收生成长任务（细纲/账本是写稿上下文注入源，在途覆盖写 = 混合态上下文）
      const busyOrch = orchestrationBusyFor(params['name']!)
      if (busyOrch) return replyError(res, 409, 'BUSY', busyOrch)
      // RB-SV-P2-2：长任务并发闸（全书文风分析采样多章，耗时最长）
      const release = acquireTaskGate(params['name']!, 'analyze-style')
      if (!release) return replyError(res, 409, 'BUSY', '本书正在做文风分析，请等待完成后再试')
      try {
        const bookRoot = r.bookRoot

        // 读所有定稿正文章节（按章号排序）
        const { chapters } = readChapterDir(join(bookRoot, '写作', '正文'))
        const sorted = chapters.slice().sort((a, b) => a.章号 - b.章号)
        if (!sorted.length) return replyError(res, 400, 'NO_CHAPTERS', '无定稿正文章节')

        // 全文 stats（所有正文字符合并扫描）+ 最近 10 章采样正文
        const rules = readIronRules(bookRoot)
        const recent = sorted.slice(-10)
        // D3：命中短时缓存则跳过全书重读（allBodies+join 的重扫）；章集/正文变化最迟 5s 可见
        const now = Date.now()
        const cached = styleCorpusCache.get(bookRoot)
        let fullStats: FullStyleStats
        let sampleText: string
        if (cached && now - cached.ts < (styleCorpusTtlMs ?? STYLE_CORPUS_TTL)) { // R62-21：测试注入优先
          ;({ fullStats, sampleText } = cached.result)
        } else {
          const allBodies: string[] = []
          const recentBodies: string[] = []
          // R39-15（三十九轮）：读循环每 SCAN_YIELD_EVERY（25）章让出一次事件循环——
          // 此前 MISS 时同步逐章整读 + 全书 join，数百万字大书上单请求冻结事件循环
          // 1-3s（全部书的 SSE 心跳/保存停摆）；对齐 R37-3 在 search/overview/progress
          // 的逐块让出范式。computeFullStats 仍为单段同步 CPU（全书全文正则 stats），
          // 下沉 worker 改动面大——登记维持，缓存命中路径（D3）不受影响。
          let scanned = 0
          for (const ch of sorted) {
            if (!ch._path) continue
            const draft = readDraft(ch._path)
            if (!draft.ok) continue
            allBodies.push(draft.body)
            if (recent.includes(ch)) {
              recentBodies.push(`### 第${ch.章号}章 ${ch.标题}\n\n${draft.body}`)
            }
            if (++scanned % SCAN_YIELD_EVERY === 0) await yieldToEventLoop()
          }
          fullStats = computeFullStats(allBodies.join('\n\n'), rules)
          sampleText = recentBodies.join('\n\n---\n\n')
          // 简单 FIFO 淘汰（Map 保插入序）：超上限丢最旧条目，防长期运行的书库累积
          if (styleCorpusCache.size >= STYLE_CORPUS_MAX) {
            const oldest = styleCorpusCache.keys().next().value
            if (oldest !== undefined) styleCorpusCache.delete(oldest)
          }
          // R42-16（四十二轮）：ts 记 set 当刻 Date.now()——MISS 分支的读循环含逐块让出
          //（每 25 章一次 setImmediate），大书扫描可跨数百 ms；此前记扫描前取的 now，
          // 缓存「出生即折旧」TTL 窗被扫描时长吃掉，极端时刚 set 完就已过期。
          styleCorpusCache.set(bookRoot, { result: { fullStats, sampleText }, ts: Date.now() })
        }

        const prompt = [
          '[kind:style]',
          '',
          `## 任务\n对全书最近 ${recent.length} 章做文风总结分析（口癖/重复度/漂移），只读不改稿。`,
          '',
          `## 全文本地 stats（全文 ${sorted.length} 章扫描）\n${JSON.stringify(fullStats)}`,
          '',
          `## IronRules（作者基线铁律）\n${JSON.stringify(rules)}`,
          '',
          `## 最近 ${recent.length} 章采样正文\n${sampleText}`,
        ].join('\n')

        // Z-1（第五十八轮）：全书采样注入源登记（相对书根；readChapterDir 的 _path 为绝对路径）
        const styleSources = recent
          .filter((ch) => ch._path)
          .map((ch) => relative(bookRoot, ch._path!).replace(/\\/g, '/'))
        const result = await runAnalyst(ctx.userDataPath, 'style', prompt, bookRoot, styleSources)
        if (!result.ok) return replyError(res, 500, result.code, result.error)
        const payload = result.payload

        const envelope = {
          generatedAt: new Date().toISOString(),
          model: process.env['CLWRITING_DRIVER'] === 'mock' ? 'mock' : resolveTier(ctx.userDataPath, 'assistant').model,
          sourceHash: sourceHashOf(sampleText),
          payload,
        }
        // R36-4（三十六轮）：全书信封落盘走异步孪生——锁等待 setTimeout 轮询不阻塞事件
        // 循环（原同步版 Atomics.wait ≤5s 冻结整进程，见 document/analysis.ts 头注）
        await writeBookAnalysisAsync(bookRoot, 'style', envelope)
        // R36-7：全书信封落盘 → overview 缓存失效（探针/TTL 兜底）
        forgetAnalysisOverviewCache(bookRoot)

        // 源3 接线（文风系统重整）：口癖→禁词候选、建议→手法候选；查重闸防重复骚扰
        let styleCandidates = 0
        if (typeof payload === 'object' && payload !== null) {
          const mapped = mapAnalysisToCandidates(
            payload as { 口癖?: string[]; 建议?: string[] },
            // R76-31：候选日键本地日——与 style.ts today()/overview 热力图同口径（此前
            // UTC 切日，东八区 0-8 点生成的候选记前一日，查重闸跨日误放行）
            localDayKey(new Date()),
          )
          styleCandidates = persistCandidates(bookRoot, mapped).created.length
        }
        reply(res, 200, { ok: true, envelope, styleCandidates })
      } finally {
        release()
      }
    },
  })
}

/** 组 analyst prompt（`[kind:x]` 标记供 mock 分发；附正文 + 该 kind JSON 契约 + 章纲/stats 为底）。 */
function buildAnalystPrompt(
  kind: AnalysisKind,
  body: string,
  chapter: ChapterMeta,
  bookRoot: string,
): string {
  const parts: string[] = [
    `[kind:${kind}]`,
    '',
    `## 任务\n对第 ${chapter.章号} 章正文做${ANALYSIS_LABEL[kind]}分析，只读不改稿。`,
  ]
  // 各 kind 附「规则版为底」（章纲 fm 声明 / 本地 stats），AI 据此补识别/评价
  if (kind === 'emotion') {
    parts.push('', `## 章纲声明目标情绪\n${chapter.情绪定位}`)
  } else if (kind === 'hooks') {
    parts.push('', `## 章纲声明钩子\n类型：${chapter.钩子类型}；强弱：${chapter.钩子强弱}`)
  } else if (kind === 'style') {
    // 附本地文风 stats（句长/重复率/口癖命中）+ IronRules（作者基线铁律）为底
    const rules = readIronRules(bookRoot)
    const stats = computeFullStats(body, rules)
    parts.push('', `## 本地文风 stats\n${JSON.stringify(stats)}`, '', `## IronRules（作者基线铁律）\n${JSON.stringify(rules)}`)
  }
  parts.push('', `## 正文\n${body}`)
  return parts.join('\n')
}

/** 信封过期判定（sourceHash 与当前正文不符）。内联别名，避免循环依赖 document/analysis 全量引入。 */
function isStaleEnv(envelope: { sourceHash: string }, fullContent: string): boolean {
  return envelope.sourceHash !== sourceHashOf(fullContent)
}
