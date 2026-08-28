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

import { existsSync, readdirSync, readFileSync, rmSync, rmdirSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readSamplesByScene } from './style.js'
import { writeEntryExclusive, readEntries, ENTRIES_DIR } from './style-entry.js'
import { parseIronRules } from './iron-rules.js'
import { atomicWriteFile } from '../fs/atomic.js'
import { sanitizeChapterTitle } from './filename.js'
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

/** 条目落新库（迁移内部：序号内存计数，避免每写一个都扫盘）。
 *  RB-KN-P2-4：续跑时序号从盘上既有条目之后起——中途崩溃重启不得覆写已迁条目。 */
function makeWriter(bookRoot: string, result: StyleMigrateResult) {
  const entriesDir = join(bookRoot, ENTRIES_DIR)
  const seq = new Map<string, number>()
  // 播种既有序号：<类型>/<场景>-NNN.md 取最大 N（续跑防覆写）
  try {
    for (const kind of readdirSync(entriesDir)) {
      const kindDir = join(entriesDir, kind)
      let files: string[] = []
      try {
        files = readdirSync(kindDir)
      } catch {
        continue
      }
      for (const f of files) {
        const m = f.match(/^(.+)-(\d{3,})\.md$/)
        if (m) {
          const key = `${kind}/${m[1]}`
          const n = Number(m[2])
          seq.set(key, Math.max(seq.get(key) ?? 0, n))
        }
      }
    }
  } catch {
    /* 条目目录不存在（首次迁移）→ 空播种 */
  }
  return (e: StyleEntry): void => {
    // B-5（第六十轮）：类型/场景来自旧样章目录名与 fm 字段（磁盘可篡改数据面）——
    // 消毒后再拼文件名（Y-27 同族漂移：style-entry.addEntry 已走 sanitizeChapterTitle
    // 单源，本迁移写点漏网，`../evil` 类场景可越出条目目录落文件）；空结果兜底防
    // `NNN.md` 劣化名。seq key 同步用消毒值——续跑播种从文件名取键，键值一致才防覆写
    const kind = sanitizeChapterTitle(e.类型) || '未分类'
    const scene = sanitizeChapterTitle(e.场景) || '未命名'
    const key = `${kind}/${scene}`
    let n = (seq.get(key) ?? 0) + 1
    const dir = join(entriesDir, kind)
    mkdirSync(dir, { recursive: true })
    // R66-20（十四轮）：writeEntry 是 atomic-rename 覆盖语义——双进程同跑各自播种出
    // 同序号时，后写静默互覆前写（丢条目无痕）；改走 O_EXCL 排他写，EEXIST → 序号 +1
    // 重试（addEntry 排他分支同款），上限 32 次防病态环。续跑播种仍在写入前（RB-KN-P2-4 不变）。
    let wrote = false
    for (let attempt = 0; attempt < 32 && !wrote; attempt++) {
      wrote = writeEntryExclusive(join(dir, `${scene}-${String(n).padStart(3, '0')}.md`), e)
      if (!wrote) n++
    }
    if (!wrote) throw new Error(`迁移条目写入失败：${kind}/${scene} 连续 32 次序号撞名`)
    seq.set(key, n)
    result.migrated++
    // 合法类型值（金句/样章/…）消毒为恒等映射，as 仅收窄回索引类型
    result.byKind[kind as EntryKind] = (result.byKind[kind as EntryKind] ?? 0) + 1
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

/** R71-21：单文件安全读（同库读取族低-3 口径：单文件失败跳过不中断）——
 *  existsSync→read 间隙文件被删 / 同名目录 EISDIR 等读失败按「无该输入」返回
 *  null（调用方跳过该源），异常不再抛穿 migrateStyleLibrary。 */
function readTextSafe(p: string): string | null {
  try {
    return readFileSync(p, 'utf-8')
  } catch {
    return null
  }
}

/** RB-KN-P2-4：铁律是否仍含待迁移段（反和解 / AI 味替换）——幂等闸的续跑判定输入 */
function hasLegacyRulesSection(text: string): boolean {
  return /^##[^\n]*(反和解|AI\s*味替换)/m.test(text)
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
 * 执行迁移。旧源已清且铁律已瘦（或本无旧源）→ no-op。
 * 旧样章库/金句库不存在也算正常（新书或纯手动书），只做铁律提取。
 * RB-KN-P2-4：幂等闸改「旧源是否仍在」判定（对齐 foreshadow 迁移的可续跑范式）——
 * 原先条目目录存在即 no-op，第 N 条迁移后崩溃的书永远半迁移（剩余旧库文件无人认领）。
 */
export function migrateStyleLibrary(bookRoot: string): StyleMigrateResult {
  const result: StyleMigrateResult = { migrated: 0, skipped: 0, details: [], byKind: {} }
  const entriesDir = join(bookRoot, ENTRIES_DIR)

  const styleDir = join(bookRoot, '文风')
  if (!existsSync(styleDir)) return result // 无文风目录（异常书），不建库

  const rulesFile = join(styleDir, '文风铁律.md')
  // R71-21：读点竞态降级（低-3 口径）——existsSync→read 间隙被删/同名目录按
  // 「无该输入」处理（无遗留段），不再抛穿迁移
  const rulesRaw = readTextSafe(rulesFile)
  const rulesHasLegacy = rulesRaw !== null && hasLegacyRulesSection(rulesRaw)
  const hasLegacySource =
    existsSync(join(styleDir, '样章库')) ||
    existsSync(join(styleDir, '金句库')) ||
    existsSync(join(styleDir, '金句库.md')) ||
    rulesHasLegacy
  if (existsSync(entriesDir) && !hasLegacySource) return result // 幂等闸：已迁移完

  const write = makeWriter(bookRoot, result)

  // Y-7（第五十七轮）：样章/金句续跑查重（对齐禁词源 RB-KN-P2-4——修一处漏两处的
  // 口径不一）：条目写盘成功与旧源 rmSync 之间崩溃后，续跑对同一旧文件再拆再写会产出
  // 同内容双份、重复占据注入预算。键 = 场景 + 正文；命中 = 上次已迁，跳写并照删旧源。
  const seenSample = new Set<string>(
    readEntries(entriesDir, '样章').entries
      .map((e) => `${e.场景}\u0001${e.正文.trim()}`)
      .filter((k) => !k.endsWith('\u0001')),
  )
  const dupOrWrite = (e: StyleEntry): boolean => {
    const key = `${e.场景}\u0001${e.正文.trim()}`
    if (e.正文.trim() && seenSample.has(key)) return false
    seenSample.add(key)
    write(e)
    return true
  }

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
        dupOrWrite({
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
      // R71-21：同名目录守卫（对齐 style.ts 低-3 的 statSync isFile 写法）——金句库出现
      // 名以 .md 结尾的目录时 readdir 会列出，裸 readFileSync 直接 EISDIR 抛穿整次迁移；
      // readdir→read 间隙被删同按「无该输入」跳过（未成功读取的源不 rm，留给续跑）
      let isFile = false
      try {
        isFile = statSync(fp).isFile()
      } catch {
        continue
      }
      if (!isFile) continue
      const text = readTextSafe(fp)
      if (text === null) continue
      const scene = f.slice(0, -3)
      for (const q of parseQuoteEntries(text)) {
        if (dupOrWrite({
          类型: '样章',
          场景: scene,
          来源: '收割',
          标签: ['金句'],
          ...(q.出处 ? { 出处: q.出处 } : {}),
          正文: q.正文,
        })) quoteCount++
      }
      rmSync(fp, { force: true })
    }
    rmdirIfEmpty(quoteDir)
  }
  const quoteFile = join(styleDir, '金句库.md')
  // R71-21：读点竞态降级（低-3 口径）——existsSync→read 间隙被删/同名目录读失败按
  // 「无该输入」跳过整源（含 rm：未成功读取的源不删，留给续跑），不再抛穿迁移
  const quoteText = readTextSafe(quoteFile)
  if (quoteText !== null) {
    for (const q of parseQuoteEntries(quoteText)) {
      if (dupOrWrite({
        类型: '样章',
        场景: '通用',
        来源: '导入',
        标签: ['金句'],
        ...(q.出处 ? { 出处: q.出处 } : {}),
        正文: q.正文,
      })) quoteCount++
    }
    rmSync(quoteFile, { force: true })
  }
  if (quoteCount > 0) result.details.push(`金句库 → ${quoteCount} 条样章（标签: 金句）`)

  // ── 3. 铁律：提取（反和解禁词 + AI 味替换表 → 禁词条目）→ 瘦身为纯配置 ──
  // R71-21：读点竞态降级（低-3 口径）——existsSync→read 间隙被删/同名目录读失败按
  // 「无该输入」跳过铁律源（不提取不瘦身，留给续跑），不再抛穿迁移
  const rulesText = readTextSafe(rulesFile)
  if (rulesText !== null) {
    // RB-KN-P2-4：续跑去重——条目库已有同文禁词（上次写完条目、瘦身写回前崩溃）不重写
    const seen = new Set<string>(
      readEntries(entriesDir, '禁词').entries.map((e) => e.正文.trim()).filter(Boolean),
    )
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
      atomicWriteFile(rulesFile, slimmed)
      result.details.push('铁律瘦身为纯配置（禁词知识归条目库）')
    }
  }

  // 空迁移（三源皆无产出）也建条目目录骨架——幂等闸生效，下次不再扫
  mkdirSync(entriesDir, { recursive: true })
  return result
}
