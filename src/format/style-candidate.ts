/**
 * 文风候选箱 —— 文风系统重整 S4（四源 → 候选 → 作者确认 → 条目库）。
 *
 * 「候选制，品味归人」红线：候选永不自动入库，作者确认才 addEntry。
 * 四源：①改稿轨迹（比对层信号）②机检漂移（固定映射表，不耗 AI）
 *      ③AI 语义分析（口癖→禁词、建议→手法）④作者手动（不经候选箱，直达条目库）
 *
 * 存储：文风/候选/<源>-<ulid>.md（进 git，跨机器可续）
 * fm：类型/场景/来源/说明/标签/状态/创建 + 证据标量（章号/相似度/频次）
 * body：候选正文；样章候选追加「## AI版」节存对照证据
 * 过期：待确认满 30 天 → 呈现为已忽略（effectiveStatus 读时判定，文件不动，可翻出）
 */

import { readdirSync, statSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { readFile, writeFile, parseFlat, stringifyFlat } from './frontmatter.js'
import { addEntry, readEntries, ENTRIES_DIR } from './style-entry.js'
import { ulid } from '../fs/id.js'
import { resolveWithinRoot } from '../fs/safe-path.js'
import type { StyleEntry, EntryKind, EntrySource, ParseError } from './types.js'

/** 书内候选箱相对路径 */
export const CANDIDATES_DIR = '文风/候选'

/** 待确认超此天数 → 呈现为已忽略（防候选箱堆积） */
export const CANDIDATE_TTL_DAYS = 30

/** 样章候选最短段长（与注入预算「样章 50–500 字」下限一致，太短没样章价值） */
export const MIN_SAMPLE_PARA = 50

/** 禁词候选跨章频次门槛（missing n-gram 出现的文档数 ≥ 此值才成候选） */
export const DEFAULT_FREQ_THRESHOLD = 3

export type CandidateStatus = '待确认' | '已忽略'

export interface StyleCandidate {
  类型: EntryKind
  场景: string
  来源: EntrySource
  说明?: string
  标签?: string[]
  正文: string // 确认后即条目正文（样章候选 = 作者版段落）
  状态: CandidateStatus
  创建: string // YYYY-MM-DD；缺失视为不过期
  章号?: number
  相似度?: number // 0–100，样章候选段级证据
  频次?: number // 禁词候选跨章计数
  AI版?: string // 样章候选对照证据（body「## AI版」节）
  _path?: string
}

const AI_SECTION = '## AI版'
const ENTRY_KIND_SET = new Set(['样章', '手法', '反例', '禁词'])
const SOURCE_SET = new Set(['作者标注', '改稿行为', '收割', '题材范文', '导入'])

// ── 读写 ──────────────────────────────────────────

/** 读取一个候选 md（容错；候选是机器建的，类型非法即坏文件） */
export function readCandidate(
  filePath: string,
): { ok: true; candidate: StyleCandidate } | { ok: false; error: ParseError } {
  const r = readFile(filePath)
  if (!r.ok) return r

  const map = parseFlat(r.fmRaw)
  const kind = map.get('类型')
  if (typeof kind !== 'string' || !ENTRY_KIND_SET.has(kind)) {
    return { ok: false, error: { file: filePath, line: 0, message: '缺少或非法字段：类型' } }
  }

  // body 拆正文 /「## AI版」证据节
  const idx = r.body.indexOf(AI_SECTION)
  const 正文 = (idx === -1 ? r.body : r.body.slice(0, idx)).trim()
  const aiPart = idx === -1 ? '' : r.body.slice(idx + AI_SECTION.length).trim()

  const source = map.get('来源')
  const status = map.get('状态')
  const candidate: StyleCandidate = {
    类型: kind as EntryKind,
    场景: typeof map.get('场景') === 'string' && map.get('场景') ? String(map.get('场景')) : '通用',
    来源: typeof source === 'string' && SOURCE_SET.has(source) ? (source as EntrySource) : '收割',
    ...(map.has('说明') ? { 说明: String(map.get('说明')) } : {}),
    ...(Array.isArray(map.get('标签')) ? { 标签: map.get('标签') as string[] } : {}),
    正文,
    状态: status === '已忽略' ? '已忽略' : '待确认',
    创建: typeof map.get('创建') === 'string' ? String(map.get('创建')) : '',
    ...(typeof map.get('章号') === 'number' ? { 章号: map.get('章号') as number } : {}),
    ...(typeof map.get('相似度') === 'number' ? { 相似度: map.get('相似度') as number } : {}),
    ...(typeof map.get('频次') === 'number' ? { 频次: map.get('频次') as number } : {}),
    ...(aiPart ? { AI版: aiPart } : {}),
    _path: filePath,
  }
  return { ok: true, candidate }
}

/** 写入候选 md */
export function writeCandidate(filePath: string, c: StyleCandidate): void {
  const map = new Map<string, unknown>()
  map.set('类型', c.类型)
  map.set('场景', c.场景)
  map.set('来源', c.来源)
  if (c.说明) map.set('说明', c.说明)
  if (c.标签 && c.标签.length > 0) map.set('标签', c.标签)
  map.set('状态', c.状态)
  if (c.创建) map.set('创建', c.创建)
  if (c.章号 !== undefined) map.set('章号', c.章号)
  if (c.相似度 !== undefined) map.set('相似度', c.相似度)
  if (c.频次 !== undefined) map.set('频次', c.频次)
  const body = c.AI版 ? `${c.正文}\n\n${AI_SECTION}\n\n${c.AI版}` : c.正文
  writeFile(filePath, stringifyFlat(map), body)
}

/** 读候选箱全部候选（目录不存在 → 空；文件序即 ulid 序） */
export function readCandidates(candidatesDir: string): {
  candidates: StyleCandidate[]
  errors: ParseError[]
} {
  const candidates: StyleCandidate[] = []
  const errors: ParseError[] = []
  let files: string[]
  try {
    files = readdirSync(candidatesDir).filter((f) => f.endsWith('.md') && !f.startsWith('._'))
  } catch {
    return { candidates, errors }
  }
  for (const f of files.sort()) {
    const fp = join(candidatesDir, f)
    // 低-3（第十轮）：readdir 与 stat 之间文件可能被删——对齐 leads.ts readLeadDir
    // 的守卫写法（单文件 stat 失败跳过不中断），此前裸 statSync 的 ENOENT 会抛穿整箱读取
    let isFile = false
    try {
      isFile = statSync(fp).isFile()
    } catch {
      continue
    }
    if (!isFile) continue
    const r = readCandidate(fp)
    if (r.ok) candidates.push(r.candidate)
    else errors.push(r.error)
  }
  return { candidates, errors }
}

/** 呈现状态：待确认满 30 天 → 已忽略（文件不动，作者可从已忽略列表翻出） */
export function effectiveStatus(c: StyleCandidate, today: string): CandidateStatus {
  if (c.状态 !== '待确认' || !c.创建) return c.状态
  const created = Date.parse(c.创建)
  const now = Date.parse(today)
  if (Number.isNaN(created) || Number.isNaN(now)) return c.状态
  return now - created > CANDIDATE_TTL_DAYS * 86400000 ? '已忽略' : '待确认'
}

/**
 * 新增候选落盘：文风/候选/<源>-<ulid>.md。
 * @returns 相对书仓库路径
 */
export function addCandidate(bookRoot: string, c: StyleCandidate): string {
  const dir = join(bookRoot, CANDIDATES_DIR)
  mkdirSync(dir, { recursive: true })
  const fileName = `${c.来源}-${ulid()}.md`
  writeCandidate(join(dir, fileName), c)
  return `${CANDIDATES_DIR}/${fileName}`
}

// ── 确认 / 忽略 ───────────────────────────────────

/**
 * 作者确认：候选 → 条目库（唯一入库通道），删候选文件。
 * @returns 条目相对路径；候选读不出 → null
 */
export function confirmCandidate(bookRoot: string, candidateRelPath: string): string | null {
  // P2-SEC-1 / M-7 内层收口：统一委托 resolveWithinRoot（symlink 双侧 realpath + fail-closed）
  // ——此前手写 relative 穿越 check 是全库第五套平行实现，无 symlink 防护（API 层已补，
  // 内层再收口防裸调用绕过 + 防后来者照抄弱实现）
  const safe = resolveWithinRoot(bookRoot, candidateRelPath)
  if (!safe) return null
  const fp = safe.abs
  const r = readCandidate(fp)
  if (!r.ok) return null
  const c = r.candidate
  const entry: StyleEntry = {
    类型: c.类型,
    场景: c.场景,
    来源: c.来源,
    ...(c.说明 ? { 说明: c.说明 } : {}),
    ...(c.章号 !== undefined ? { 出处: `第${c.章号}章` } : {}),
    ...(c.标签 && c.标签.length > 0 ? { 标签: c.标签 } : {}),
    正文: c.正文,
  }
  // R64-15（十二轮）：内容级去重——addEntry 与 rmSync(候选) 非原子，窗口内崩溃重试
  // 会再入一条（序号不同即文件名不同，此前无内容判重）。同类型同场景同正文已存在 →
  // 复用既有条目路径（候选照删，幂等重试安全）。
  const dup = readEntries(join(bookRoot, ENTRIES_DIR), c.类型).entries.find(
    (x) => x.场景 === entry.场景 && x.正文 === entry.正文,
  )
  const entryPath =
    dup?._path !== undefined
      ? `${ENTRIES_DIR}/${c.类型}/${basename(dup._path)}`
      : addEntry(bookRoot, entry)
  rmSync(fp, { force: true })
  return entryPath
}

/** 作者忽略：状态落盘为已忽略（保留文件，去重闸靠它记住「别再骚扰」） */
export function ignoreCandidate(bookRoot: string, candidateRelPath: string): boolean {
  // M-7 内层收口：同 confirmCandidate——resolveWithinRoot 统一委托（symlink fail-closed）
  const safe = resolveWithinRoot(bookRoot, candidateRelPath)
  if (!safe) return false
  const fp = safe.abs
  const r = readCandidate(fp)
  if (!r.ok) return false
  writeCandidate(fp, { ...r.candidate, 状态: '已忽略' })
  return true
}

// ── 源 1 · 改稿轨迹 ───────────────────────────────

/** 单文档改稿信号（比对层产出的候选原料） */
export interface DocSignals {
  docId: string
  章号?: number
  /** 文风缺口段（<70%，作者版 ≥ MIN_SAMPLE_PARA 字）→ 样章候选 */
  gapParas: { authorPara: string; aiPara: string | null; sim: number }[]
  /** surface 段缺失 n-gram → 跨文档聚合成禁词候选 */
  missing: string[]
}

/**
 * 多文档信号 → 候选对象（纯函数，查重交给 persistCandidates）。
 * 样章：每 gap 段一条；禁词：missing n-gram 出现文档数 ≥ freqThreshold。
 */
export function aggregateSignals(
  signals: DocSignals[],
  today: string,
  freqThreshold = DEFAULT_FREQ_THRESHOLD,
): StyleCandidate[] {
  const out: StyleCandidate[] = []
  for (const s of signals) {
    for (const p of s.gapParas) {
      out.push({
        类型: '样章',
        场景: '通用', // 场景标注交作者确认时改（classifyScene 词表已弃）
        来源: '改稿行为',
        正文: p.authorPara,
        状态: '待确认',
        创建: today,
        ...(s.章号 !== undefined ? { 章号: s.章号 } : {}),
        相似度: Math.round(p.sim * 100),
        ...(p.aiPara ? { AI版: p.aiPara } : {}),
      })
    }
  }
  const freq = new Map<string, number>()
  for (const s of signals) {
    for (const g of new Set(s.missing)) freq.set(g, (freq.get(g) ?? 0) + 1)
  }
  for (const [gram, count] of freq) {
    if (count < freqThreshold) continue
    out.push({
      类型: '禁词',
      场景: '通用',
      来源: '改稿行为',
      正文: gram,
      状态: '待确认',
      创建: today,
      频次: count,
    })
  }
  return out
}

// ── 源 2 · 机检漂移（固定映射表，不耗 AI）─────────

const DRIFT_TIPS: Record<string, string> = {
  dialogueTag: '对话不用提示语，用动作断句',
  variance: '长短句交替，避免节奏僵化',
  summaryEnding: '结尾落在动作或物件上，不做情绪总结',
}

/** 漂移信号 → 手法候选（同 metric 只产一条；说明=漂移证据原句） */
export function mapDriftsToCandidates(
  drifts: { metric: string; message: string }[],
  today: string,
): StyleCandidate[] {
  const out: StyleCandidate[] = []
  const seen = new Set<string>()
  for (const d of drifts) {
    const tip = DRIFT_TIPS[d.metric]
    if (!tip || seen.has(d.metric)) continue
    seen.add(d.metric)
    out.push({
      类型: '手法',
      场景: '通用',
      来源: '收割',
      说明: d.message,
      正文: tip,
      状态: '待确认',
      创建: today,
    })
  }
  return out
}

// ── 源 3 · AI 语义分析 ────────────────────────────

/** analysis.style 产出转候选：口癖 → 禁词，建议 → 手法 */
export function mapAnalysisToCandidates(
  style: { 口癖?: string[]; 建议?: string[] },
  today: string,
): StyleCandidate[] {
  const out: StyleCandidate[] = []
  for (const w of style.口癖 ?? []) {
    const word = w.trim()
    if (!word) continue
    out.push({ 类型: '禁词', 场景: '通用', 来源: '收割', 正文: word, 状态: '待确认', 创建: today })
  }
  for (const s of style.建议 ?? []) {
    const tip = s.trim()
    if (!tip) continue
    out.push({ 类型: '手法', 场景: '通用', 来源: '收割', 正文: tip, 状态: '待确认', 创建: today })
  }
  return out
}

// ── 落盘（查重闸）─────────────────────────────────

/**
 * 批量落盘候选，同「类型+正文」查重：已在候选箱（含已忽略——作者忽略过的
 * 不再骚扰）或已在条目库 → 跳过。
 */
export function persistCandidates(
  bookRoot: string,
  candidates: StyleCandidate[],
): { created: string[]; skipped: number } {
  // 查重 key：SOH 分隔符（正文/类型不会含 → 防碰撞），避免 NUL 使文件被工具链当二进制。
  // 低-2（第十轮）：分隔符此前是源码里的裸 0x01 控制字节——多数查看器不可见，复审时
  // 被误判为「实现没有分隔符」；改写成显式 \u0001 转义，运行时字符串逐字节不变
  const key = (kind: string, text: string): string => `${kind}\u0001${text}`
  const existing = new Set<string>()
  for (const c of readCandidates(join(bookRoot, CANDIDATES_DIR)).candidates) {
    existing.add(key(c.类型, c.正文))
  }
  if (existsSync(join(bookRoot, ENTRIES_DIR))) {
    for (const e of readEntries(join(bookRoot, ENTRIES_DIR)).entries) {
      existing.add(key(e.类型, e.正文))
    }
  }
  const created: string[] = []
  let skipped = 0
  for (const c of candidates) {
    const k = key(c.类型, c.正文)
    if (existing.has(k)) {
      skipped++
      continue
    }
    existing.add(k) // 本批内去重
    created.push(addCandidate(bookRoot, c))
  }
  return { created, skipped }
}
