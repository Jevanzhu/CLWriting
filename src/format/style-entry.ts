/**
 * 文风条目库读写 —— 文风系统重整（条目模型 + 四源管线）。
 *
 * 文件组织：文风/条目/<类型>/<场景>-<序号>.md
 * 格式：front matter（类型/场景/来源/说明/出处/标签）+ 正文
 *
 * 按类型分目录（类型数固定 4，场景会生长；手法/禁词多为通用场景）；
 * 文件名保留场景便于识别。极性不设字段，由类型推导。
 * 「类型」以 fm 为真相源（文件即真相）；目录仅组织，扫描时作 fm 缺失的兜底。
 */

import { readdirSync, statSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { readFile, writeFile, parseFlat, stringifyFlat } from './frontmatter.js'
import { parseSampleFileName } from './style.js'
import type { StyleEntry, EntryKind, EntrySource, ParseError } from './types.js'

/** 四种条目类型（即 条目/ 下的子目录名） */
export const ENTRY_KINDS: readonly EntryKind[] = ['样章', '手法', '反例', '禁词'] as const

/** 书内条目库相对路径 */
export const ENTRIES_DIR = '文风/条目'

/** 来源 → 证据强度排名（小者强：行为 > 认可 > 声明），注入排序用 */
export const SOURCE_RANK: Record<EntrySource, number> = {
  改稿行为: 0,
  作者标注: 1,
  收割: 2,
  题材范文: 3,
  导入: 4,
}

/** 极性由类型推导：样章/手法=正面示范，反例/禁词=负面清单 */
export function entryPolarity(kind: EntryKind): '正' | '负' {
  return kind === '样章' || kind === '手法' ? '正' : '负'
}

const KNOWN_FM_KEYS = new Set(['类型', '场景', '来源', '说明', '出处', '标签'])

function isEntryKind(v: unknown): v is EntryKind {
  return typeof v === 'string' && (ENTRY_KINDS as readonly string[]).includes(v)
}

function isEntrySource(v: unknown): v is EntrySource {
  return typeof v === 'string' && v in SOURCE_RANK
}

/**
 * 读取一个条目 md → StyleEntry（容错）。
 * fm 缺「类型」时用 fallbackKind 兜底（目录扫描时传目录名）；两者皆无 → 错误。
 * 来源缺省「作者标注」（手建文件最常见的情形）。
 */
export function readEntry(
  filePath: string,
  fallbackKind?: EntryKind,
): { ok: true; entry: StyleEntry } | { ok: false; error: ParseError } {
  const r = readFile(filePath)
  if (!r.ok) return r

  const map = parseFlat(r.fmRaw)
  const rawKind = map.get('类型')
  const kind = isEntryKind(rawKind) ? rawKind : fallbackKind
  if (!kind) {
    return { ok: false, error: { file: filePath, line: 0, message: '缺少或非法字段：类型' } }
  }
  const 场景 = map.get('场景')
  if (typeof 场景 !== 'string' || !场景) {
    return { ok: false, error: { file: filePath, line: 0, message: '缺少必填字段：场景' } }
  }

  const _raw: Record<string, string> = {}
  for (const [k, v] of map) {
    if (!KNOWN_FM_KEYS.has(k)) _raw[k] = String(v)
  }

  const rawSource = map.get('来源')
  const entry: StyleEntry = {
    类型: kind,
    场景,
    来源: isEntrySource(rawSource) ? rawSource : '作者标注',
    ...(map.has('说明') ? { 说明: String(map.get('说明')) } : {}),
    ...(map.has('出处') ? { 出处: String(map.get('出处')) } : {}),
    ...(Array.isArray(map.get('标签')) ? { 标签: map.get('标签') as string[] } : {}),
    正文: r.body.trim(),
    ...(Object.keys(_raw).length > 0 ? { _raw } : {}),
    _path: filePath,
  }
  return { ok: true, entry }
}

/** StyleEntry → front matter Map（证据为运行期字段，不落盘） */
function entryToMap(e: StyleEntry): Map<string, unknown> {
  const map = new Map<string, unknown>()
  map.set('类型', e.类型)
  map.set('场景', e.场景)
  map.set('来源', e.来源)
  if (e.说明) map.set('说明', e.说明)
  if (e.出处) map.set('出处', e.出处)
  if (e.标签 && e.标签.length > 0) map.set('标签', e.标签)
  if (e._raw) {
    for (const [k, v] of Object.entries(e._raw)) {
      if (!map.has(k)) map.set(k, v)
    }
  }
  return map
}

/** 写入条目 md（调用方保证目录存在；addEntry 自建） */
export function writeEntry(filePath: string, e: StyleEntry): void {
  writeFile(filePath, stringifyFlat(entryToMap(e)), e.正文)
}

/**
 * 读条目库（entriesDir = <bookRoot>/文风/条目）。
 * kind 省略 → 全部四类；目录不存在 → 空（老书未迁移时的正常形态）。
 */
export function readEntries(
  entriesDir: string,
  kind?: EntryKind,
): { entries: StyleEntry[]; errors: ParseError[] } {
  const kinds = kind ? [kind] : ENTRY_KINDS
  const entries: StyleEntry[] = []
  const errors: ParseError[] = []
  for (const k of kinds) {
    const dir = join(entriesDir, k)
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('._'))
    } catch {
      continue // 类型目录不存在，空
    }
    for (const f of files.sort()) {
      const fp = join(dir, f)
      if (!statSync(fp).isFile()) continue
      const r = readEntry(fp, k)
      if (r.ok) entries.push(r.entry)
      else errors.push(r.error)
    }
  }
  return { entries, errors }
}

/** 扫描类型目录求同场景最大序号 +1（<场景>-NNN.md 命名式与样章库一致） */
export function nextEntrySeq(entriesDir: string, kind: EntryKind, scene: string): number {
  const dir = join(entriesDir, kind)
  if (!existsSync(dir)) return 1
  let maxSeq = 0
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md') || f.startsWith('._')) continue
    const parsed = parseSampleFileName(f)
    if (parsed && parsed.场景 === scene && parsed.序号 > maxSeq) maxSeq = parsed.序号
  }
  return maxSeq + 1
}

/**
 * 新增条目入库：求序号 → 建目录 → 写文件。
 * @returns 相对书仓库路径（文风/条目/<类型>/<场景>-NNN.md）
 */
export function addEntry(bookRoot: string, e: StyleEntry): string {
  const entriesDir = join(bookRoot, ENTRIES_DIR)
  const seq = nextEntrySeq(entriesDir, e.类型, e.场景)
  // 场景字段净化路径分隔符，防 frontmatter 篡改越出目录
  const fileName = `${e.场景.replace(/[\\/]/g, '_')}-${String(seq).padStart(3, '0')}.md`
  const dir = join(entriesDir, e.类型)
  mkdirSync(dir, { recursive: true })
  writeEntry(join(dir, fileName), e)
  return `${ENTRIES_DIR}/${e.类型}/${fileName}`
}

/**
 * 条目库硬禁词列表（机检收口 S5：禁词知识在条目库；无条目库 → 空）。
 * 「AI味」标签的是软禁词（旧铁律替换表迁移而来）——只注入不机检，
 * 保持旧语义：反和解硬禁词命中报红，AI 味词交给写稿/去味阶段。
 */
export function readBannedEntryWords(bookRoot: string): string[] {
  const { entries } = readEntries(join(bookRoot, ENTRIES_DIR), '禁词')
  return entries
    .filter((e) => !(e.标签?.includes('AI味')))
    .map((e) => e.正文.trim())
    .filter(Boolean)
}
