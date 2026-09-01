/**
 * 设定一致规则（A3）——正文专名须与书库设定一致。
 *
 * 数据源：设定/ 下三处——
 * - 角色卡：设定/角色/*.md（front matter「姓名」字段）
 * - 物品卡：设定/物品/*.md（front matter「名称」字段）
 * - 名册：  设定/名册.md（自由文本，全文 includes 粗匹配）
 *
 * 设定/ 目录不存在（短篇集/新书）→ toPrompt 返回 null + check 返回空。
 *
 * 规则层只做确定性字面匹配（不调 AI）——引号内 2-4 字中文片段不在已知名称
 * 集合或名册全文中即报黄。语义判断（别名/化名/代称）留给审稿 AI。
 */
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readFile, parseFlat, splitFrontMatter } from '../../format/frontmatter.js'
import type { WritingRule, RuleViolation } from './types.js'
import { ruleStripFm } from './types.js'

/** 设定子目录/文件相对路径 */
const SETTING_DIR = '设定'
const ROLE_DIR = join(SETTING_DIR, '角色')
const ITEM_DIR = join(SETTING_DIR, '物品')
const ROSTER_FILE = join(SETTING_DIR, '名册.md')

// ── R36-12（三十六轮）：设定目录读取 TTL 缓存 ─────────────────────────────
// setting-rule 挂在 AI 热路径（self-heal/spawn-write/rewrite 的 toPrompt/check 每章
// 反复调用），此前每次全量 readdirSync + readFileSync 读设定目录（角色卡/物品卡逐
// 文件 parse front matter）。手法对齐 R35-7 search 缓存（书键 Map + TTL + 目录 mtime
// 结构探针 + 测试注入口/计数观察口）：探针让新增/删除/改名等目录结构变化即时失效；
// 名册.md 内容改写不触碰目录 mtime，单独探针（一次 stat）让名册更新即时失效；
// TTL（缺省 5s）只兜「同 mtime 内容改写」的最坏可见窗。规则变更后不缓存陈旧。
// 删书/改名经 books.ts forgetBookKeyedCaches 的 forgetSettingCache 挂点清理（同
// forgetSearchCache 口径）。
const SETTING_CACHE_TTL_MS = 5000
const SETTING_CACHE_MAX = 16

interface SettingCacheEntry {
  data: SettingData
  ts: number
  sig: string
}

const settingCache = new Map<string, SettingCacheEntry>()

let settingTtlMs: number | null = null
/** TTL 测试注入口（null 还原默认；先例同 search.ts __setSearchCacheTtlForTest）。 */
export function __setSettingCacheTtlForTest(ms: number | null): void {
  settingTtlMs = ms
}

let settingLoadCountForTest = 0
/** 底层实际读目录计数观察口（验证缓存命中/失效；生产零调用）。 */
export function __settingLoadCountForTest(): number {
  return settingLoadCountForTest
}
export function __resetSettingLoadCountForTest(): void {
  settingLoadCountForTest = 0
}

/** R36-12：删书/改名失效挂点（同 forgetSearchCache 口径——书键清理；本缓存键即
 *  bookRoot 本身，精确删除即可——绝对路径前缀无歧义）。 */
export function forgetSettingCache(bookRoot: string): void {
  settingCache.delete(bookRoot)
}

/** 设定目录 + 名册文件的 mtime 签名（缺失计 '-'）：每次命中前重算，4 次 stat 换
 *  免全量重读。必须在读取**前**取值——读取期间落盘的变更会使签名失配，下次按失效
 *  重读（宁多读不脏读，同 R35-7 口径）。 */
function settingDirSignature(bookRoot: string): string {
  const parts: string[] = []
  for (const p of [SETTING_DIR, ROLE_DIR, ITEM_DIR]) {
    try {
      parts.push(String(statSync(join(bookRoot, p)).mtimeMs))
    } catch {
      parts.push('-') // 目录不存在
    }
  }
  // 名册.md：内容改写不改目录 mtime，单独探针即时失效（不只靠 TTL）
  try {
    parts.push(String(statSync(join(bookRoot, ROSTER_FILE)).mtimeMs))
  } catch {
    parts.push('-')
  }
  return parts.join(',')
}

/** R36-12：带缓存的设定数据读取（替代规则层直调 loadSettingData）。 */
function loadSettingDataCached(bookRoot: string): SettingData {
  const sig = settingDirSignature(bookRoot)
  const cached = settingCache.get(bookRoot)
  if (cached && cached.sig === sig && Date.now() - cached.ts < (settingTtlMs ?? SETTING_CACHE_TTL_MS)) {
    return cached.data
  }
  settingLoadCountForTest += 1
  const data = loadSettingData(bookRoot)
  // 简单 FIFO 淘汰（Map 保插入序）：超上限丢最旧条目，防长期书架累积死重
  if (settingCache.size >= SETTING_CACHE_MAX) {
    const oldest = settingCache.keys().next().value
    if (oldest !== undefined) settingCache.delete(oldest)
  }
  settingCache.set(bookRoot, { data, ts: Date.now(), sig })
  return data
}

/** 引号内 2-4 字中文片段正则（参考 check/count.ts checkNewNames） */
const QUOTED_NAME_RE = /[「『"]([^」』"]{2,4})[」』"]/g

/** 书库设定数据：离散名称 + 名册全文 */
interface SettingData {
  /** 角色卡姓名 + 物品卡名称（精确匹配用） */
  names: Set<string>
  /** 名册.md 全文（null = 无名册文件） */
  rosterText: string | null
}

/**
 * 加载书库设定数据。
 * 设定/ 目录不存在（短篇集/新书）→ 返回空数据。
 */
function loadSettingData(bookRoot: string): SettingData {
  const data: SettingData = { names: new Set(), rosterText: null }
  const settingRoot = join(bookRoot, SETTING_DIR)
  if (!existsSync(settingRoot)) return data

  // 角色卡：读 front matter「姓名」字段
  const roleDir = join(bookRoot, ROLE_DIR)
  if (existsSync(roleDir)) {
    for (const f of readdirSync(roleDir)) {
      if (!f.endsWith('.md')) continue
      const parsed = readFile(join(roleDir, f))
      if (!parsed.ok) continue
      const name = parseFlat(parsed.fmRaw).get('姓名')
      if (typeof name === 'string' && name.trim()) data.names.add(name.trim())
    }
  }

  // 物品卡：读 front matter「名称」字段
  const itemDir = join(bookRoot, ITEM_DIR)
  if (existsSync(itemDir)) {
    for (const f of readdirSync(itemDir)) {
      if (!f.endsWith('.md')) continue
      const parsed = readFile(join(itemDir, f))
      if (!parsed.ok) continue
      const name = parseFlat(parsed.fmRaw).get('名称')
      if (typeof name === 'string' && name.trim()) data.names.add(name.trim())
    }
  }

  // 名册：全文缓存（check 时 includes 粗匹配；X-P3a：剥 front matter——
  // 名册是文档可能带 fm，fm 元信息（如「姓名: 模板示例」）不该参与专名匹配）
  const rosterPath = join(bookRoot, ROSTER_FILE)
  if (existsSync(rosterPath)) {
    const rosterRaw = readFileSync(rosterPath, 'utf-8')
    const rosterSplit = splitFrontMatter(rosterRaw)
    data.rosterText = rosterSplit ? rosterSplit.body : rosterRaw
  }

  return data
}

/** 判定设定数据是否为空（无离散名称且无名册） */
function isEmpty(data: SettingData): boolean {
  return data.names.size === 0 && data.rosterText === null
}

/** 候选专名是否已登记（在离散名称集合或名册全文中） */
function isKnown(name: string, data: SettingData): boolean {
  if (data.names.has(name)) return true
  if (data.rosterText !== null && data.rosterText.includes(name)) return true
  return false
}

/** 设定一致规则（黄级：提示不卡流程） */
export const settingConsistencyRule: WritingRule = {
  id: 'setting-consistency',
  level: 'yellow',
  tasks: ['self-heal', 'spawn-write', 'rewrite'],

  toPrompt(ctx): string | null {
    // R36-12：经 TTL+探针缓存读取（AI 热路径不再每章全量读设定目录）
    const data = loadSettingDataCached(ctx.bookRoot)
    if (isEmpty(data)) return null
    return '设定一致：文中人物/物品名称须与书库设定一致——已有角色卡和物品卡登记的名称不可篡改，新出场专名须有对应设定卡，不可凭空捏造'
  },

  check(body, ctx): RuleViolation[] {
    // R36-12：同上——缓存读取，规则变更（目录结构/名册内容）后探针失效不缓存陈旧
    const data = loadSettingDataCached(ctx.bookRoot)
    if (isEmpty(data)) return []

    const violations: RuleViolation[] = []
    const seen = new Set<string>()
    // dd-P3：正文型规则先剥 fm（types.ts 契约）——fm 短行（摘要/备注）中被引号包裹的
    // 2-4 字词此前会误入专名核对，产生假阳/假阴
    for (const m of ruleStripFm(body).matchAll(QUOTED_NAME_RE)) {
      const name = m[1]!.trim()
      if (name.length < 2 || name.length > 4) continue
      if (seen.has(name)) continue // 同名去重
      if (isKnown(name, data)) continue // 已登记，放行
      seen.add(name)
      violations.push({
        ruleId: 'setting-consistency',
        level: 'yellow',
        message: `疑似未登记专名「${name}」——若为新角色/物品，请先在 设定/ 中补建对应设定卡`,
      })
    }
    return violations
  },
}
