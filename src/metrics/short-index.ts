/**
 * 短篇集级索引与重复风险体检。
 *
 * 目标：短篇主链已按单篇闭环，本模块只做整集层面的轻量扫描。
 * 数据来自已定稿 `篇/<篇号>-<标题>/正文.md` 与同目录 `清单.md`，
 * 不写文件、不耗模型，用于 health --report 的短篇集节奏提示。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readPiece } from '../format/pieces.js'
import { readPieceList } from '../format/manifest.js'
import type { PieceList } from '../format/types.js'

export interface ShortPieceIndexEntry {
  num: number
  title: string
  targetEmotion: string
  coreReversal: string
  reversalType: string
  structureObjects: string[]
  endingFlavor: string
}

export interface ShortCollectionRisk {
  kind: 'recent-repeat' | 'collection-repeat'
  field: 'targetEmotion' | 'reversalType' | 'coreReversal' | 'structureObject' | 'endingFlavor'
  message: string
  pieces: number[]
}

export interface ShortCollectionReport {
  count: number
  entries: ShortPieceIndexEntry[]
  risks: ShortCollectionRisk[]
}

/** 扫描短篇集索引。 */
export function scanShortCollection(bookRoot: string): ShortPieceIndexEntry[] {
  const piecesDir = join(bookRoot, '篇')
  if (!existsSync(piecesDir)) return []
  let names: string[]
  try {
    names = readdirSync(piecesDir)
  } catch {
    return []
  }

  const entries: ShortPieceIndexEntry[] = []
  for (const name of names) {
    if (name.startsWith('._')) continue
    const dir = join(piecesDir, name)
    if (!safeIsDirectory(dir)) continue
    const bodyPath = join(dir, '正文.md')
    if (!existsSync(bodyPath)) continue

    const piece = readPiece(bodyPath)
    if (!piece.ok) continue
    const list = readListIfExists(join(dir, '清单.md'))
    const coreReversal = firstReal(piece.piece.核心反转, list?.反转线索表.核心反转)
    entries.push({
      num: piece.piece.篇号,
      title: piece.piece.标题,
      targetEmotion: cleanValue(piece.piece.目标情绪),
      coreReversal,
      reversalType: classifyReversal(coreReversal),
      structureObjects: collectStructureObjects(list),
      endingFlavor: endingFlavorOf(list),
    })
  }
  return entries.sort((a, b) => a.num - b.num)
}

export function analyzeShortCollection(entries: ShortPieceIndexEntry[]): ShortCollectionReport {
  return {
    count: entries.length,
    entries,
    risks: [
      ...recentRepeatRisks(entries, 'targetEmotion', '目标情绪'),
      ...recentRepeatRisks(entries, 'reversalType', '反转类型'),
      ...recentRepeatRisks(entries, 'endingFlavor', '结尾味道'),
      ...collectionRepeatRisk(entries, 'coreReversal', '核心反转'),
      ...objectRepeatRisks(entries),
    ],
  }
}

export function formatShortCollectionReport(report: ShortCollectionReport): string {
  if (report.count === 0) return ''
  const lines: string[] = []
  lines.push('短篇集节奏体检')
  lines.push('─'.repeat(48))
  lines.push(`  已定稿 ${report.count} 篇；索引维度：目标情绪 / 反转类型 / 结构物件 / 结尾味道`)
  if (report.risks.length === 0) {
    lines.push('  ✓ 暂未发现明显重复风险')
  } else {
    lines.push('  ⚠ 重复风险（建议复核，非判决）：')
    for (const risk of report.risks.slice(0, 8)) {
      lines.push(`  · ${risk.message}（篇 ${risk.pieces.join('、')}）`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

function readListIfExists(path: string): PieceList | null {
  if (!existsSync(path)) return null
  const r = readPieceList(path)
  return r.ok ? r.list : null
}

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function collectStructureObjects(list: PieceList | null): string[] {
  if (!list) return []
  const raw = [
    ...list.伏笔回收.map((p) => p.伏笔),
    ...list.反转线索表.铺垫点.map((p) => p.内容),
  ]
  const objects = raw.map(extractObject).filter((v) => v.length > 0)
  return [...new Set(objects)].slice(0, 6)
}

function endingFlavorOf(list: PieceList | null): string {
  const curve = list?.情绪曲线 ?? []
  const last = [...curve].reverse().find((p) => !isPlaceholder(p.情绪))
  return cleanValue(last?.情绪)
}

function recentRepeatRisks(
  entries: ShortPieceIndexEntry[],
  field: 'targetEmotion' | 'reversalType' | 'endingFlavor',
  label: string,
): ShortCollectionRisk[] {
  if (entries.length < 3) return []
  const recent = entries.slice(-3)
  const values = recent.map((entry) => entry[field]).filter((v) => v.length > 0 && v !== '未知')
  if (values.length !== 3) return []
  if (new Set(values).size !== 1) return []
  return [{
    kind: 'recent-repeat',
    field,
    message: `最近 3 篇${label}都为「${values[0]}」`,
    pieces: recent.map((entry) => entry.num),
  }]
}

function collectionRepeatRisk(
  entries: ShortPieceIndexEntry[],
  field: 'coreReversal',
  label: string,
): ShortCollectionRisk[] {
  const grouped = groupBy(entries, (entry) => normalize(entry[field]))
  const risks: ShortCollectionRisk[] = []
  for (const [key, group] of grouped) {
    if (!key || group.length < 2) continue
    risks.push({
      kind: 'collection-repeat',
      field,
      message: `${label}重复：「${group[0]![field]}」出现 ${group.length} 次`,
      pieces: group.map((entry) => entry.num),
    })
  }
  return risks
}

function objectRepeatRisks(entries: ShortPieceIndexEntry[]): ShortCollectionRisk[] {
  const pairs = entries.flatMap((entry) => entry.structureObjects.map((object) => ({ entry, object })))
  const grouped = groupBy(pairs, (pair) => normalize(pair.object))
  const risks: ShortCollectionRisk[] = []
  for (const [key, group] of grouped) {
    const nums = [...new Set(group.map((pair) => pair.entry.num))]
    if (!key || nums.length < 2) continue
    risks.push({
      kind: 'collection-repeat',
      field: 'structureObject',
      message: `结构物件/伏笔「${group[0]!.object}」重复出现`,
      pieces: nums,
    })
  }
  return risks
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    if (!key) continue
    const group = map.get(key) ?? []
    group.push(item)
    map.set(key, group)
  }
  return map
}

function classifyReversal(text: string): string {
  const t = normalize(text)
  if (!t) return '未知'
  if (/死者|尸体|亡者|鬼|幽灵/.test(t)) return '死者反转'
  if (/凶手|真凶|杀手|犯人/.test(t)) return '真凶反转'
  if (/自己|本人|主角|我/.test(t)) return '自我反转'
  if (/亲人|父亲|母亲|哥哥|姐姐|弟弟|妹妹|妻子|丈夫|恋人/.test(t)) return '亲密关系反转'
  if (/身份|卧底|替身|冒名|伪装|假扮/.test(t)) return '身份反转'
  if (/时间|循环|未来|过去|记忆/.test(t)) return '时间/记忆反转'
  if (/梦|幻觉|剧本|游戏|实验/.test(t)) return '现实层反转'
  return '其他反转'
}

function extractObject(text: string): string {
  const cleaned = cleanValue(text)
    .replace(/^(开头|中段|尾声|结尾|反转|铺垫|升级)/, '')
    .replace(/[，。！？、；：:]/g, ' ')
    .trim()
  const quoted = cleaned.match(/「([^」]{1,12})」/)
  if (quoted) return quoted[1]!.trim()
  const compact = cleaned.replace(/\s+/g, '')
  if (compact.length <= 12) return compact
  return compact.slice(0, 12)
}

function firstReal(...values: (string | undefined)[]): string {
  for (const value of values) {
    const cleaned = cleanValue(value)
    if (!isPlaceholder(cleaned)) return cleaned
  }
  return ''
}

function cleanValue(value: string | undefined): string {
  return (value ?? '').trim()
}

function normalize(value: string): string {
  return value.replace(/\s+/g, '').replace(/[，。！？、；：:「」"'（）()]/g, '').trim()
}

function isPlaceholder(value: string | undefined): boolean {
  const v = cleanValue(value)
  return v === '' || v === '待定' || v === '待补' || v === '（待补）'
}
