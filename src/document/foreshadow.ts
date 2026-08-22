/**
 * 伏笔足迹扫描 —— 本地正文 grep，零 AI 成本（伏笔系统整合 T2）。
 *
 * 对每个设定伏笔的「关联词」在 写作/正文/*.md 中做文本搜索，
 * 发现首次命中（=埋设点）、末次命中（=最近提及），计算悬置跨度与风险等级。
 *
 * 设计决策（伏笔系统整合.md）：
 * - 足迹是扫出来的正文事实，比手填章号/推进履历准
 * - 关联词由作者手填（作者最清楚正文怎么称呼），grep 精确、可验证、零 AI 成本
 * - 风险阈值按重要性：高=30 章 / 中=60 章 / 低=100 章
 */

import { readdirSync, statSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { readFile, parseFlat } from '../format/frontmatter.js'
import { readLead } from '../format/leads.js'
import { atomicWriteFile } from '../fs/atomic.js'

// ── 伏笔条目（fm 数据）──────────────────────────

/** 设定伏笔条目（从 设定/伏笔/*.md 的 fm 读取） */
export interface ForeshadowEntry {
  /** 相对路径（设定/伏笔/xxx.md） */
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
 * 一次性迁移：大纲/伏笔/*.md → 设定/伏笔/*.md（账本伏笔类已删，旧数据自动转设定伏笔）。
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

  const newDir = join(bookRoot, '设定', '伏笔')
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

    // 文件名带编号兜底，防同名标题伏笔迁移时互相覆盖丢数据（N3）
    // B-P1-5：改原子写，避免迁移过程中断留下半截目标文件
    // title 可能含路径分隔符（来自 fm 可篡改数据），净化防穿越
    const safeTitle = String(title).replace(/[/\\\0]/g, '_')
    // P2-BE-3：编号同样净化（与 safeTitle 一致——fm 可篡改，defense-in-depth）
    const safeId = String(lead.编号).replace(/[/\\\0]/g, '_')
    atomicWriteFile(join(newDir, `${safeId}-${safeTitle}.md`), fm)
    rmSync(oldPath, { force: true })
    result.migrated++
    result.details.push(`${lead.编号} → ${title}（${status}）`)
  }
  return result
}

/**
 * 读设定伏笔列表（设定/伏笔/*.md 的 fm）。
 * 纯读：迁移在服务启动时执行（index.ts 迁移链），此处不再触发写副作用。
 * 容错：目录不存在或单个文件解析失败 → 跳过不崩。
 */
export function readForeshadows(bookRoot: string): ForeshadowEntry[] {
  const dir = join(bookRoot, '设定', '伏笔')
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
      file: `设定/伏笔/${f}`,
      标题: String(map.get('标题') ?? f.replace(/\.md$/, '')),
      状态: String(map.get('状态') ?? '未回收'),
      埋设章号: parsePositiveInt(map.get('埋设章号')),
      回收章号: parsePositiveInt(map.get('回收章号')),
      重要性: String(map.get('重要性') ?? '中'),
      // X-P2-19：中文逗号也切——只切英文逗号时 `佩剑，玉佩` 整串成一个词，足迹扫描永不命中
      关联词: 关联词raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
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

/** 风险严重度排序（数值大者更坏），同标题合并时取最坏（fail-closed） */
const RISK_ORDER: Record<ForeshadowTrail['risk'], number> = { 绿: 0, 黄: 1, 红: 2 }

/**
 * 低-5（第十轮）：同标题两条伏笔的足迹合并——命中取并集、首末取极值、风险取最坏。
 * 迁移链 N3 只保证文件名不撞（编号兜底），fm 标题仍可重复；此前 Map 以标题为 key
 * 直接 set，同名后一条把前一条的足迹整个覆盖（铜锁那条只剩钥匙的足迹）。
 * key 仍用标题不改复合形状：prepare（伏笔提醒）/studio（foreshadows 端点）等存量
 * 读方都是 get(标题)，合并保住「两条足迹都在」的同时旧读法零改动（读侧兼容）。
 */
function mergeTrails(a: ForeshadowTrail, b: ForeshadowTrail, latestChapter: number): ForeshadowTrail {
  const hits = [...a.hits, ...b.hits].sort((x, y) => x.章号 - y.章号)
  // null = 无埋设章号也无命中，不参与极值比较
  const min = (x: number | null, y: number | null): number | null =>
    x === null ? y : y === null ? x : Math.min(x, y)
  const max = (x: number | null, y: number | null): number | null =>
    x === null ? y : y === null ? x : Math.max(x, y)
  const firstHit = min(a.firstHit, b.firstHit)
  const lastHit = max(a.lastHit, b.lastHit)
  // 悬置跨度按合并后的末次提及重算（最远提及决定悬置）
  const staleSpan = lastHit !== null ? Math.max(0, latestChapter - lastHit) : 0
  const risk = RISK_ORDER[a.risk] >= RISK_ORDER[b.risk] ? a.risk : b.risk
  return { hits, firstHit, lastHit, staleSpan, risk }
}

/**
 * 扫描全书伏笔足迹（本地 grep，零 AI）。
 *
 * 性能（P2-BE-4）：预建倒排索引——收集全部唯一关键词后，
 * 对每章正文用联合正则一次扫完（每章只扫一遍，不再逐伏笔 × 逐关键词 indexOf）。
 * 大书（200 章 × 50 伏笔）耗时从 10M 级字符扫描降到 ≈ 全书总字数。
 *
 * 流程：收集全部章节正文 → 倒排索引（关键词 → 章号 → 位置[]）→ 逐伏笔查表聚合 → 算风险。
 * 已回收/已废弃的伏笔跳过扫描（风险恒绿）。
 *
 * @param bookRoot 书仓库根
 * @param foreshadows 伏笔列表（来自 readForeshadows）
 * @returns Map<标题, 足迹>（同标题伏笔合并为一条足迹，见 mergeTrails——存量读方按标题 get 不变）
 */
export function scanForeshadowTrails(
  bookRoot: string,
  foreshadows: ForeshadowEntry[],
): Map<string, ForeshadowTrail> {
  const chapters = collectChapterTexts(bookRoot)
  const latestChapter = chapters.size > 0 ? Math.max(...chapters.keys()) : 0

  // 倒排索引：keyword → Map<章号, 位置[]>
  const index = buildKeywordIndex(chapters, foreshadows)

  const result = new Map<string, ForeshadowTrail>()
  // 低-5（第十轮）：同标题伏笔合并写入，不再互相覆盖
  const setTrail = (title: string, trail: ForeshadowTrail): void => {
    const prev = result.get(title)
    result.set(title, prev ? mergeTrails(prev, trail, latestChapter) : trail)
  }
  for (const f of foreshadows) {
    // 已回收/废弃 → 不算风险
    if (f.状态 === '已回收' || f.状态 === '已废弃') {
      setTrail(f.标题, {
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
    for (const kw of keywords) {
      if (!kw) continue
      const byChapter = index.get(kw)
      if (!byChapter) continue
      for (const [章号, positions] of byChapter) {
        for (const idx of positions) {
          const start = Math.max(0, idx - SNIPPET_RADIUS)
          const end = Math.min(chapters.get(章号)!.length, idx + kw.length + SNIPPET_RADIUS)
          hits.push({ 章号, 命中词: kw, 命中片段: chapters.get(章号)!.slice(start, end) })
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

    setTrail(f.标题, { hits, firstHit, lastHit, staleSpan, risk })
  }
  return result
}

/**
 * 构建关键词倒排索引（P2-BE-4）：
 * keyword → Map<章号, 位置[]>。
 *
 * 每章正文用联合正则一次扫描，命中全部关键词的位置；
 * 关键词做转义防正则元字符（如「祖父遗物（上）」）。
 */
function buildKeywordIndex(
  chapters: Map<number, string>,
  foreshadows: ForeshadowEntry[],
): Map<string, Map<number, number[]>> {
  const index = new Map<string, Map<number, number[]>>()
  const keywords = new Set<string>()

  // 收集全部待扫关键词（去重）
  for (const f of foreshadows) {
    if (f.状态 === '已回收' || f.状态 === '已废弃') continue
    const kws = f.关联词.length > 0 ? f.关联词 : [f.标题]
    for (const kw of kws) if (kw) keywords.add(kw)
  }
  if (keywords.size === 0) return index

  // 联合正则：`kw1|kw2|...`，一次扫描提取全部命中。
  // P-4（第十四轮）：按长度降序拼接——正则交替左优先，Set 插入序下短词在前会
  // 永久遮蔽同前缀长词（「玉佩」先匹配，「玉佩锁」无独立命中），风险评级漏检长关联词。
  const re = new RegExp(
    [...keywords].map(escapeRegExp).sort((a, b) => b.length - a.length).join('|'),
    'g',
  )
  for (const [章号, text] of chapters) {
    if (text.length === 0) continue
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const kw = m[0]
      let byChapter = index.get(kw)
      if (!byChapter) {
        byChapter = new Map()
        index.set(kw, byChapter)
      }
      let positions = byChapter.get(章号)
      if (!positions) {
        positions = []
        byChapter.set(章号, positions)
      }
      positions.push(m.index)
      if (m[0].length === 0) re.lastIndex++ // 防零宽匹配死循环（理论不会，防御）
    }
  }
  return index
}

/** 正则元字符转义（关联词可能含「（）」「.」等） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── 章节正文收集 ─────────────────────────────────

/** 收集 写作/正文/ 下所有章节 md（递归含卷子目录）的 { 章号 → 正文（去 fm） } */
function collectChapterTexts(bookRoot: string): Map<number, string> {
  const texts = new Map<number, string>()
  const textDir = join(bookRoot, '写作', '正文')
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
  const m = name.match(/^(\d+)-/) // P2：与 leads.ts 对齐（要求 - 分隔符）
  return m ? Number(m[1]) : null
}

// ── F1-P3 伏笔足迹 FTS 检索 ────────────────────────

/** 伏笔足迹检索命中（「哪章埋了哪章收了」可检索） */
export interface ForeshadowSearchHit {
  标题: string
  状态: string
  重要性: string
  /** 足迹（firstHit=埋设点 / lastHit=最近提及 / hits=全部命中） */
  足迹: ForeshadowTrail
}

/**
 * 伏笔足迹检索：按标题 / 关联词 / 命中片段过滤 scanForeshadowTrails 结果。
 *
 * query 为空 → 全量（按末次命中降序，最近提及在前）。
 * 匹配维度（F3/DSH-7 FTS 语义）：标题、关联词、命中词、命中片段上下文。
 *
 * @param bookRoot 书库根
 * @param query 检索词（可选；大小写不敏感）
 */
export function searchForeshadowTrails(bookRoot: string, query?: string): ForeshadowSearchHit[] {
  const entries = readForeshadows(bookRoot)
  const trails = scanForeshadowTrails(bookRoot, entries)
  const q = (query ?? '').trim().toLowerCase()
  const results: ForeshadowSearchHit[] = []
  for (const e of entries) {
    const trail = trails.get(e.标题)
    if (!trail) continue
    if (!q) {
      results.push({ 标题: e.标题, 状态: e.状态, 重要性: e.重要性, 足迹: trail })
      continue
    }
    const titleHit = e.标题.toLowerCase().includes(q)
    const kwHit = e.关联词.some((w) => w.toLowerCase().includes(q))
    const snippetHit = trail.hits.some(
      (h) => h.命中片段.toLowerCase().includes(q) || h.命中词.toLowerCase().includes(q),
    )
    if (titleHit || kwHit || snippetHit) {
      results.push({ 标题: e.标题, 状态: e.状态, 重要性: e.重要性, 足迹: trail })
    }
  }
  return results.sort((a, b) => (b.足迹.lastHit ?? 0) - (a.足迹.lastHit ?? 0))
}
