/**
 * 项目总览 REST 端点（#7.2）。
 *
 * GET /api/books/:name/overview → 身份 + 进度 + 状态机位置 + 卷结构
 *
 * 状态机经 detectState（自包含：内部 rebuild index.db 幂等 + git 检查 + assembleStatus）。
 * 失败不崩（返 state:0 + 错误）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, relative } from 'node:path'
import { readdirSync, existsSync, statSync } from 'node:fs'
import { route } from '../router.js'
import { reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readBookConfig } from '../../../format/yaml.js'
import type { BookConfig } from '../../../format/types.js'
import { readChapterDir } from '../../../format/chapters.js'
import { readPieceDir } from '../../../format/pieces.js'
import { detectState, STATE_NAMES, type DetectedState } from '../../../state/state.js'
import { computeProgress } from './progress.js'
import { redactSecret } from '../../../ai/provider/redact.js' // P2-4：API 错误脱敏

interface OverviewCtx {
  workDir: string | null
}

// G3：state 判定结果短时缓存。detectState 内部全量 rebuild index.db（clearAllTables 清空重建），
// overview 每次请求都触发会慢（大书几百 ms~秒级）。概览页 stale 5s 可接受；精确态走 /state 或 enter。
type StateOutput = { state: number; name: string; detail: DetectedState | { error: string } }
interface StateEntry { bookRoot: string; result: StateOutput; ts: number }
let stateCache: StateEntry | null = null
const STATE_CACHE_TTL = 5000

export function registerOverviewRoutes(ctx: OverviewCtx): void {
  route('GET', '/api/books/:name/overview', (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const name = params['name']
    const entry = readBooks(ctx.workDir).find((b) => b.name === name)
    if (!entry) return reply(res, 404, { error: `没有这本书：${name}` })

    const bookRoot = join(ctx.workDir, entry.path)
    const { config } = readBookConfig(join(bookRoot, 'book.yaml'))
    const kind = config.kind === 'short' ? 'short' : 'long'

    // 状态机（自包含；失败降级 state:0）。G3：命中短时缓存则跳过全量 rebuild
    const now = Date.now()
    let state: StateOutput
    if (stateCache && stateCache.bookRoot === bookRoot && now - stateCache.ts < STATE_CACHE_TTL) {
      state = stateCache.result
    } else {
      try {
        const detected = detectState(bookRoot, config)
        state = { state: detected.state, name: STATE_NAMES[detected.state], detail: detected }
      } catch (e) {
        state = {
          state: 0,
          name: '状态机判定失败',
          // P2-4：API 错误脱敏
          detail: { error: redactSecret(e instanceof Error ? e.message : String(e)) },
        }
      }
      stateCache = { bookRoot, result: state, ts: now }
    }

    const timeline = computeTimeline(bookRoot, kind)
    const shortProfile = kind === 'short' ? extractShortProfile(config) : undefined
    reply(res, 200, {
      identity: {
        name: entry.name,
        kind: entry.kind,
        path: entry.path,
        ...(entry.created_at ? { created_at: entry.created_at } : {}),
        title: config.book.title,
        genre: config.book.genre,
        host: config.host ?? 'cc',
      },
      progress: withTarget(computeProgress(bookRoot, kind), config.book.target_words),
      state,
      volumes: kind === 'short' ? [] : listVolumes(bookRoot),
      timeline,
      recentDoc: getRecentDoc(bookRoot, kind),
      streak: computeStreak(timeline),
      ...(shortProfile ? { shortProfile } : {}),
    })
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
      if (!f.endsWith('.md') || f.startsWith('._')) continue
      out.push({ name: f.replace(/\.md$/, ''), path: `大纲/卷纲/${f}` })
    }
  } catch {
    // 无卷纲目录
  }
  return out
}

/**
 * 写作热力（#7.2）：已定稿文件 mtime 按日聚合（写作/正文）。
 * 返日期-计数列表供总览页日历热力图。mtime 反映定稿落盘时间（够用，git commit 时间更准但贵）。
 */
function computeTimeline(bookRoot: string, kind: 'long' | 'short'): { date: string; count: number }[] {
  const files: string[] = []
  if (kind === 'short') {
    const { pieces } = readPieceDir(join(bookRoot, '写作', '正文'))
    for (const p of pieces) if (p._path) files.push(p._path)
  } else {
    const { chapters } = readChapterDir(join(bookRoot, '写作', '正文'))
    for (const c of chapters) if (c._path) files.push(c._path)
  }
  const byDay = new Map<string, number>()
  for (const fp of files) {
    let mtime: Date
    try {
      mtime = statSync(fp).mtime
    } catch {
      continue
    }
    const day = mtime.toISOString().slice(0, 10) // YYYY-MM-DD
    byDay.set(day, (byDay.get(day) ?? 0) + 1)
  }
  return [...byDay.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** 最近一章（按章号最大）—— 供总览页"继续写作"入口 */
function getRecentDoc(bookRoot: string, kind: 'long' | 'short'): { no: number; 标题: string; path: string } | null {
  if (kind === 'short') {
    const { pieces } = readPieceDir(join(bookRoot, '写作', '正文'))
    if (pieces.length === 0) return null
    const sorted = [...pieces].sort((a, b) => (b.篇号 ?? 0) - (a.篇号 ?? 0))
    const last = sorted[0]
    if (!last?._path) return null
    return { no: last.篇号, 标题: last.标题, path: relative(bookRoot, last._path).replace(/\\/g, '/') }
  }
  const { chapters } = readChapterDir(join(bookRoot, '写作', '正文'))
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
  const cursor = new Date()
  // 今天没写 → 从昨天起算（不因"今天还没动笔"就断 streak）
  if (!dates.has(cursor.toISOString().slice(0, 10))) {
    cursor.setDate(cursor.getDate() - 1)
  }
  let streak = 0
  for (;;) {
    const dayStr = cursor.toISOString().slice(0, 10)
    if (dates.has(dayStr)) {
      streak++
      cursor.setDate(cursor.getDate() - 1)
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
