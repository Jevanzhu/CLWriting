/**
 * 极简 front matter 解析/回写 —— 运行时零第三方依赖的核心。
 *
 * 不是通用 YAML 解析器，只覆盖项目所需的受限子集：
 * - 平铺 key: value（#3#7 主体）
 * - 内联数组 value: [a, b, c]（#5 标签、#6 序列）
 * - 缩进嵌套（#6 境界体系的 体系: / - 名称: / 序列:）
 *
 * 容错约定（#3 第 8 节）：
 * - 未知字段原样保留、回写不重排顺序
 * - 解析失败返回结构化错误，不抛异常
 *
 * 不含 markdown 正文解析——front matter 只管 --- 分隔的 YAML 头。
 */

import type { ParseError } from './types.js'
import { splitFrontMatter, bodyOf } from './frontmatter-core.js'
// splitFrontMatter 已拆到 frontmatter-core.ts（零 Node 依赖，浏览器共用）；此处 re-export 保持兼容
export { splitFrontMatter, bodyOf }

// ── 值类型推断 ──────────────────────────────────

/** 内联数组切分：引号外逗号才切，引号内逗号保留；`\"` 是转义引号不算引号边界。
 *  （K17 原正则的引号配对把 `\"` 也计入——串内同时存在转义引号与含逗号引号项时配对错乱，往返错位） */
function splitInlineArray(inner: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!
    if (c === '\\' && inQuote && i + 1 < inner.length) {
      cur += c + inner[i + 1]!
      i++
      continue
    }
    if (c === '"') {
      inQuote = !inQuote
      cur += c
      continue
    }
    if (c === ',' && !inQuote) {
      out.push(cur.trim())
      cur = ''
      continue
    }
    cur += c
  }
  out.push(cur.trim())
  // X-P2-18：数组项与标量对称 unquote——序列化端逐项加引号，解析端不剥则带引号往返错位
  return out.map((s) => unquote(s))
}

/** 解析单行值：区分 int / 内联数组 / 字符串 */
export function parseValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === '') return ''

  // 内联数组 [a, b, c]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim()
    if (inner === '') return []
    // K17：逗号分割时跳过引号内的逗号（如 [科幻, "悬疑,推理"]）
    return splitInlineArray(inner)
  }

  // 纯整数（不含小数点、e 等；开启章等字段）
  if (/^-?\d+$/.test(trimmed)) {
    const n = Number(trimmed)
    if (Number.isSafeInteger(n)) return n
  }

  // 其余按字符串（去掉可选引号）
  return unquote(trimmed)
}

/** 去掉值两端可选的引号（作者可能写 `标题: "灭门真凶"`）。
 *  双引号包裹时反转义 \"（与 stringifyValue 的 replace(/"/g, '\\"') 对称，
 *  防含引号值每次保存多累积一个反斜杠 → 内容渐进腐化）。 */
function unquote(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"')
  }
  if (s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1)
  }
  return s
}

/** 回写值：int/数组原样，字符串按需加引号（防 YAML 歧义） */
export function stringifyValue(val: unknown): string {
  if (typeof val === 'number') return String(val)
  if (Array.isArray(val)) {
    // X-P2-18：逐项走标量序列化（含逗号/引号项加引号转义），与解析端 K17 的引号跳过对称——
    // 此前 join(', ') 直拼，含逗号项序列化后往返错位（["悬疑,推理"] 解析回成两项）
    return '[' + val.map((v) => stringifyValue(v)).join(', ') + ']'
  }
  if (typeof val === 'boolean') return val ? 'true' : 'false'
  const s = String(val)
  // 需要加引号的情形：纯数字串（防被当 int）、空、特殊字符
  // X-P2-18：补 `,`——内联数组的分隔符本身，含逗号项不引号则解析端切错位
  if (s === '' || /^-?\d+$/.test(s) || /[:#\[\]{}&*!|>'"%@`,]/.test(s)) {
    return '"' + s.replace(/"/g, '\\"') + '"'
  }
  return s
}

// ── front matter 提取/包裹 ──────────────────────
// splitFrontMatter 定义已移至 frontmatter-core.ts，文件顶部 re-export

/** 平铺 front matter → 有序 Map（保留插入顺序；支持块标量 `key: |`/`>` 多行值） */
export function parseFlat(
  fmRaw: string,
): Map<string, unknown> {
  const result = new Map<string, unknown>()
  const lines = fmRaw.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      i++
      continue
    }
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) {
      i++
      continue
    }
    const key = line.slice(0, colonIdx).trim()
    const valRaw = line.slice(colonIdx + 1).trim()
    // 块标量：key: |（literal，保留换行）或 key: >（folded，换行转空格）
    if (valRaw === '|' || valRaw === '>') {
      const folded = valRaw === '>'
      const block: string[] = []
      i++
      while (i < lines.length) {
        const bl = lines[i]!
        if (bl.trim() === '') {
          block.push('')
          i++
          continue
        }
        const indent = bl.length - bl.trimStart().length
        if (indent === 0) break // 回到平铺层（新 key）
        block.push(bl.slice(indent))
        i++
      }
      const value = folded
        ? block.join(' ').replace(/  +/g, ' ').replace(/ +$/,'')
        : block.join('\n').replace(/\n+$/, '')
      result.set(key, value)
      continue
    }
    result.set(key, parseValue(valRaw))
    i++
  }
  return result
}

/** 有序 Map → 平铺 front matter 文本（多行字符串值用块标量 `key: |`） */
export function stringifyFlat(map: Map<string, unknown>): string {
  const lines: string[] = []
  for (const [key, val] of map) {
    if (typeof val === 'string' && val.includes('\n')) {
      lines.push(`${key}: |`)
      for (const bl of val.split('\n')) lines.push(bl === '' ? '' : '  ' + bl)
    } else {
      lines.push(`${key}: ${stringifyValue(val)}`)
    }
  }
  return lines.join('\n')
}

/** 包裹 front matter + 正文为完整 markdown */
export function joinFrontMatter(fmText: string, body: string): string {
  if (fmText === '') return body
  return `---\n${fmText}\n---\n${body}`
}

// ── 读取/写入文件（容错入口）────────────────────

import { readFileSync } from 'node:fs'
import { atomicWriteFile } from '../fs/atomic.js'

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
  atomicWriteFile(filePath, joinFrontMatter(fmText, body))
}

// ── 境界体系嵌套解析（#6 第 2 节）────────────────

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
  let inRealms = false

  for (const line of lines) {
    // 体系: 段开始
    if (/^体系:\s*$/.test(line.trim())) {
      inRealms = true
      continue
    }
    if (!inRealms) continue

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
