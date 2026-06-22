/**
 * init 题材 → 扩展账本类推荐映射（O3）+ 常量 —— 依据 M5 #30 + 母本账本总表。
 *
 * 母本第 104-112 行账本总表的「典型题材」列反向推导：
 * - 基础三类（伏笔/悬念/感情线）恒启用，不列入 leads.enabled
 * - 扩展四类（局线/设定线/成长线/关系债）按题材推荐，作者可增删
 *
 * 纯函数、零依赖、零 AI——init 第 4 步查本表推荐，非调模型。
 */

import type { BookConfig, LeadType } from '../format/types.js'

/** 基础三类（恒启用，不列入 book.yaml 的 leads.enabled） */
export const BASE_LEAD_TYPES: readonly LeadType[] = ['伏笔', '悬念', '感情线']

/** 扩展四类（按题材启用，是 leads.enabled 的合法值） */
export const EXTENDED_LEAD_TYPES: readonly LeadType[] = ['局线', '设定线', '成长线', '关系债']

/**
 * 题材关键词 → 推荐扩展账本类（O3）。
 * 关键词匹配（genre 含任一关键词即命中），据母本账本总表反推。
 * 未命中的题材回落空数组（仅基础三类）。
 */
const GENRE_LEADS_MAP: readonly { keywords: readonly string[]; leads: readonly LeadType[] }[] = [
  // 玄幻/仙侠/末世/种田/历史 → 成长线 + 设定线（力量体系 + 世界观）
  { keywords: ['玄幻', '仙侠', '修仙', '末世', '种田', '历史', '架空'], leads: ['成长线', '设定线'] },
  // 悬疑/无限流/规则怪谈/宫斗 → 局线（多线博弈）
  { keywords: ['悬疑', '推理', '无限流', '怪谈', '宫斗', '权谋', '谍战'], leads: ['局线'] },
  // 游戏/竞技 → 成长线（升级阶梯）
  { keywords: ['游戏', '竞技', '体育', '电竞'], leads: ['成长线'] },
  // 狗血言情/官场/宅斗 → 关系债（人情债/恩怨）
  { keywords: ['言情', '狗血', '官场', '宅斗', '宅院', '婆媳', '婚恋'], leads: ['关系债'] },
]

/**
 * 按题材返回推荐的扩展账本类（O3）。
 * - 关键词匹配：genre 含某组任一关键词即推荐对应扩展类（可多组叠加）
 * - 去重 + 仅返回扩展类（基础三类恒启用、不在本表）
 * - 全未命中 → 空数组（仅基础三类）
 */
export function matchGenreLeads(genre: string): LeadType[] {
  if (!genre) return []
  const matched = new Set<LeadType>()
  for (const entry of GENRE_LEADS_MAP) {
    if (entry.keywords.some((kw) => genre.includes(kw))) {
      for (const l of entry.leads) matched.add(l)
    }
  }
  // 仅保留合法扩展类（防御未来表里误混入基础类）
  return EXTENDED_LEAD_TYPES.filter((l) => matched.has(l))
}

/** 合法 leads.enabled 校验：剔除未知类、基础类（基础类恒启用不应列入 enabled） */
export function sanitizeLeadsEnabled(raw: string[]): LeadType[] {
  const ext = new Set<LeadType>(EXTENDED_LEAD_TYPES)
  const seen = new Set<LeadType>()
  const out: LeadType[] = []
  for (const r of raw) {
    const t = r as LeadType
    if (ext.has(t) && !seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

type ShortCheckConfig = NonNullable<BookConfig['short']>

const DEFAULT_SHORT_CHECKS: ShortCheckConfig = {
  profile: '通用短篇',
  word_min: 8000,
  word_max: 20000,
  body_part_threshold: 5,
  simile_threshold: 10,
  section_count: 5,
  opening_env_chars: 300,
}

const SHORT_CHECK_PRESETS: readonly {
  keywords: readonly string[]
  config: ShortCheckConfig
}[] = [
  {
    keywords: ['悬疑', '推理', '怪谈', '惊悚', '恐怖', '无限流'],
    config: {
      profile: '悬疑反转',
      word_min: 6000,
      word_max: 16000,
      body_part_threshold: 5,
      simile_threshold: 8,
      section_count: 5,
      opening_env_chars: 220,
    },
  },
  {
    keywords: ['爽文', '打脸', '反转', '复仇', '逆袭', '都市'],
    config: {
      profile: '快节奏爽点',
      word_min: 5000,
      word_max: 14000,
      body_part_threshold: 4,
      simile_threshold: 8,
      section_count: 5,
      opening_env_chars: 180,
    },
  },
  {
    keywords: ['情感', '言情', '治愈', '婚恋', '家庭', '青春'],
    config: {
      profile: '情感余韵',
      word_min: 6000,
      word_max: 18000,
      body_part_threshold: 6,
      simile_threshold: 12,
      section_count: 5,
      opening_env_chars: 360,
    },
  },
  {
    keywords: ['科幻', '奇幻', '玄幻', '仙侠', '修仙', '架空'],
    config: {
      profile: '设定奇观',
      word_min: 8000,
      word_max: 22000,
      body_part_threshold: 5,
      simile_threshold: 10,
      section_count: 5,
      opening_env_chars: 420,
    },
  },
]

/**
 * 短篇集题材 → 机检阈值推荐。
 *
 * 这是 init 的起始校准值，不是检查器硬编码；作者可继续在 book.yaml short
 * 下按平台/栏目经验调整。未命中时回落到短篇通用默认。
 */
export function recommendShortChecks(genre: string): ShortCheckConfig {
  for (const preset of SHORT_CHECK_PRESETS) {
    if (preset.keywords.some((kw) => genre.includes(kw))) return { ...preset.config }
  }
  return { ...DEFAULT_SHORT_CHECKS }
}
