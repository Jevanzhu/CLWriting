/**
 * book.yaml 读写 —— 依据 #9 book.yaml 配置 spec。
 *
 * 与 frontmatter.ts 的区别：
 * - book.yaml 是独立 .yaml 文件（无 --- 包裹），机器域英文 key，多层嵌套段
 * - front matter 是中文 key、平铺、--- 包裹
 *
 * 这里手写一个支持「段（顶层 key:）+ 缩进子字段」的极简解析，覆盖 #9 第 2 节 schema。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import type { BookConfig, ParseError } from './types.js'
import { parseValue, stringifyValue } from './frontmatter.js'

// ── 默认值（#9 第 3 节，待 beta 的给占位）────────

export const DEFAULT_CONFIG: BookConfig = {
  spec_version: 1,
  host: 'cc',
  book: { title: '', genre: '' },
  leads: { enabled: [] },
  budget: {
    calls_per_chapter: 8,
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

/** 段树 → BookConfig（#9 第 2 节） */
function sectionsToConfig(roots: RawSection[]): BookConfig {
  const cfg: BookConfig = { ...DEFAULT_CONFIG, book: { ...DEFAULT_CONFIG.book }, leads: { ...DEFAULT_CONFIG.leads }, budget: { ...DEFAULT_CONFIG.budget }, style: { ...DEFAULT_CONFIG.style }, auto: { ...DEFAULT_CONFIG.auto }, growth: { ...DEFAULT_CONFIG.growth } }
  const find = (key: string) => roots.find((r) => r.key === key)

  if (find('spec_version')) cfg.spec_version = parseFiniteNumber(find('spec_version')!.value, 1)

  // kind（M8 #25）：顶层标量，缺省 long；只有显式 kind: short 才路由短篇轨
  const kindNode = find('kind')
  if (kindNode) {
    const k = String(parseValue(kindNode.value))
    if (k === 'short' || k === 'long') cfg.kind = k
  }

  // host（决策 12）：AI 宿主，缺省 cc；只认 cc/codex
  const hostNode = find('host')
  if (hostNode) {
    const h = String(parseValue(hostNode.value))
    if (h === 'cc' || h === 'codex') cfg.host = h
  }

  const book = find('book')
  if (book) {
    const t = book.children.find((c) => c.key === 'title')
    const g = book.children.find((c) => c.key === 'genre')
    const vs = book.children.find((c) => c.key === 'volume_size')
    if (t) cfg.book.title = String(parseValue(t.value))
    if (g) cfg.book.genre = String(parseValue(g.value))
    if (vs) {
      const volumeSize = parseFiniteNumber(vs.value, NaN)
      if (Number.isSafeInteger(volumeSize) && volumeSize > 0) cfg.book.volume_size = volumeSize
    }
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
        const num = parseFiniteNumber(c.value, NaN)
        if (Number.isFinite(num)) thresholds[c.key] = num
      }
      if (Object.keys(thresholds).length > 0) cfg.leads.thresholds = thresholds
    }
  }

  const budget = find('budget')
  if (budget) {
    for (const c of budget.children) {
      if (c.key in cfg.budget) {
        const budget = cfg.budget as Record<string, number>
        budget[c.key] = parseFiniteNumber(c.value, budget[c.key] ?? 0)
      }
    }
  }

  const style = find('style')
  if (style) {
    const inj = style.children.find((c) => c.key === 'injection')
    if (inj) cfg.style.injection = String(parseValue(inj.value)) as 'light' | 'heavy'
  }

  const short = find('short')
  if (short) {
    const shortConfig: NonNullable<BookConfig['short']> = {}
    const profile = short.children.find((c) => c.key === 'profile')
    if (profile) {
      const value = String(parseValue(profile.value)).trim()
      if (value.length > 0) shortConfig.profile = value
    }
    for (const key of [
      'target_emotions',
      'target_reversal_types',
      'target_ending_flavors',
      'series_motifs',
    ] as const) {
      const node = short.children.find((c) => c.key === key)
      if (!node) continue
      const value = parseValue(node.value)
      if (Array.isArray(value)) {
        const items = value.map(String).map((v) => v.trim()).filter(Boolean)
        if (items.length > 0) shortConfig[key] = items
      }
    }
    const strict = short.children.find((c) => c.key === 'strict')
    if (strict) shortConfig.strict = String(parseValue(strict.value)) === 'true'
    for (const key of [
      'word_min',
      'word_max',
      'body_part_threshold',
      'simile_threshold',
      'section_count',
      'opening_env_chars',
    ] as const) {
      const node = short.children.find((c) => c.key === key)
      if (!node) continue
      const value = parseFiniteNumber(node.value, NaN)
      if (Number.isFinite(value) && value > 0) shortConfig[key] = value
    }
    if (Object.keys(shortConfig).length > 0) cfg.short = shortConfig
  }

  const auto = find('auto')
  if (auto) {
    const co = auto.children.find((c) => c.key === 'confirm_outline')
    if (co) cfg.auto.confirm_outline = String(parseValue(co.value)) === 'true'
    const bs = auto.children.find((c) => c.key === 'batch_size')
    if (bs) cfg.auto.batch_size = parseFiniteNumber(bs.value, DEFAULT_CONFIG.auto.batch_size)
  }

  const growth = find('growth')
  if (growth) {
    const rs = growth.children.find((c) => c.key === 'realm_span_max')
    if (rs) cfg.growth.realm_span_max = parseFiniteNumber(rs.value, DEFAULT_CONFIG.growth.realm_span_max ?? 2)
  }

  // RAG 可选段（#37，非密：enabled/endpoint/model；api_key 不入此）
  const rag = find('rag')
  if (rag) {
    const en = rag.children.find((c) => c.key === 'enabled')
    const ep = rag.children.find((c) => c.key === 'endpoint')
    const md = rag.children.find((c) => c.key === 'model')
    if (en) cfg.rag = {
      enabled: String(parseValue(en.value)) === 'true',
      ...(ep ? { endpoint: String(parseValue(ep.value)) } : {}),
      ...(md ? { model: String(parseValue(md.value)) } : {}),
    }
  }

  return cfg
}

function parseFiniteNumber(raw: string, fallback: number): number {
  const n = Number(parseValue(raw))
  return Number.isFinite(n) ? n : fallback
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

/** BookConfig → YAML 文本（#9 第 2 节格式；短篇集走精简字段，M8 #25） */
export function stringifyBookConfig(cfg: BookConfig): string {
  const isShort = cfg.kind === 'short'
  const lines: string[] = [
    `spec_version: ${cfg.spec_version}`,
    // kind 只在 short 时输出（长篇缺省不写，现有仓库零改动红线，M8 #25）
    ...(isShort ? ['kind: short', ''] : ['']),
    `host: ${cfg.host ?? 'cc'}`,
    'book:',
    `  title: ${stringifyValue(cfg.book.title)}`,
    `  genre: ${stringifyValue(cfg.book.genre)}`,
  ]
  if (cfg.book.volume_size !== undefined) {
    lines.push(`  volume_size: ${cfg.book.volume_size}`)
  }

  // leads 段：长篇恒输出（账本类）；短篇无（账本降级单篇清单 #27）
  if (!isShort) {
    lines.push('', 'leads:', `  enabled: ${stringifyValue(cfg.leads.enabled)}`)
    if (cfg.leads.thresholds) {
      lines.push('  thresholds:')
      for (const [k, v] of Object.entries(cfg.leads.thresholds)) {
        lines.push(`    ${k}: ${v}`)
      }
    }
  }

  // budget 段：长短共用 calls_per_chapter；长篇额外含 summary 长程项（短篇无分层摘要）
  lines.push('', 'budget:', `  calls_per_chapter: ${cfg.budget.calls_per_chapter}`)
  if (!isShort) {
    lines.push(
      `  input_per_chapter: ${cfg.budget.input_per_chapter ?? 80000}`,
      `  summary_chapter_max: ${cfg.budget.summary_chapter_max ?? 200}`,
      `  summary_volume_max: ${cfg.budget.summary_volume_max ?? 500}`,
    )
  }

  lines.push(
    '',
    'style:',
    `  injection: ${cfg.style.injection}`,
  )

  if (isShort && cfg.short && Object.keys(cfg.short).length > 0) {
    lines.push('', 'short:')
    if (cfg.short.profile) lines.push(`  profile: ${stringifyValue(cfg.short.profile)}`)
    if (cfg.short.target_emotions) lines.push(`  target_emotions: ${stringifyValue(cfg.short.target_emotions)}`)
    if (cfg.short.target_reversal_types) lines.push(`  target_reversal_types: ${stringifyValue(cfg.short.target_reversal_types)}`)
    if (cfg.short.target_ending_flavors) lines.push(`  target_ending_flavors: ${stringifyValue(cfg.short.target_ending_flavors)}`)
    if (cfg.short.series_motifs) lines.push(`  series_motifs: ${stringifyValue(cfg.short.series_motifs)}`)
    if (cfg.short.strict) lines.push('  strict: true')
    for (const key of [
      'word_min',
      'word_max',
      'body_part_threshold',
      'simile_threshold',
      'section_count',
      'opening_env_chars',
    ] as const) {
      const value = cfg.short[key]
      if (value !== undefined) lines.push(`  ${key}: ${value}`)
    }
  }

  lines.push(
    '',
    'auto:',
    `  confirm_outline: ${cfg.auto.confirm_outline}`,
    `  batch_size: ${cfg.auto.batch_size}`,
  )

  // growth 段：长篇输出（成长线/境界）；短篇无（无成长线）
  if (!isShort) {
    lines.push('', 'growth:', `  realm_span_max: ${cfg.growth.realm_span_max ?? 2}`)
  }

  // RAG 可选段（#37，非密；key 绝不入此；长短皆可选）
  if (cfg.rag) {
    lines.push(
      '',
      'rag:',
      `  enabled: ${cfg.rag.enabled}`,
      ...(cfg.rag.endpoint ? [`  endpoint: ${stringifyValue(cfg.rag.endpoint)}`] : []),
      ...(cfg.rag.model ? [`  model: ${stringifyValue(cfg.rag.model)}`] : []),
    )
  }
  return lines.join('\n') + '\n'
}

/** 写 book.yaml */
export function writeBookConfig(filePath: string, cfg: BookConfig): void {
  writeFileSync(filePath, stringifyBookConfig(cfg), 'utf-8')
}
