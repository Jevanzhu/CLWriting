/**
 * 对话工具的作者可见面：中文名 + 风险 + 参数摘要。
 *
 * 为什么独立成模块：确认卡是 AI 写操作唯一的人工关卡，作者放行前必须看到「对哪一章、
 * 做什么、改成什么样」，而不是英文内部名。展示逻辑放契约侧（与 chat.ts 的工具清单
 * 同层），前端只负责渲染与章名解析——工具清单与展示口径从此只有一份。
 *
 * 摘要函数是纯函数：入参是工具 input（形状由模型产出，不可信），出参是短句。
 * 章名解析经注入的 chapterName 回调（前端用章节树解析，测试直接传映射），本模块
 * 不依赖前端 store，也不读盘。
 */
import { codePointLength, clipByCodePoints } from '../../shared/text.js'

/** 工具风险分级（与 chat.ts TOOL_RISK 同义） */
export type ToolRisk = 'readonly' | 'write'

/** 章号 → 作者可见章名（如「第 12 章 北境的雪」）。解析不到返回 null，摘要回落「第 N 章」。 */
export type ChapterNameLookup = (chapter: number) => string | null

/** 单个工具的作者可见面 */
export interface ToolMeta {
  /** 中文名（卡片标题） */
  label: string
  /** 风险分级（write = 须作者确认） */
  risk: ToolRisk
  /** 参数摘要：作者放行前要核对的那句话。无参工具返回空串。 */
  summarize: (input: unknown, chapterName: ChapterNameLookup) => string
}

/** 摘要里自由文本的截断上限（码位）——指令/选段可能是整章正文 */
const TEXT_CLIP = 60

/** 正整数章号（模型入参不可信：字符串/小数/负数一律不算） */
function chapterOf(input: unknown): number | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const v = (input as Record<string, unknown>)['chapter']
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null
}

/** 字符串字段（非字符串/空串 → null） */
function strField(input: unknown, key: string): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const v = (input as Record<string, unknown>)[key]
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

/** 章号的作者可见称呼：树里解析到章名用之，否则「第 N 章」；没有章号则空串 */
function chapterLabel(input: unknown, chapterName: ChapterNameLookup): string {
  const n = chapterOf(input)
  if (n === null) return ''
  return chapterName(n) ?? `第 ${n} 章`
}

/** 自由文本截断（按码点，尾标 …） */
function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return codePointLength(flat) > TEXT_CLIP ? clipByCodePoints(flat, TEXT_CLIP) + '…' : flat
}

/** 「目标章：<章名>」前缀；无章号时省略（摘要其余部分照常展示） */
function withChapter(input: unknown, chapterName: ChapterNameLookup, rest: string): string {
  const label = chapterLabel(input, chapterName)
  if (!label) return rest
  return rest ? `${label}：${rest}` : label
}

/** 只带章号的工具（写章/复制/删除/账本推进） */
function chapterOnly(input: unknown, chapterName: ChapterNameLookup): string {
  return chapterLabel(input, chapterName)
}

export const TOOL_META: Record<string, ToolMeta> = {
  check_chapter: { label: '机检', risk: 'readonly', summarize: chapterOnly },
  read_chapter: { label: '读取章节', risk: 'readonly', summarize: chapterOnly },
  read_skill: {
    label: '读取技巧包',
    risk: 'readonly',
    summarize: (input) => {
      const name = strField(input, 'name')
      return name ? `技巧包「${clip(name)}」` : ''
    },
  },
  book_search: {
    label: '全书搜索',
    risk: 'readonly',
    summarize: (input) => {
      const query = strField(input, 'query')
      if (!query) return ''
      const scope = strField(input, 'scope')
      return scope && scope !== 'all' ? `搜索「${clip(query)}」（范围：${clip(scope)}）` : `搜索「${clip(query)}」`
    },
  },
  chapter_status: { label: '全书近况', risk: 'readonly', summarize: () => '' },
  write_chapter: { label: '自动写章', risk: 'write', summarize: chapterOnly },
  move_chapter: {
    label: '移动章节',
    risk: 'write',
    summarize: (input, chapterName) => withChapter(input, chapterName, strField(input, 'toDir') ? `移到「${clip(strField(input, 'toDir')!)}」` : ''),
  },
  rename_chapter: {
    label: '重命名章节',
    risk: 'write',
    summarize: (input, chapterName) => withChapter(input, chapterName, strField(input, 'newTitle') ? `改为「${clip(strField(input, 'newTitle')!)}」` : ''),
  },
  copy_chapter: { label: '复制章节', risk: 'write', summarize: chapterOnly },
  delete_chapter: { label: '删除章节（移入回收站）', risk: 'write', summarize: chapterOnly },
  rewrite_chapter: {
    label: '改写整章',
    risk: 'write',
    summarize: (input, chapterName) => withChapter(input, chapterName, strField(input, 'instruction') ? `指令：${clip(strField(input, 'instruction')!)}` : ''),
  },
  rewrite_selection: {
    label: '改写选段',
    risk: 'write',
    summarize: (input, chapterName) => {
      const parts: string[] = []
      const selection = strField(input, 'selection')
      if (selection) parts.push(`原文：${clip(selection)}`)
      const instruction = strField(input, 'instruction')
      if (instruction) parts.push(`指令：${clip(instruction)}`)
      return withChapter(input, chapterName, parts.join('；'))
    },
  },
  apply_spill: {
    label: '落盘改写稿',
    risk: 'write',
    summarize: (input, chapterName) => withChapter(input, chapterName, strField(input, 'locator') ? `来源「${clip(strField(input, 'locator')!)}」` : ''),
  },
  lead_update: { label: '生成账本推进', risk: 'write', summarize: chapterOnly },
  harvest_style: { label: '收割文风候选', risk: 'write', summarize: () => '' },
}

/** 工具中文名：未登记工具回落英文原名（不静默显示空白） */
export function toolLabel(name: string): string {
  return TOOL_META[name]?.label ?? name
}

/**
 * 工具参数摘要。未登记工具或入参形状异常时尽力给出可读兜底（截断后的原文），
 * 绝不抛错——确认卡渲染失败会让作者连按钮都看不到。
 */
export function toolSummary(name: string, input: unknown, chapterName: ChapterNameLookup): string {
  const meta = TOOL_META[name]
  if (!meta) return fallbackSummary(input)
  try {
    return meta.summarize(input, chapterName)
  } catch {
    return fallbackSummary(input)
  }
}

/** 未登记工具的兜底摘要：对象取键值短列，其余截断原文 */
function fallbackSummary(input: unknown): string {
  if (input === null || input === undefined) return ''
  if (typeof input === 'string') return clip(input)
  if (typeof input === 'object' && !Array.isArray(input)) {
    const parts: string[] = []
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number') parts.push(`${k}=${clip(String(v))}`)
      if (parts.length >= 4) break
    }
    return parts.join('，')
  }
  return ''
}
