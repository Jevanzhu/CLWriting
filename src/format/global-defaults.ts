/**
 * 书级设定全局托底 —— global.json 13 键 + 硬编码回落（两层在 applyGlobalDefaults 合并）。
 *
 * 三层链：book.yaml 书级 → global.json（应用级全局默认）→ GLOBAL_FALLBACK_DEFAULTS（硬编码）。
 * 与快照保留策略（snapshot.ts readGlobalSnapshotPolicy + service.ts snapshotPolicy）同一范式：
 * - global.json 是 flat 键名（照 snapMaxDays 风格，camelCase，不带段嵌套）
 * - 读侧四重容错：目录未定位 / 文件不存在 / JSON 损坏 / 值非法 → 该项 undefined（上层继续回退）
 * - 合并只作用于「运行时读出的副本」，绝不写回 book.yaml——书文件里只保留作者真正设过的值，
 *   设置页靠 GET /api/books/:name/config 的 raw 结果判断「本书是否覆盖」
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BookConfig } from './types.js'

// ── 硬编码最终回落（第三层）──────────────────────
// defaultTargetWords / defaultChapterTargetWords / ragProvider 三键刻意不回落
// （无合理默认：字数目标因书而异、RAG 服务商无法凭空选）——global 没有就保持 undefined。

/** 硬编码最终回落默认（三层链最底层；键名与 global.json 的 flat 键一一对应） */
export const GLOBAL_FALLBACK_DEFAULTS: Readonly<{
  /** 题材兜底空串（=「未设题材」，前端据此引导选择） */
  defaultGenre: string
  defaultVolumeSize: number
  defaultShortStrict: boolean
  styleInjection: 'light' | 'heavy'
  autoConfirmOutline: boolean
  autoBatchSize: number
  callsPerChapter: number
  relationAutoMine: boolean
  relationMineThreshold: number
  ragEnabled: boolean
}> = {
  defaultGenre: '',
  defaultVolumeSize: 50,
  defaultShortStrict: false,
  styleInjection: 'light',
  autoConfirmOutline: false,
  autoBatchSize: 8,
  callsPerChapter: 8,
  relationAutoMine: false,
  relationMineThreshold: 3,
  ragEnabled: false,
}

/** global.json 里 13 个全局默认键的合并视图（逐键校验后的部分对象——没写的键不在场） */
export interface GlobalBookDefaults {
  defaultGenre?: string
  defaultVolumeSize?: number
  defaultTargetWords?: number
  defaultChapterTargetWords?: number
  defaultShortStrict?: boolean
  styleInjection?: 'light' | 'heavy'
  autoConfirmOutline?: boolean
  autoBatchSize?: number
  callsPerChapter?: number
  relationAutoMine?: boolean
  relationMineThreshold?: number
  ragEnabled?: boolean
  ragProvider?: string
}

/**
 * 读全局书级默认（userData/global.json）。
 *
 * 完全照 readGlobalSnapshotPolicy 的四重容错（照抄范式，不引入新故障面）：
 * 目录未定位 / 文件不存在 / JSON 损坏 / 值非法 → 该项 undefined（上层继续回退）。
 * 逐键类型校验：单键写坏不影响其余键。
 */
export function readGlobalBookDefaults(userDataPath: string | null): GlobalBookDefaults {
  if (!userDataPath) return {}
  const p = join(userDataPath, 'global.json')
  if (!existsSync(p)) return {}
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
    // 校验器：非法值 → undefined（与「没写」同义，走回落链）
    const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)
    const nonEmptyStr = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim().length > 0 ? v : undefined
    const posInt = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined
    // defaultVolumeSize：分卷章数下限 5（少于 5 章不成卷，过小值会让状态机卷判定失真）
    const intAtLeast = (v: unknown, min: number, max: number): number | undefined =>
      typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined
    const injection = (v: unknown): 'light' | 'heavy' | undefined =>
      v === 'light' || v === 'heavy' ? v : undefined
    return {
      defaultGenre: nonEmptyStr(raw['defaultGenre']),
      defaultVolumeSize: intAtLeast(raw['defaultVolumeSize'], 5, Number.MAX_SAFE_INTEGER),
      defaultTargetWords: posInt(raw['defaultTargetWords']),
      defaultChapterTargetWords: posInt(raw['defaultChapterTargetWords']),
      defaultShortStrict: bool(raw['defaultShortStrict']),
      styleInjection: injection(raw['styleInjection']),
      autoConfirmOutline: bool(raw['autoConfirmOutline']),
      autoBatchSize: intAtLeast(raw['autoBatchSize'], 1, 20),
      callsPerChapter: intAtLeast(raw['callsPerChapter'], 1, 50),
      relationAutoMine: bool(raw['relationAutoMine']),
      relationMineThreshold: intAtLeast(raw['relationMineThreshold'], 1, 20),
      ragEnabled: bool(raw['ragEnabled']),
      ragProvider: nonEmptyStr(raw['ragProvider']),
    }
  } catch {
    // JSON 损坏 / 读失败 → 全空（逐项回落第三层），不阻断调用方
    return {}
  }
}

/** applyGlobalDefaults 之后的合并视图类型：有回落值的键保证已填（喂运行时可当非空用） */
export type EffectiveBookConfig = BookConfig & {
  book: BookConfig['book'] & { genre: string; volume_size: number }
  budget: BookConfig['budget'] & { calls_per_chapter: number }
  style: { injection: 'light' | 'heavy' }
  auto: NonNullable<BookConfig['auto']> & {
    confirm_outline: boolean
    batch_size: number
    relation_auto_mine: boolean
    relation_mine_threshold: number
  }
}

/**
 * 全局默认合并（就地 mutate + 返回窄化视图；只用于运行时读出的副本，绝不写回文件）。
 *
 * 规则：只填「书级未设」的键——书级有值一律保留（本书覆盖优先）；
 * 未设时先 global 有值用 global，再 fallback 有值用 fallback。
 * 无回落的三键（targetWords/chapterTargetWords/ragProvider）：global 没有就保持 undefined。
 * 2026-08-19 起「全局固定」键（不参与书级覆盖，一律取 global → fallback，书级旧值忽略）：
 * style.injection、budget.calls_per_chapter、auto.confirm_outline、auto.batch_size——
 * 这些是作者习惯/成本/全局策略，已砍掉本书级选项。
 */
export function applyGlobalDefaults(cfg: BookConfig, userDataPath: string | null): EffectiveBookConfig {
  const g = readGlobalBookDefaults(userDataPath)

  // book 段。genre 归一为 string（未设 → global → ''）——运行时消费方要的是「有效值」
  if (!cfg.book.genre) cfg.book.genre = g.defaultGenre ?? GLOBAL_FALLBACK_DEFAULTS.defaultGenre
  if (cfg.book.volume_size === undefined) {
    cfg.book.volume_size = g.defaultVolumeSize ?? GLOBAL_FALLBACK_DEFAULTS.defaultVolumeSize
  }
  // 无回落键：global 没有就保持 undefined（调用方按「未设」处理）
  if (cfg.book.target_words === undefined) cfg.book.target_words = g.defaultTargetWords
  if (cfg.book.chapter_target_words === undefined) cfg.book.chapter_target_words = g.defaultChapterTargetWords

  // 全局固定：单章调用上限只走全局（已砍书级覆盖，书级旧值忽略）
  cfg.budget = { ...(cfg.budget ?? {}), calls_per_chapter: g.callsPerChapter ?? GLOBAL_FALLBACK_DEFAULTS.callsPerChapter }

  // 全局固定：文风注入强度只走全局（styleInjection → 'light'），不再参与书级覆盖。
  // 决策（2026-08-19）：文风注入砍掉「本书」级选项，全书统一跟随全局——书级旧值忽略，避免
  // 「设置轻、文风页重」双入口漂移（生效链唯一 = 全局，UI 双处同源）。
  cfg.style = { ...(cfg.style ?? {}), injection: g.styleInjection ?? GLOBAL_FALLBACK_DEFAULTS.styleInjection }

  // 全局固定：自动确认细纲 / 批量写作章数只走全局（已砍书级覆盖）
  cfg.auto = {
    ...(cfg.auto ?? {}),
    confirm_outline: g.autoConfirmOutline ?? GLOBAL_FALLBACK_DEFAULTS.autoConfirmOutline,
    batch_size: g.autoBatchSize ?? GLOBAL_FALLBACK_DEFAULTS.autoBatchSize,
  }
  // 关系图（自动梳理/增量阈值）仍保留书级覆盖：属于书内分析策略
  if (cfg.auto?.relation_auto_mine === undefined) {
    cfg.auto = { ...(cfg.auto ?? {}), relation_auto_mine: g.relationAutoMine ?? GLOBAL_FALLBACK_DEFAULTS.relationAutoMine }
  }
  if (cfg.auto?.relation_mine_threshold === undefined) {
    cfg.auto = { ...(cfg.auto ?? {}), relation_mine_threshold: g.relationMineThreshold ?? GLOBAL_FALLBACK_DEFAULTS.relationMineThreshold }
  }

  // short.strict：短篇集专属段，未设才回落（长篇无 short 段不强行建段）
  if (cfg.short?.strict === undefined && cfg.short !== undefined) {
    cfg.short = { ...cfg.short, strict: g.defaultShortStrict ?? GLOBAL_FALLBACK_DEFAULTS.defaultShortStrict }
  }

  // rag：enabled 未设（无 rag 段）→ global ragEnabled；provider 书级引用优先，未设才用 global
  if (cfg.rag === undefined) {
    cfg.rag = { enabled: g.ragEnabled ?? GLOBAL_FALLBACK_DEFAULTS.ragEnabled }
  }
  if (cfg.rag.provider === undefined && g.ragProvider !== undefined) {
    cfg.rag = { ...cfg.rag, provider: g.ragProvider }
  }

  return cfg as EffectiveBookConfig
}
