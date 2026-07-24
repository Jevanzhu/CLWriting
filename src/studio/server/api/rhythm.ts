/**
 * 章节节奏 REST 端点（#7.4 双轨：规划 vs 已写，块4 节奏预测）。
 *
 * GET /api/books/:name/rhythm → 长篇(wordCurve + written/planned 双轨分布) / 短篇(篇长+目标情绪)
 *
 * 双轨数据源：readChapterDir 读 定稿/正文（已写实际）+ 大纲/章纲（块3.1 录入规划）。
 * planned.targetWords 求和自 ChapterMeta.字数目标。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { route } from '../router.js'
import { reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readBookConfig } from '../../../format/yaml.js'
import { readChapterDir } from '../../../format/chapters.js'
import { readPieceDir } from '../../../format/pieces.js'
import type { HookType, HookLevel, Emotion, SceneType } from '../../../format/types.js'

interface RhythmCtx {
  workDir: string | null
}

const HOOK_TYPES: readonly HookType[] = ['危机钩', '悬念钩', '渴望钩', '情绪钩', '选择钩']
const HOOK_LEVELS: readonly HookLevel[] = ['强', '中', '弱']
const EMOTIONS: readonly Emotion[] = ['压抑', '铺垫', '小爽', '大爽', '转折']
const SCENE_TYPES: readonly SceneType[] = ['战斗', '对话', '抒情', '叙事铺陈', '爽点高潮']

export function registerRhythmRoutes(ctx: RhythmCtx): void {
  route('GET', '/api/books/:name/rhythm', (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const name = params['name']
    const entry = readBooks(ctx.workDir).find((b) => b.name === name)
    if (!entry) return reply(res, 404, { error: `没有这本书：${name}` })

    const bookRoot = join(ctx.workDir, entry.path)
    const { config } = readBookConfig(join(bookRoot, 'book.yaml'))
    reply(res, 200, config.kind === 'short' ? rhythmShort(bookRoot) : rhythmLong(bookRoot))
  })
}

function rhythmLong(bookRoot: string): unknown {
  const { chapters: written } = readChapterDir(join(bookRoot, '定稿', '正文'))
  const { chapters: planned } = readChapterDir(join(bookRoot, '大纲', '章纲'))
  const sorted = written.slice().sort((a, b) => a.章号 - b.章号)
  const wordCurve = sorted.map((c) => ({ 章号: c.章号, 标题: c.标题, 字数: c._wordCount ?? 0 }))
  const totalWords = wordCurve.reduce((s, p) => s + p.字数, 0)
  const avgWords = wordCurve.length ? Math.round(totalWords / wordCurve.length) : 0
  return {
    kind: 'long' as const,
    wordCurve,
    avgWords,
    // 已写节奏（定稿/正文）
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
  }
}

function rhythmShort(bookRoot: string): unknown {
  const { pieces } = readPieceDir(join(bookRoot, '篇'))
  const sorted = pieces.slice().sort((a, b) => a.篇号 - b.篇号)
  return {
    kind: 'short' as const,
    wordCurve: sorted.map((p) => ({ 篇号: p.篇号, 标题: p.标题, 字数: p._wordCount ?? 0 })),
    emotionDist: countDynamic(pieces.map((p) => p.目标情绪)),
    reversals: pieces
      .filter((p) => p.核心反转)
      .map((p) => ({ 篇号: p.篇号, 标题: p.标题, 核心反转: p.核心反转! })),
  }
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
