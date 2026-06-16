/**
 * book.yaml 读写 —— 依据 ⑨ book.yaml 配置 spec。
 *
 * 与 frontmatter.ts 的区别：
 * - book.yaml 是独立 .yaml 文件（无 --- 包裹），机器域英文 key，多层嵌套段
 * - front matter 是中文 key、平铺、--- 包裹
 *
 * 这里手写一个支持「段（顶层 key:）+ 缩进子字段」的极简解析，覆盖 ⑨ 第 2 节 schema。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import type { BookConfig, ParseError } from './types.js'
import { parseValue, stringifyValue } from './frontmatter.js'

// ── 默认值（⑨ 第 3 节，待 beta 的给占位）────────

export const DEFAULT_CONFIG: BookConfig = {
  spec_version: 1,
  book: { title: '', genre: '' },
  leads: { enabled: [] },
  budget: {
    calls_per_chapter: 6,
    input_per_chapter: 80000,
    summary_chapter_max: 200,
    summary_volume_max: 500,
  },
  style: { injection: 'light' },
  auto: { confirm_outline: false, batch_size: 8 },
  growth: { realm_span_max: 2 },
}

// ── 解析：段 + 缩进子字段 ────────────────────────

interface RawSection {
  indent: number // 缩进空格数
  key: string
  value: string // 行内值（子段为空）
  children: RawSection[]
}

/** 解析 YAML 文本为段树（支持 2 空格缩进） */
function parseSections(text: string): RawSection[] {
  const roots: RawSection[] = []
  const stack: RawSection[] = [] // 按缩进维护
  const make = (indent: number, key: string, value: string): RawSection => ({
    indent, key, value, children: [],
  })

  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const content = line.trim()
    const colonIdx = content.indexOf(':')
    if (colonIdx === -1) continue
    const key = content.slice(0, colonIdx).trim()
    const value = content.slice(colonIdx + 1).trim()

    const node = make(indent, key, value)

    // 弹栈到父级（缩进比自己小的最近一个）
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) {
      stack.pop()
    }
    if (stack.length === 0) {
      roots.push(node)
    } else {
      stack[stack.length - 1]!.children.push(node)
    }
    // 有子段潜力（value 为空且是 map）的入栈
    if (value === '') {
      stack.push(node)
    }
  }
  return roots
}

/** 段树 → BookConfig（⑨ 第 2 节） */
function sectionsToConfig(roots: RawSection[]): BookConfig {
  const cfg: BookConfig = { ...DEFAULT_CONFIG, book: { ...DEFAULT_CONFIG.book }, leads: { ...DEFAULT_CONFIG.leads }, budget: { ...DEFAULT_CONFIG.budget }, style: { ...DEFAULT_CONFIG.style }, auto: { ...DEFAULT_CONFIG.auto }, growth: { ...DEFAULT_CONFIG.growth } }
  const find = (key: string) => roots.find((r) => r.key === key)

  if (find('spec_version')) cfg.spec_version = Number(find('spec_version')!.value) || 1

  const book = find('book')
  if (book) {
    const t = book.children.find((c) => c.key === 'title')
    const g = book.children.find((c) => c.key === 'genre')
    if (t) cfg.book.title = String(parseValue(t.value))
    if (g) cfg.book.genre = String(parseValue(g.value))
  }

  const leads = find('leads')
  if (leads) {
    const en = leads.children.find((c) => c.key === 'enabled')
    if (en) {
      const v = parseValue(en.value)
      if (Array.isArray(v)) cfg.leads.enabled = v.map(String)
    }
    const th = leads.children.find((c) => c.key === 'thresholds')
    if (th) {
      const thresholds: Record<string, number> = {}
      for (const c of th.children) {
        thresholds[c.key] = Number(parseValue(c.value))
      }
      if (Object.keys(thresholds).length > 0) cfg.leads.thresholds = thresholds
    }
  }

  const budget = find('budget')
  if (budget) {
    for (const c of budget.children) {
      const num = Number(parseValue(c.value))
      if (c.key in cfg.budget) (cfg.budget as Record<string, unknown>)[c.key] = num
    }
  }

  const style = find('style')
  if (style) {
    const inj = style.children.find((c) => c.key === 'injection')
    if (inj) cfg.style.injection = String(parseValue(inj.value)) as 'light' | 'heavy'
  }

  const auto = find('auto')
  if (auto) {
    const co = auto.children.find((c) => c.key === 'confirm_outline')
    if (co) cfg.auto.confirm_outline = String(parseValue(co.value)) === 'true'
    const bs = auto.children.find((c) => c.key === 'batch_size')
    if (bs) cfg.auto.batch_size = Number(parseValue(bs.value))
  }

  const growth = find('growth')
  if (growth) {
    const rs = growth.children.find((c) => c.key === 'realm_span_max')
    if (rs) cfg.growth.realm_span_max = Number(parseValue(rs.value))
  }

  return cfg
}

// ── 公开 API ────────────────────────────────────

/** 读 book.yaml（容错：缺文件/坏文件返回默认 + 错误） */
export function readBookConfig(
  filePath: string,
): { ok: true; config: BookConfig } | { ok: false; config: BookConfig; error: ParseError } {
  if (!existsSync(filePath)) {
    return {
      ok: false,
      config: DEFAULT_CONFIG,
      error: { file: filePath, line: 0, message: 'book.yaml 不存在（用默认配置）' },
    }
  }
  let text: string
  try {
    text = readFileSync(filePath, 'utf-8')
  } catch (e) {
    return {
      ok: false,
      config: DEFAULT_CONFIG,
      error: { file: filePath, line: 0, message: `读取失败：${e instanceof Error ? e.message : String(e)}` },
    }
  }
  try {
    const roots = parseSections(text)
    return { ok: true, config: sectionsToConfig(roots) }
  } catch (e) {
    return {
      ok: false,
      config: DEFAULT_CONFIG,
      error: { file: filePath, line: 0, message: `解析失败：${e instanceof Error ? e.message : String(e)}` },
    }
  }
}

/** BookConfig → YAML 文本（⑨ 第 2 节格式） */
export function stringifyBookConfig(cfg: BookConfig): string {
  const lines: string[] = [
    `spec_version: ${cfg.spec_version}`,
    '',
    'book:',
    `  title: ${stringifyValue(cfg.book.title)}`,
    `  genre: ${stringifyValue(cfg.book.genre)}`,
    '',
    'leads:',
    `  enabled: ${stringifyValue(cfg.leads.enabled)}`,
  ]
  if (cfg.leads.thresholds) {
    lines.push('  thresholds:')
    for (const [k, v] of Object.entries(cfg.leads.thresholds)) {
      lines.push(`    ${k}: ${v}`)
    }
  }
  lines.push(
    '',
    'budget:',
    `  calls_per_chapter: ${cfg.budget.calls_per_chapter}`,
    `  input_per_chapter: ${cfg.budget.input_per_chapter ?? 80000}`,
    `  summary_chapter_max: ${cfg.budget.summary_chapter_max ?? 200}`,
    `  summary_volume_max: ${cfg.budget.summary_volume_max ?? 500}`,
    '',
    'style:',
    `  injection: ${cfg.style.injection}`,
    '',
    'auto:',
    `  confirm_outline: ${cfg.auto.confirm_outline}`,
    `  batch_size: ${cfg.auto.batch_size}`,
    '',
    'growth:',
    `  realm_span_max: ${cfg.growth.realm_span_max ?? 2}`,
  )
  return lines.join('\n') + '\n'
}

/** 写 book.yaml */
export function writeBookConfig(filePath: string, cfg: BookConfig): void {
  writeFileSync(filePath, stringifyBookConfig(cfg), 'utf-8')
}
