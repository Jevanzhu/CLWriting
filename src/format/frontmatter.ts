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
import { splitFrontMatter, bodyOf, stripInlineComment } from './frontmatter-core.js'
// splitFrontMatter 已拆到 frontmatter-core.ts（零 Node 依赖，浏览器共用）；此处 re-export 保持兼容
export { splitFrontMatter, bodyOf }

// ── 值类型推断 ──────────────────────────────────

/** 内联数组切分：引号外逗号才切，引号内逗号保留；`\"` 是转义引号不算引号边界。
 *  （K17 原正则的引号配对把 `\"` 也计入——串内同时存在转义引号与含逗号引号项时配对错乱，往返错位） */
export function splitInlineArray(inner: string): string[] {
  const out: string[] = []
  let cur = ''
  // Y-21（第五十七轮）：单引号纳入引号状态机——手写 `['悬疑,推理']` 此前在引号内
  // 逗号处错切成两项（序列化端只产双引号，单引号是纯手写入口；unquote 本就双体系对称）
  let inQuote: '"' | "'" | null = null
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!
    if (c === '\\' && inQuote && i + 1 < inner.length) {
      cur += c + inner[i + 1]!
      i++
      continue
    }
    if ((c === '"' || c === "'") && (inQuote === null || inQuote === c)) {
      inQuote = inQuote === null ? c : null
      cur += c
      continue
    }
    if (c === ',' && inQuote === null) {
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
 *  防含引号值每次保存多累积一个反斜杠 → 内容渐进腐化）。
 *  Q-15（第十五轮）：同时反转义 \n / \r——序列化端对控制字符转义后的对称还原。
 *  R-11（第十六轮）：反转义改单遍扫描，补 `\\` → `\`——原先链式 replace 不识别 `\\`，
 *  含字面反斜杠的值（如 C:\new\repo）往返渐进腐化（`\\n` 被二次误解成换行）。 */
function unquote(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) {
    const inner = s.slice(1, -1)
    let out = ''
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i]!
      // R-11：反斜杠后跟可转义字符 → 单遍解码（不回头重扫，保证与序列化端对称）
      if (c === '\\' && i + 1 < inner.length) {
        const n = inner[i + 1]!
        if (n === '"' || n === '\\' || n === 'n' || n === 'r') {
          out += n === 'n' ? '\n' : n === 'r' ? '\r' : n
          i++
          continue
        }
      }
      out += c
    }
    return out
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
  // dd-P3：首尾空白也加引号——不引号则往返后空白被 trim 丢失
  // Q-15（第十五轮）：补 \n\r——含换行值不引号则落盘直接劈断 yaml 行结构（回读静默
  // 丢键/错键）；引号内换行以 \n 转义承载（unquote 对称还原），主入口（config 标题）
  // 另有控制字符拒收防线
  // R-11（第十六轮）：值含反斜杠也须加引号（否则转义序列无处承载，与解析端不对称）
  if (s === '' || /^-?\d+$/.test(s) || /[:#\[\]{}&*!|>'"%@`,\n\r\\]/.test(s) || /^\s|\s$/.test(s)) {
    // R-11：先转义反斜杠再转其他——保证 `\\` / `\"` / `\n` / `\r` 与 unquote 单遍解码往返对称
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"'
  }
  return s
}

// ── front matter 提取/包裹 ──────────────────────
// splitFrontMatter 定义已移至 frontmatter-core.ts，文件顶部 re-export

// E-3（第五十三轮）：剥平铺值行内注释，防注释尾巴进值——`标题: 值 # 备注` 不再把
// 注释尾巴读进值。此前仅 yaml.ts（book.yaml）剥而 parseFlat（章 front matter）不剥，
// 双 fm 解析口径不一。N-4（第五十四轮）：实现下沉 frontmatter-core.ts（与 yaml.ts
// stripComment 同一函数，防循环 import 顾虑已随 core 拆出不成立），语义逐字不变。
// 注意：yaml.ts 读改写同样丢注释，故写侧注释丢失口径一致、可接受，测试锁定「注释不进值」。

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
    // E-3：值解析前剥行内注释（口径对齐 yaml.ts stripComment），防注释尾巴进值
    const valRaw = stripInlineComment(line.slice(colonIdx + 1).trim())
    // 块标量：key: |（literal，保留换行）或 key: >（folded，换行转空格）
    // Q-17（第十五轮）：精确匹配放宽为 chomping 变体（`|-`/`|+`/`>-`/`>+`）——手写
    // `钩子: |-` 此前不中块标量分支，值成字面串且缩进块内容混入 fm 伪键；变体统一按
    // 既有 clip 口径取值（strip/keep 的尾换行差不细分——项目内块标量由本模块序列化，
    // 手写场景保正确性即可）
    const blockMatch = /^([|>])[+-]?$/.exec(valRaw)
    if (blockMatch) {
      const folded = blockMatch[1] === '>'
      const block: string[] = []
      const indents: number[] = [] // E-9d：记录非空行缩进，供最小缩进去缩进
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
        indents.push(indent)
        // Y-6（第五十七轮）：剥 CRLF 行尾 \r——split('\n') 保留 \r 尾，块行原样入值会
        // 让多行值每行尾嵌 \r（平铺值行有 trim 无此问题，仅块标量中招），写回后形成
        // 混合行尾文件且值本体被污染
        block.push(bl.endsWith('\r') ? bl.slice(0, -1) : bl)
        i++
      }
      // E-9d（第五十三轮）：以块内非空行**最小缩进**为基准去缩进——此前按每行自身
      // 缩进 slice，块内后续行比首行浅（但仍 >0）时保留多余空白，多行值往返失真；
      // YAML 块标量语义本就是最小缩进决定内容基准
      const minIndent = indents.length > 0 ? Math.min(...indents) : 0
      const dedented = block.map((bl) => (bl === '' ? '' : bl.slice(minIndent)))
      // Z-20（第五十八轮）：folded 空行 = 段落边界（YAML 语义空行应为换行）——此前
      // join(' ') 把多段值压平成一段；无空行时产出与旧行为一致
      const foldSegs = (bls: string[]): string => {
        const segs: string[] = []
        let cur: string[] = []
        for (const bl of bls) {
          if (bl === '') {
            if (cur.length) { segs.push(cur.join(' ').replace(/  +/g, ' ').replace(/ +$/, '')); cur = [] }
          } else cur.push(bl)
        }
        if (cur.length) segs.push(cur.join(' ').replace(/  +/g, ' ').replace(/ +$/, ''))
        return segs.join('\n')
      }
      const value = folded ? foldSegs(dedented) : dedented.join('\n').replace(/\n+$/, '')
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

/** 写入 front matter + 正文到文件（opts 透传 atomicWriteFile——ee-P1-6 账本写点用 fsync） */
export function writeFile(filePath: string, fmText: string, body: string, opts?: { fsync?: boolean }): void {
  atomicWriteFile(filePath, joinFrontMatter(fmText, body), opts)
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
