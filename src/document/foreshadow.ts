/**
 * 伏笔足迹扫描 —— 本地正文 grep，零 AI 成本（伏笔系统整合 T2）。
 *
 * 对每个设定伏笔的「关联词」在 定稿/正文/*.md 中做文本搜索，
 * 发现首次命中（=埋设点）、末次命中（=最近提及），计算悬置跨度与风险等级。
 *
 * 设计决策（伏笔系统整合.md）：
 * - 足迹是扫出来的正文事实，比手填章号/推进履历准
 * - 关联词由作者手填（作者最清楚正文怎么称呼），grep 精确、可验证、零 AI 成本
 * - 风险阈值按重要性：高=30 章 / 中=60 章 / 低=100 章
 */

import { readdirSync, statSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { readFile, parseFlat } from '../format/frontmatter.js'
import { readLead } from '../format/leads.js'

// ── 伏笔条目（fm 数据）──────────────────────────

/** 设定伏笔条目（从 定稿/设定/伏笔/*.md 的 fm 读取） */
export interface ForeshadowEntry {
  /** 相对路径（定稿/设定/伏笔/xxx.md） */
  file: string
  标题: string
  状态: string // 未回收 / 已回收 / 已废弃
  埋设章号: number | null
  回收章号: number | null
  重要性: string // 高 / 中 / 低
  /** 正文 grep 关键词（逗号分隔 → 数组） */
  关联词: string[]
  /** 正文前 100 字摘要 */
  摘要: string
}

/** fm 值 → 正整数（非法/空 → null） */
function parsePositiveInt(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 账本伏笔状态 → 设定伏笔状态映射 */
const LEGACY_STATUS_MAP: Record<string, string> = {
  进行中: '未回收',
  已收尾: '已回收',
  已放弃: '已废弃',
}

/** 迁移结果 */
export interface MigrateResult {
  migrated: number
  skipped: number
  details: string[]
}

/**
 * 一次性迁移：大纲/伏笔/*.md → 定稿/设定/伏笔/*.md（账本伏笔类已删，旧数据自动转设定伏笔）。
 *
 * 幂等：旧目录不存在或空 → no-op。迁移后旧文件删除，下次调用自动跳过。
 * fm 映射：标题→标题；状态（进行中→未回收/已收尾→已回收/已放弃→已废弃）；
 * 开启章→埋设章号；关联词默认填标题（作者后续补）；履历段压缩进正文。
 */
export function migrateLegacyForeshadows(bookRoot: string): MigrateResult {
  const oldDir = join(bookRoot, '大纲', '伏笔')
  if (!existsSync(oldDir)) return { migrated: 0, skipped: 0, details: [] }

  let files: string[]
  try {
    files = readdirSync(oldDir).filter((f) => f.endsWith('.md') && !f.startsWith('._'))
  } catch {
    return { migrated: 0, skipped: 0, details: [] }
  }
  if (files.length === 0) return { migrated: 0, skipped: 0, details: [] }

  const newDir = join(bookRoot, '定稿', '设定', '伏笔')
  mkdirSync(newDir, { recursive: true })

  const result: MigrateResult = { migrated: 0, skipped: 0, details: [] }
  for (const f of files) {
    const oldPath = join(oldDir, f)
    const r = readLead(oldPath)
    if (!r.ok) {
      result.skipped++
      result.details.push(`跳过（解析失败）：${f}`)
      continue
    }
    const lead = r.lead
    const title = lead.标题 || lead.编号
    const status = LEGACY_STATUS_MAP[lead.状态] ?? '未回收'
    const historyLines = lead.履历.length > 0
      ? ['推进记录：', ...lead.履历.map((h) => `- 第${h.章号}章 ${h.动词}：${h.证据}`)].join('\n')
      : '（无推进记录）'
    const fm = [
      '---',
      `标题: ${title}`,
      `状态: ${status}`,
      ...(lead.开启章 ? [`埋设章号: ${lead.开启章}`] : []),
      '重要性: 中',
      `关联词: ${title}`,
      '---',
      '',
      `（迁移自账本伏笔 ${lead.编号}）`,
      '',
      historyLines,
      '',
    ].join('\n')

    writeFileSync(join(newDir, `${title}.md`), fm, 'utf-8')
    rmSync(oldPath, { force: true })
    result.migrated++
    result.details.push(`${lead.编号} → ${title}（${status}）`)
  }
  return result
}

/**
 * 读设定伏笔列表（定稿/设定/伏笔/*.md 的 fm）。
 * 首次调用时自动迁移旧账本伏笔（大纲/伏笔/ → 设定/伏笔/，一次性，幂等）。
 * 容错：目录不存在或单个文件解析失败 → 跳过不崩。
 */
export function readForeshadows(bookRoot: string): ForeshadowEntry[] {
  // 一次性自动迁移（无旧数据时 no-op）
  migrateLegacyForeshadows(bookRoot)

  const dir = join(bookRoot, '定稿', '设定', '伏笔')
  if (!existsSync(dir)) return []

  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('._'))
  } catch {
    return []
  }

  const items: ForeshadowEntry[] = []
  for (const f of files) {
    const fp = join(dir, f)
    try {
      if (!statSync(fp).isFile()) continue
    } catch {
      continue
    }
    const r = readFile(fp)
    const map = r.ok ? parseFlat(r.fmRaw) : new Map<string, unknown>()
    const 关联词raw = String(map.get('关联词') ?? '')
    items.push({
      file: `定稿/设定/伏笔/${f}`,
      标题: String(map.get('标题') ?? f.replace(/\.md$/, '')),
      状态: String(map.get('状态') ?? '未回收'),
      埋设章号: parsePositiveInt(map.get('埋设章号')),
      回收章号: parsePositiveInt(map.get('回收章号')),
      重要性: String(map.get('重要性') ?? '中'),
      关联词: 关联词raw.split(',').map((s) => s.trim()).filter(Boolean),
      摘要: r.ok ? r.body.slice(0, 100).trim() : '',
    })
  }
  return items
}

// ── 足迹扫描 ────────────────────────────────────

/** 单次足迹命中 */
export interface ForeshadowHit {
  /** 命中所在章号 */
  章号: number
  /** 命中的关联词 */
  命中词: string
  /** 命中片段（命中词前后各 ~15 字上下文） */
  命中片段: string
}

/** 伏笔足迹 + 风险评估 */
export interface ForeshadowTrail {
  /** 全部命中（按章号升序） */
  hits: ForeshadowHit[]
  /** 首次命中章号（足迹优先，无命中回退 fm 埋设章号） */
  firstHit: number | null
  /** 末次命中章号（= 最近提及） */
  lastHit: number | null
  /** 悬置跨度（当前最新章号 − lastHit；无命中且无埋设章号 → 0） */
  staleSpan: number
  /** 风险等级 */
  risk: '红' | '黄' | '绿'
}

/** 重要性 → 悬置阈值（章数，伏笔系统整合.md） */
const RISK_THRESHOLDS: Record<string, number> = {
  高: 30,
  中: 60,
  低: 100,
}

/** 命中片段上下文半径（前后各 N 字） */
const SNIPPET_RADIUS = 15

/**
 * 扫描全书伏笔足迹（本地 grep，零 AI）。
 *
 * 流程：收集全部章节正文 → 对每伏笔的关联词逐章 indexOf → 汇总命中 → 算风险。
 * 已回收/已废弃的伏笔跳过扫描（风险恒绿）。
 *
 * @param bookRoot 书仓库根
 * @param foreshadows 伏笔列表（来自 readForeshadows）
 * @returns Map<标题, 足迹>
 */
export function scanForeshadowTrails(
  bookRoot: string,
  foreshadows: ForeshadowEntry[],
): Map<string, ForeshadowTrail> {
  const chapters = collectChapterTexts(bookRoot)
  const latestChapter = chapters.size > 0 ? Math.max(...chapters.keys()) : 0

  const result = new Map<string, ForeshadowTrail>()
  for (const f of foreshadows) {
    // 已回收/废弃 → 不算风险
    if (f.状态 === '已回收' || f.状态 === '已废弃') {
      result.set(f.标题, {
        hits: [],
        firstHit: f.埋设章号,
        lastHit: f.回收章号 ?? f.埋设章号,
        staleSpan: 0,
        risk: '绿',
      })
      continue
    }

    const keywords = f.关联词.length > 0 ? f.关联词 : [f.标题]
    const hits: ForeshadowHit[] = []
    for (const [章号, text] of chapters) {
      for (const kw of keywords) {
        if (!kw) continue
        const idx = text.indexOf(kw)
        if (idx !== -1) {
          const start = Math.max(0, idx - SNIPPET_RADIUS)
          const end = Math.min(text.length, idx + kw.length + SNIPPET_RADIUS)
          hits.push({ 章号, 命中词: kw, 命中片段: text.slice(start, end) })
        }
      }
    }
    hits.sort((a, b) => a.章号 - b.章号)

    const trailFirst = hits.length > 0 ? hits[0]!.章号 : null
    const trailLast = hits.length > 0 ? hits[hits.length - 1]!.章号 : null
    // 足迹优先，无命中回退 fm 埋设章号
    const firstHit = trailFirst ?? f.埋设章号
    const lastHit = trailLast ?? f.埋设章号
    const staleSpan = lastHit !== null ? Math.max(0, latestChapter - lastHit) : 0
    const threshold = RISK_THRESHOLDS[f.重要性] ?? RISK_THRESHOLDS['中']!
    const risk: '红' | '黄' | '绿' =
      staleSpan > threshold ? '红' : staleSpan > threshold * 0.7 ? '黄' : '绿'

    result.set(f.标题, { hits, firstHit, lastHit, staleSpan, risk })
  }
  return result
}

// ── 章节正文收集 ─────────────────────────────────

/** 收集 定稿/正文/ 下所有章节 md（递归含卷子目录）的 { 章号 → 正文（去 fm） } */
function collectChapterTexts(bookRoot: string): Map<number, string> {
  const texts = new Map<number, string>()
  const textDir = join(bookRoot, '定稿', '正文')
  if (!existsSync(textDir)) return texts
  walkChapters(textDir, texts)
  return texts
}

/** 递归遍历章节目录（含卷子目录，同 rebuild.ts walkChapters 结构） */
function walkChapters(dir: string, texts: Map<number, string>): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name.startsWith('._')) continue
    const fp = join(dir, name)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(fp)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walkChapters(fp, texts)
    } else if (name.endsWith('.md')) {
      const 章号 = parseChapterNoFromName(name)
      if (章号 === null) continue
      const r = readFile(fp)
      texts.set(章号, r.ok ? r.body : '')
    }
  }
}

/** 从文件名提取章号（兼容补零与不补零：0001-开篇.md / 1-标题.md → 1） */
function parseChapterNoFromName(name: string): number | null {
  const m = name.match(/^(\d{1,4})/)
  return m ? Number(m[1]) : null
}
