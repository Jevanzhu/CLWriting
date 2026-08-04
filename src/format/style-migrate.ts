/**
 * 文风库一次性迁移 —— 旧四散存储 → 统一条目库（文风系统重整）。
 *
 * 样章库/金句库：搬移（迁移后删旧文件，空目录顺手清掉）。
 * 文风铁律：提取（反和解禁词 / AI 味替换表 → 禁词条目）后瘦身为纯配置
 *   （S5 收口：保留可量化约束 + 删除分级，禁词知识归条目库；机检禁词走
 *   readIronRules 合并条目库，行为不缺失）。
 *
 * 幂等：文风/条目/ 目录已存在 → no-op。
 * 回退依赖 git 托管（文风/ 不在 gitignore，误迁可 checkout 回退）。
 * 消费方触发（同伏笔迁移范式）：首次进文风视图时调用，结果落 toast。
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, rmSync, rmdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { readSamplesByScene } from './style.js'
import { writeEntry, ENTRIES_DIR } from './style-entry.js'
import { parseIronRules } from '../check/count.js'
import type { StyleEntry, EntryKind, EntrySource, SampleSource } from './types.js'

/** 迁移结果（伏笔迁移同构 + 类型分布供 toast） */
export interface StyleMigrateResult {
  migrated: number
  skipped: number
  details: string[]
  byKind: Partial<Record<EntryKind, number>>
}

/** 旧样章来源 → 条目来源（作者原作=作者标注；其余同名） */
const SAMPLE_SOURCE_MAP: Record<SampleSource, EntrySource> = {
  作者原作: '作者标注',
  题材范文: '题材范文',
  导入: '导入',
}

/**
 * 金句文件拆条：`- 正文（尾随两空格）\n  ——出处` 列表 → 条目素材。
 * 宽松解析：`- ` 起新条；`——` 行归出处；标题/说明行忽略；续行并入正文。
 */
export function parseQuoteEntries(text: string): { 正文: string; 出处?: string }[] {
  const out: { 正文: string; 出处?: string }[] = []
  let cur: { 正文: string; 出处?: string } | null = null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('- ')) {
      cur = { 正文: line.slice(2).trimEnd() }
      out.push(cur)
    } else if (line.startsWith('——')) {
      if (cur) cur.出处 = line.slice(2).trim()
    } else if (cur) {
      cur.正文 += '\n' + line
    }
  }
  return out.filter((q) => q.正文.trim().length > 0)
}

/**
 * 铁律「AI 味替换参考」表格行 → {词, 替换方向}。
 * 段定位：## 标题含「AI 味替换」起，至下一 ## 或文末；跳表头与分隔行。
 */
export function parseAiFlavorRows(text: string): { 词: string; 替换: string }[] {
  const secM = text.match(/^##[^\n]*AI\s*味替换[^\n]*$/m)
  if (!secM || secM.index === undefined) return []
  const rest = text.slice(secM.index + secM[0].length)
  const nextSec = rest.search(/^##\s/m)
  const section = nextSec === -1 ? rest : rest.slice(0, nextSec)

  const rows: { 词: string; 替换: string }[] = []
  for (const rawLine of section.split('\n')) {
    const m = rawLine.trim().match(/^\|([^|]+)\|([^|]+)\|$/)
    if (!m) continue
    const 词 = m[1]!.trim()
    const 替换 = m[2]!.trim()
    if (!词 || /^-+$/.test(词) || 词 === 'AI 味表达' || 替换 === '替换方向') continue
    rows.push({ 词, 替换 })
  }
  return rows
}

/** 条目落新库（迁移内部：序号内存计数，避免每写一个都扫盘） */
function makeWriter(bookRoot: string, result: StyleMigrateResult) {
  const entriesDir = join(bookRoot, ENTRIES_DIR)
  const seq = new Map<string, number>()
  return (e: StyleEntry): void => {
    const key = `${e.类型}/${e.场景}`
    const n = (seq.get(key) ?? 0) + 1
    seq.set(key, n)
    const dir = join(entriesDir, e.类型)
    mkdirSync(dir, { recursive: true })
    writeEntry(join(dir, `${e.场景}-${String(n).padStart(3, '0')}.md`), e)
    result.migrated++
    result.byKind[e.类型] = (result.byKind[e.类型] ?? 0) + 1
  }
}

/** 尝试删空目录（非空/不存在都静默） */
function rmdirIfEmpty(dir: string): void {
  try {
    rmdirSync(dir)
  } catch {
    /* 非空或不存在 */
  }
}

/**
 * 铁律瘦身（S5）：删「反和解段」「AI 味替换参考」段（知识已入条目库），
 * 保留头部引言、可量化约束、删除分级及作者自加段（保守：未知段一律保留）。
 */
export function slimIronRules(text: string): string {
  const out: string[] = []
  let dropping = false
  for (const line of text.split('\n')) {
    if (/^##\s/.test(line)) {
      dropping = /反和解|AI\s*味替换/.test(line)
    }
    if (!dropping) out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

/**
 * 执行迁移。已迁移（条目目录存在）→ no-op。
 * 旧样章库/金句库不存在也算正常（新书或纯手动书），只做铁律提取。
 */
export function migrateStyleLibrary(bookRoot: string): StyleMigrateResult {
  const result: StyleMigrateResult = { migrated: 0, skipped: 0, details: [], byKind: {} }
  const entriesDir = join(bookRoot, ENTRIES_DIR)
  if (existsSync(entriesDir)) return result // 幂等闸：已迁移

  const styleDir = join(bookRoot, '文风')
  if (!existsSync(styleDir)) return result // 无文风目录（异常书），不建库

  const write = makeWriter(bookRoot, result)

  // ── 1. 样章库搬移：文风/样章库/<场景>/*.md → 条目/样章/ ──
  const sampleDir = join(styleDir, '样章库')
  if (existsSync(sampleDir)) {
    let scenes: string[] = []
    try {
      scenes = readdirSync(sampleDir).filter((d) => !d.startsWith('.'))
    } catch {
      /* 读失败按空 */
    }
    for (const scene of scenes) {
      const sceneDir = join(sampleDir, scene)
      const { samples, errors } = readSamplesByScene(sampleDir, scene)
      for (const s of samples) {
        write({
          类型: '样章',
          场景: s.场景,
          来源: SAMPLE_SOURCE_MAP[s.来源] ?? '导入',
          ...(s.技法指令 ? { 说明: s.技法指令 } : {}),
          ...(s.出处 ? { 出处: s.出处 } : {}),
          ...(s.标签 ? { 标签: s.标签 } : {}),
          正文: s.正文,
          ...(s._raw ? { _raw: s._raw } : {}),
        })
        if (s._path) rmSync(s._path, { force: true })
      }
      result.skipped += errors.length
      for (const e of errors) result.details.push(`跳过（解析失败）：${e.file}`)
      rmdirIfEmpty(sceneDir)
    }
    if (result.byKind['样章']) result.details.push(`样章库 → ${result.byKind['样章']} 条样章`)
    rmdirIfEmpty(sampleDir)
  }

  // ── 2. 金句拆条：金句库/<场景>.md（收割）+ 金句库.md（onboard 导入，通用场景）──
  let quoteCount = 0
  const quoteDir = join(styleDir, '金句库')
  if (existsSync(quoteDir)) {
    let files: string[] = []
    try {
      files = readdirSync(quoteDir).filter((f) => f.endsWith('.md') && !f.startsWith('._'))
    } catch {
      /* 读失败按空 */
    }
    for (const f of files) {
      const fp = join(quoteDir, f)
      const scene = f.slice(0, -3)
      for (const q of parseQuoteEntries(readFileSync(fp, 'utf-8'))) {
        write({
          类型: '样章',
          场景: scene,
          来源: '收割',
          标签: ['金句'],
          ...(q.出处 ? { 出处: q.出处 } : {}),
          正文: q.正文,
        })
        quoteCount++
      }
      rmSync(fp, { force: true })
    }
    rmdirIfEmpty(quoteDir)
  }
  const quoteFile = join(styleDir, '金句库.md')
  if (existsSync(quoteFile)) {
    for (const q of parseQuoteEntries(readFileSync(quoteFile, 'utf-8'))) {
      write({
        类型: '样章',
        场景: '通用',
        来源: '导入',
        标签: ['金句'],
        ...(q.出处 ? { 出处: q.出处 } : {}),
        正文: q.正文,
      })
      quoteCount++
    }
    rmSync(quoteFile, { force: true })
  }
  if (quoteCount > 0) result.details.push(`金句库 → ${quoteCount} 条样章（标签: 金句）`)

  // ── 3. 铁律：提取（反和解禁词 + AI 味替换表 → 禁词条目）→ 瘦身为纯配置 ──
  const rulesFile = join(styleDir, '文风铁律.md')
  if (existsSync(rulesFile)) {
    const rulesText = readFileSync(rulesFile, 'utf-8')
    const seen = new Set<string>()
    const banned = parseIronRules(rulesText).bannedWords ?? []
    for (const word of banned) {
      if (seen.has(word)) continue
      seen.add(word)
      write({ 类型: '禁词', 场景: '通用', 来源: '导入', 正文: word })
    }
    let flavorCount = 0
    for (const row of parseAiFlavorRows(rulesText)) {
      if (seen.has(row.词)) continue // 硬禁词优先，重合跳过软表行
      seen.add(row.词)
      write({ 类型: '禁词', 场景: '通用', 来源: '导入', 标签: ['AI味'], 说明: row.替换, 正文: row.词 })
      flavorCount++
    }
    if (banned.length > 0) result.details.push(`铁律反和解段 → ${banned.length} 条禁词`)
    if (flavorCount > 0) result.details.push(`铁律 AI 味表 → ${flavorCount} 条禁词（标签: AI味）`)
    // 瘦身写回（机检禁词已由 readIronRules 合并条目库，不缺失）
    const slimmed = slimIronRules(rulesText)
    if (slimmed !== rulesText) {
      writeFileSync(rulesFile, slimmed, 'utf-8')
      result.details.push('铁律瘦身为纯配置（禁词知识归条目库）')
    }
  }

  // 空迁移（三源皆无产出）也建条目目录骨架——幂等闸生效，下次不再扫
  mkdirSync(entriesDir, { recursive: true })
  return result
}
