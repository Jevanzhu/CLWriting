/**
 * 极简 front matter 解析/回写 —— 运行时零第三方依赖的核心。
 *
 * 不是通用 YAML 解析器，只覆盖项目所需的受限子集：
 * - 平铺 key: value（③⑦ 主体）
 * - 内联数组 value: [a, b, c]（⑤ 标签、⑥ 序列）
 * - 缩进嵌套（⑥ 境界体系的 体系: / - 名称: / 序列:）
 *
 * 容错约定（③ 第 8 节）：
 * - 未知字段原样保留、回写不重排顺序
 * - 解析失败返回结构化错误，不抛异常
 *
 * 不含 markdown 正文解析——front matter 只管 --- 分隔的 YAML 头。
 */

import type { ParseError } from './types.js'

// ── 值类型推断 ──────────────────────────────────

/** 解析单行值：区分 int / 内联数组 / 字符串 */
export function parseValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === '') return ''

  // 内联数组 [a, b, c]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim()
    if (inner === '') return []
    return inner.split(',').map((s) => s.trim())
  }

  // 纯整数（不含小数点、e 等；开启章等字段）
  if (/^-?\d+$/.test(trimmed)) {
    const n = Number(trimmed)
    if (Number.isSafeInteger(n)) return n
  }

  // 其余按字符串（去掉可选引号）
  return unquote(trimmed)
}

/** 去掉值两端可选的引号（作者可能写 `标题: "灭门真凶"`） */
function unquote(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1)
  }
  return s
}

/** 回写值：int/数组原样，字符串按需加引号（防 YAML 歧义） */
export function stringifyValue(val: unknown): string {
  if (typeof val === 'number') return String(val)
  if (Array.isArray(val)) {
    return '[' + val.join(', ') + ']'
  }
  if (typeof val === 'boolean') return val ? 'true' : 'false'
  const s = String(val)
  // 需要加引号的情形：纯数字串（防被当 int）、空、特殊字符
  if (s === '' || /^-?\d+$/.test(s) || /[:#\[\]{}&*!|>'"%@`]/.test(s)) {
    return '"' + s.replace(/"/g, '\\"') + '"'
  }
  return s
}

// ── front matter 提取/包裹 ──────────────────────

/** 从 markdown 文本提取 front matter 段（--- 之间）与正文 */
export function splitFrontMatter(
  content: string,
): { fmRaw: string; body: string } | null {
  // 首行必须是 ---
  if (!content.startsWith('---')) return null
  const lines = content.split('\n')
  // 找闭合 ---
  let endIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') {
      endIdx = i
      break
    }
  }
  if (endIdx === -1) return null
  const fmRaw = lines.slice(1, endIdx).join('\n')
  const body = lines.slice(endIdx + 1).join('\n')
  return { fmRaw, body }
}

/** 平铺 front matter → 有序 Map（保留插入顺序，回写不重排） */
export function parseFlat(
  fmRaw: string,
): Map<string, unknown> {
  const result = new Map<string, unknown>()
  for (const line of fmRaw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const valRaw = line.slice(colonIdx + 1)
    result.set(key, parseValue(valRaw))
  }
  return result
}

/** 有序 Map → 平铺 front matter 文本（保留顺序） */
export function stringifyFlat(map: Map<string, unknown>): string {
  const lines: string[] = []
  for (const [key, val] of map) {
    lines.push(`${key}: ${stringifyValue(val)}`)
  }
  return lines.join('\n')
}

/** 包裹 front matter + 正文为完整 markdown */
export function joinFrontMatter(fmText: string, body: string): string {
  if (fmText === '') return body
  return `---\n${fmText}\n---\n${body}`
}

// ── 读取/写入文件（容错入口）────────────────────

import { readFileSync, writeFileSync } from 'node:fs'

/** 读取文件的 front matter + 正文（容错：坏文件返回错误不崩） */
export function readFile(
  filePath: string,
): { ok: true; fmRaw: string; body: string } | { ok: false; error: ParseError } {
  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
  } catch (e) {
    return {
      ok: false,
      error: {
        file: filePath,
        line: 0,
        message: `无法读取文件：${e instanceof Error ? e.message : String(e)}`,
      },
    }
  }
  const split = splitFrontMatter(content)
  if (split === null) {
    return {
      ok: false,
      error: { file: filePath, line: 1, message: '缺少 front matter（未找到起始 ---）' },
    }
  }
  return { ok: true, fmRaw: split.fmRaw, body: split.body }
}

/** 写入 front matter + 正文到文件 */
export function writeFile(filePath: string, fmText: string, body: string): void {
  writeFileSync(filePath, joinFrontMatter(fmText, body), 'utf-8')
}

// ── 境界体系嵌套解析（⑥ 第 2 节）────────────────

/**
 * 解析境界体系的嵌套结构（体系: / - 名称: / 序列:）。
 * 这是 front matter 里唯一的嵌套场景，单独处理、不污染平铺解析。
 *
 * 输入 fmRaw 示例：
 *   体系:
 *     - 名称: 修真境界
 *       序列: [炼气, 筑基, 金丹]
 *     - 名称: 武者等级
 *       序列: [后天, 先天]
 */
export interface ParsedRealmSystem {
  名称: string
  序列: string[]
}

export function parseRealmSystems(fmRaw: string): ParsedRealmSystem[] {
  const systems: ParsedRealmSystem[] = []
  const lines = fmRaw.split('\n')
  let current: ParsedRealmSystem | null = null
  let inLeads = false

  for (const line of lines) {
    // 体系: 段开始
    if (/^体系:\s*$/.test(line.trim())) {
      inLeads = true
      continue
    }
    if (!inLeads) continue

    // - 名称: xxx（新体系项）
    const nameMatch = line.match(/^\s*-\s*名称:\s*(.*)$/)
    if (nameMatch) {
      if (current) systems.push(current)
      current = { 名称: unquote(nameMatch[1]!.trim()), 序列: [] }
      continue
    }

    // 序列: [a, b]（当前体系的序列）
    const seqMatch = line.match(/^\s*序列:\s*(.*)$/)
    if (seqMatch && current) {
      const val = parseValue(seqMatch[1]!)
      if (Array.isArray(val)) {
        current.序列 = val.map(String)
      }
      continue
    }
  }
  if (current) systems.push(current)
  return systems
}

/** 境界体系 → 嵌套 front matter 文本 */
export function stringifyRealmSystems(systems: ParsedRealmSystem[]): string {
  if (systems.length === 0) return ''
  const lines: string[] = ['体系:']
  for (const sys of systems) {
    lines.push(`  - 名称: ${stringifyValue(sys.名称)}`)
    lines.push(`    序列: ${stringifyValue(sys.序列)}`)
  }
  return lines.join('\n')
}
