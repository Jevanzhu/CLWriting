/**
 * 章节节奏 REST 端点（#7.4 双轨：规划 vs 已写，块4 节奏预测）。
 *
 * GET /api/books/:name/rhythm → 长篇(wordCurve + written/planned 双轨分布) / 短篇(章长+目标情绪)
 *
 * 双轨数据源：readChapterDir 读 写作/正文（已写实际）+ 大纲/章纲（块3.1 录入规划）。
 * planned.targetWords 求和自 ChapterMeta.字数目标。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { defineRoute } from './schema.js'
import { reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { readBookConfig } from '../../../format/yaml.js'
import { readChapterDir } from '../../../format/chapters.js'
import type { HookType, HookLevel, Emotion, SceneType, ChapterMeta, BookConfig } from '../../../format/types.js'
import { classifyReversal } from '../../../format/reversal-types.js'

interface RhythmCtx {
  workDir: string | null
}

const HOOK_TYPES: readonly HookType[] = ['危机钩', '悬念钩', '渴望钩', '情绪钩', '选择钩']
const HOOK_LEVELS: readonly HookLevel[] = ['强', '中', '弱']
const EMOTIONS: readonly Emotion[] = ['压抑', '铺垫', '小爽', '大爽', '转折']
const SCENE_TYPES: readonly SceneType[] = ['战斗', '对话', '抒情', '叙事铺陈', '爽点高潮']

// ── R44-8（四十四轮）：rhythm 全书扫描「目录指纹 + TTL」缓存壳 ────────────────
// 手法对齐 search.ts R35-7（探针 + 纯 TTL + FIFO 上限 + 书键 forget 挂点）：端点原
// 每请求 readBookConfig + rhythmLong 双 readChapterDir（写作/正文 + 大纲/章纲）——
// 章节元数据虽有 CC-P1-3 stat 级缓存，冷路径（首查/有章变更）仍整读全部章节全文，
// 节奏面板打开/轮询/切换反复触发。指纹按本端点实际读面构成（versionStatsProbe
// R37-17 同思路）：book.yaml size:mtime（kind 决定响应形状，单文件内容写不改目录
// mtime，必须以文件 stat 入指纹）+ 写作/正文、大纲/章纲 两目录 mtime（增删改名/
// 同目录 rename 落盘可见）；目录内就地内容改写由 TTL 5s 兜底（宁多扫不脏读）。
// 计算是同步单段（无在途并发窗口），缓存壳取 getVersionStatsCached 同款同步形态。
const RHYTHM_CACHE_TTL_MS = 5000
const RHYTHM_CACHE_MAX = 32
const rhythmCache = new Map<string, { result: unknown; ts: number; sig: string }>()
let rhythmTtlMs: number | null = null
/** R44-8：TTL 测试注入口（先例同 __setSearchCacheTtlForTest）。仅测试用。 */
export function __setRhythmCacheTtlForTest(ms: number | null): void {
  rhythmTtlMs = ms
}
/** R44-8：删书/改名失效挂点（books.ts forgetBookKeyedCaches 家族同款）。 */
export function forgetRhythmCache(bookRoot: string): void {
  rhythmCache.delete(bookRoot)
}
/** R44-8 回归观测钩子（生产零调用；先例同 __searchScanCountForTest）：缓存 MISS →
 *  全量重算（readBookConfig + readChapterDir×2）计数。 */
let rhythmScanCount = 0
export function __rhythmScanCountForTest(): number {
  return rhythmScanCount
}
export function __resetRhythmScanCountForTest(): void {
  rhythmScanCount = 0
}

/** stat 的 size:mtimeMs 签名（缺失 → '-'；先例同 snapshots.ts sigStatFor）。 */
function rhythmSigStatFor(fp: string): string {
  try {
    const st = statSync(fp)
    return `${st.size}:${st.mtimeMs}`
  } catch {
    return '-'
  }
}

/** rhythm 读面指纹：book.yaml + 写作/正文 + 大纲/章纲。 */
function rhythmSignature(bookRoot: string): string {
  return [
    rhythmSigStatFor(join(bookRoot, 'book.yaml')),
    (() => {
      try {
        return String(statSync(join(bookRoot, '写作', '正文')).mtimeMs)
      } catch {
        return '-'
      }
    })(),
    (() => {
      try {
        return String(statSync(join(bookRoot, '大纲', '章纲')).mtimeMs)
      } catch {
        return '-'
      }
    })(),
  ].join(',')
}

/** R44-8：rhythm 聚合查询（目录指纹 + TTL 缓存壳）。导出供回归测试直测。 */
export function getRhythmCached(bookRoot: string): unknown {
  const sig = rhythmSignature(bookRoot)
  const cached = rhythmCache.get(bookRoot)
  if (cached && cached.sig === sig && Date.now() - cached.ts < (rhythmTtlMs ?? RHYTHM_CACHE_TTL_MS)) {
    return cached.result
  }
  rhythmScanCount += 1
  const { config } = readBookConfig(join(bookRoot, 'book.yaml'))
  const result: unknown = config.kind === 'short' ? rhythmShort(bookRoot, config) : rhythmLong(bookRoot)
  // 简单 FIFO 淘汰（Map 保插入序）：超上限丢最旧条目，防长期运行的书库累积
  if (rhythmCache.size >= RHYTHM_CACHE_MAX) {
    const oldest = rhythmCache.keys().next().value
    if (oldest !== undefined) rhythmCache.delete(oldest)
  }
  rhythmCache.set(bookRoot, { result, ts: Date.now(), sig })
  return result
}

export function registerRhythmRoutes(ctx: RhythmCtx): void {
  defineRoute('books.rhythm', {
    method: 'GET',
    path: '/api/books/:name/rhythm',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)

    // R44-8：全书扫描走缓存壳（命中即跳过 readBookConfig + 双 readChapterDir）
    reply(res, 200, getRhythmCached(r.bookRoot))
  },
  })
}

function rhythmLong(bookRoot: string): unknown {
  const { chapters: written } = readChapterDir(join(bookRoot, '写作', '正文'))
  const { chapters: planned } = readChapterDir(join(bookRoot, '大纲', '章纲'))
  const sorted = written.slice().sort((a, b) => a.章号 - b.章号)
  const wordCurve = sorted.map((c) => ({ 章号: c.章号, 标题: c.标题, 字数: c._wordCount ?? 0 }))
  const totalWords = wordCurve.reduce((s, p) => s + p.字数, 0)
  const avgWords = wordCurve.length ? Math.round(totalWords / wordCurve.length) : 0
  return {
    kind: 'long' as const,
    wordCurve,
    avgWords,
    // 已写节奏（写作/正文）
    written: {
      count: written.length,
      hookTypeDist: countDist(written.map((c) => c.钩子类型), HOOK_TYPES),
      hookLevelDist: countDist(written.map((c) => c.钩子强弱), HOOK_LEVELS),
      emotionDist: countDist(written.map((c) => c.情绪定位), EMOTIONS),
      sceneDist: countDist(written.map((c) => c.场景), SCENE_TYPES),
      // 场景 × 情绪增强矩阵（#7.4 增强区）
      sceneEmotion: crossCount(written, SCENE_TYPES, EMOTIONS, (c) => c.场景, (c) => c.情绪定位),
    },
    // 规划节奏（大纲/章纲，块4 节奏预测）
    planned: {
      count: planned.length,
      targetWords: planned.reduce((s, c) => s + (c.字数目标 ?? 0), 0),
      hookTypeDist: countDist(planned.map((c) => c.钩子类型), HOOK_TYPES),
      hookLevelDist: countDist(planned.map((c) => c.钩子强弱), HOOK_LEVELS),
      emotionDist: countDist(planned.map((c) => c.情绪定位), EMOTIONS),
      sceneDist: countDist(planned.map((c) => c.场景), SCENE_TYPES),
    },
    // 逐章偏差（D3：章纲↔定稿按章号 join，钩子/情绪/场景跑偏标红）
    chapterDiff: buildChapterDiff(written, planned),
  }
}

function rhythmShort(bookRoot: string, config: BookConfig): unknown {
  const { chapters } = readChapterDir(join(bookRoot, '写作', '正文'))
  const sorted = chapters.slice().sort((a, b) => a.章号 - b.章号)
  // 连续故事：有钩子字段 → 附带节奏分布数据（独立短篇无钩子字段 → 不附带）
  const hasHookData = chapters.some((c) => c.钩子类型 || c.情绪定位 || c.场景)
  return {
    kind: 'short' as const,
    wordCurve: sorted.map((c) => ({ 章号: c.章号, 标题: c.标题, 字数: c._wordCount ?? 0 })),
    emotionDist: countDynamic(chapters.map((c) => c.目标情绪)),
    reversalGap: buildReversalGap(chapters, config),
    reversalUnrecognized: countUnrecognized(chapters, config),
    reversals: chapters
      .filter((c) => c.核心反转)
      .map((c) => ({ 章号: c.章号, 标题: c.标题, 核心反转: c.核心反转! })),
    ...(hasHookData
      ? {
          written: {
            count: chapters.length,
            hookTypeDist: countDist(chapters.map((c) => c.钩子类型), HOOK_TYPES),
            hookLevelDist: countDist(chapters.map((c) => c.钩子强弱), HOOK_LEVELS),
            emotionDist: countDist(chapters.map((c) => c.情绪定位), EMOTIONS),
            sceneDist: countDist(chapters.map((c) => c.场景), SCENE_TYPES),
          },
        }
      : {}),
  }
}

/**
 * 反转类型覆盖缺口（#阶段6 反转缺口）：画像目标池 vs 已写章的核心反转归类。
 * 归类走本地关键词规则（format/reversal-types，派生数据不落盘）。
 * 只统计画像池内的类型；未识别章数单独透出（reversalUnrecognized）。
 */
function buildReversalGap(
  pieces: { 核心反转?: string }[],
  config: BookConfig,
): {
  type: string
  count: number
  missing: boolean
}[] {
  const targets = config.short?.target_reversal_types ?? []
  if (targets.length === 0) return []
  const counts = new Map<string, number>()
  for (const p of pieces) {
    if (!p.核心反转) continue
    const hit = classifyReversal(p.核心反转!)
    if (hit && targets.includes(hit)) {
      counts.set(hit, (counts.get(hit) ?? 0) + 1)
    }
  }
  return targets.map((type) => ({
    type,
    count: counts.get(type) ?? 0,
    missing: (counts.get(type) ?? 0) === 0,
  }))
}

/** 未归类章数：核心反转存在但分类未命中画像池（规则覆盖不到 / 池外类型） */
function countUnrecognized(pieces: { 核心反转?: string }[], config: BookConfig): number {
  const targets = config.short?.target_reversal_types ?? []
  if (targets.length === 0) return 0
  let n = 0
  for (const p of pieces) {
    if (!p.核心反转) continue
    const hit = classifyReversal(p.核心反转!)
    if (!hit || !targets.includes(hit)) n++
  }
  return n
}

/** 固定枚举分布（按枚举顺序，缺项补 0） */
function countDist<T extends string>(values: (T | undefined)[], keys: readonly T[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const k of keys) out[k] = 0
  for (const v of values) {
    if (v) out[v] = (out[v] ?? 0) + 1
  }
  return out
}

/** 动态 key 分布（短篇目标情绪是自由 string） */
function countDynamic(values: (string | undefined)[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const v of values) {
    if (!v) continue
    out[v] = (out[v] ?? 0) + 1
  }
  return out
}

/** 交叉分布矩阵（#7.4 增强区：场景 × 情绪） */
function crossCount<T, R extends string, C extends string>(
  items: T[],
  rowKeys: readonly R[],
  colKeys: readonly C[],
  rowOf: (t: T) => R | undefined,
  colOf: (t: T) => C | undefined,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  for (const r of rowKeys) {
    out[r] = {}
    for (const c of colKeys) out[r]![c] = 0
  }
  for (const it of items) {
    const r = rowOf(it)
    const c = colOf(it)
    if (r && c && out[r]) out[r]![c]! += 1
  }
  return out
}

// ── 逐章偏差（D3：章纲规划 ↔ 定稿实际 按章号 join）──────────

/** 逐章偏差行：状态 待写(只规划)/即兴(只实际)/对比(两边有)；对比时字段 "规→实"，跑偏标偏差。 */
export interface ChapterDiffRow {
  章号: number
  标题: string
  状态: '待写' | '即兴' | '对比'
  /** 对比时 "规划→实际"；待写/即兴为单值 */
  钩子类型?: string
  钩子类型偏差?: boolean
  情绪定位?: string
  情绪定位偏差?: boolean
  场景?: string
  场景偏差?: boolean
  /** "目标/实际"（目标←章纲字数目标，实际←定稿正文字数） */
  字数?: string
}

/** 章纲规划 ↔ 定稿实际 按章号 join → 逐章偏差行（章号升序）。 */
function buildChapterDiff(written: ChapterMeta[], planned: ChapterMeta[]): ChapterDiffRow[] {
  const m = new Map<number, { w?: ChapterMeta; p?: ChapterMeta }>()
  for (const w of written) {
    const e = m.get(w.章号) ?? {}
    e.w = w
    m.set(w.章号, e)
  }
  for (const p of planned) {
    const e = m.get(p.章号) ?? {}
    e.p = p
    m.set(p.章号, e)
  }
  const rows: ChapterDiffRow[] = []
  for (const 章号 of [...m.keys()].sort((a, b) => a - b)) {
    const { w, p } = m.get(章号)!
    if (w && p) {
      rows.push({
        章号,
        标题: p.标题 || w.标题 || `第${章号}章`,
        状态: '对比',
        钩子类型: diffText(p.钩子类型, w.钩子类型),
        钩子类型偏差: isDiff(p.钩子类型, w.钩子类型),
        情绪定位: diffText(p.情绪定位, w.情绪定位),
        情绪定位偏差: isDiff(p.情绪定位, w.情绪定位),
        场景: diffText(p.场景, w.场景),
        场景偏差: isDiff(p.场景, w.场景),
        字数:
          p.字数目标 != null || w._wordCount != null
            ? `${p.字数目标 ?? '—'}/${w._wordCount ?? '—'}`
            : undefined,
      })
    } else if (p) {
      rows.push({
        章号,
        标题: p.标题 || `第${章号}章`,
        状态: '待写',
        钩子类型: p.钩子类型,
        情绪定位: p.情绪定位,
        场景: p.场景,
        字数: p.字数目标 != null ? String(p.字数目标) : undefined,
      })
    } else if (w) {
      rows.push({
        章号,
        标题: w.标题 || `第${章号}章`,
        状态: '即兴',
        钩子类型: w.钩子类型,
        情绪定位: w.情绪定位,
        场景: w.场景,
        字数: w._wordCount != null ? String(w._wordCount) : undefined,
      })
    }
  }
  return rows
}

/** 两边都填且不同 → 偏差（一边缺数据不报警） */
function isDiff(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a !== b
}
/** 对比文本：两边都填且不同 "规→实"；一致或单边 → 该值；都空 → undefined */
function diffText(a: string | undefined, b: string | undefined): string | undefined {
  if (a && b) return a === b ? a : `${a}→${b}`
  return a ?? b
}
