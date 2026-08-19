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
import { reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { readBookConfig } from '../../../format/yaml.js'
import { applyGlobalDefaults } from '../../../format/global-defaults.js'
import type { BookConfig } from '../../../format/types.js'
import { readChapterDir } from '../../../format/chapters.js'
import { detectState, STATE_NAMES, type DetectedState } from '../../../state/state.js'
import { computeProgress } from './progress.js'
import { redactSecret } from '../../../ai/provider/redact.js' // P2-4：API 错误脱敏

interface OverviewCtx {
  workDir: string | null
  /** APP 级数据目录：genre/target_words/volume_size 喂运行时（状态机+完成度）走全局托底链 */
  userDataPath: string | null
}

// G3：state 判定结果短时缓存。detectState 内部全量 rebuild index.db（clearAllTables 清空重建），
// overview 每次请求都触发会慢（大书几百 ms~秒级）。概览页 stale 5s 可接受；精确态走 /state 或 enter。
// CC-P1-3：原单条目缓存多书交替访问永 miss（P3 观察项）——改多书 Map（key=bookRoot）+ FIFO 上限。
type StateOutput = { state: number; name: string; detail: DetectedState | { error: string } }
const stateCache = new Map<string, { result: StateOutput; ts: number }>()
const STATE_CACHE_TTL = 5000
const STATE_CACHE_MAX = 32

export function registerOverviewRoutes(ctx: OverviewCtx): void {
  route('GET', '/api/books/:name/overview', (_req: IncomingMessage, res: ServerResponse, params) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    const entry = r.entry

    const bookRoot = r.bookRoot
    // 总览喂运行时（genre 回显 / target_words 完成度 / volume_size 经状态机）：
    // readBookConfig 结果统一过 applyGlobalDefaults——书级未设回落 global.json → 硬编码
    const config = applyGlobalDefaults(
      readBookConfig(join(bookRoot, 'book.yaml')).config,
      ctx.userDataPath,
    )
    const kind = config.kind === 'short' ? 'short' : 'long'

    // 状态机（自包含；失败降级 state:0）。G3：命中短时缓存则跳过全量 rebuild
    const now = Date.now()
    let state: StateOutput
    const cachedState = stateCache.get(bookRoot)
    if (cachedState && now - cachedState.ts < STATE_CACHE_TTL) {
      state = cachedState.result
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
      // 简单 FIFO 淘汰（Map 保插入序）：超上限丢最旧条目，防长期运行的书库累积
      if (stateCache.size >= STATE_CACHE_MAX) {
        const oldest = stateCache.keys().next().value
        if (oldest !== undefined) stateCache.delete(oldest)
      }
      stateCache.set(bookRoot, { result: state, ts: now })
    }

    const timeline = computeTimeline(bookRoot)
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
      progress: withTarget(computeProgress(bookRoot), config.book.target_words),
      state,
      volumes: listVolumes(bookRoot),
      timeline,
      recentDoc: getRecentDoc(bookRoot),
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
function computeTimeline(bookRoot: string): { date: string; count: number }[] {
  const files: string[] = []
  const { chapters } = readChapterDir(join(bookRoot, '写作', '正文'))
  for (const c of chapters) if (c._path) files.push(c._path)
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
function getRecentDoc(bookRoot: string): { no: number; 标题: string; path: string } | null {
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
