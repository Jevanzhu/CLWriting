/**
 * 设定一致规则（A3）——正文专名须与书库设定一致。
 *
 * 数据源：设定/ 下三处——
 * - 角色卡：设定/角色/*.md（front matter「姓名」字段）
 * - 物品卡：设定/物品/*.md（front matter「名称」字段）
 * - 名册：  设定/名册.md（自由文本，解析名精确全等比对）
 *
 * 设定/ 目录不存在（短篇集/新书）→ toPrompt 返回 null + check 返回空。
 *
 * 规则层只做确定性字面匹配（不调 AI）——引号内 2-4 字纯汉字片段不在已知名称集合
 * 或名册解析名中即报黄；R48-3（四十八轮）起守卫族与名册判重对齐 check/count.ts
 * checkNewNames 口径（句读守卫/引导词豁免/整行对白豁免/精确全等），同一段文本两种
 * 机检不再两种结论。语义判断（别名/化名/代称）留给审稿 AI。
 */
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readFile, parseFlat, splitFrontMatter } from '../../format/frontmatter.js'
import { isMdFileName } from '../../format/filename.js'
// R48-3（四十八轮）：引号字符集/句读集取 check 域单源（quotes.ts 全部检查器同源宣言）；
// ai→check 单向依赖无环（self-heal.ts 先例），check→format 反向纪律不受影响
import { QUOTE_OPEN, QUOTE_OPEN_LENIENT, QUOTE_CLOSE_LENIENT, SPAN_PUNCT } from '../../check/quotes.js'
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

/** 引号内 2-4 字片段正则（R48-3（四十八轮）：字符集对齐 check/quotes.ts 双体系 LENIENT
 *  单源——原字面 「『"/」』" 漏弯引号 “”‘’ 一族，check 域同位守卫全数识别的片段本规则
 *  看不见，同一对白两种口径；import check/quotes 为 ai→check 单向依赖（self-heal 先例），
 *  check→format 反向不可成环的纪律不受影响） */
const QUOTED_NAME_RE = new RegExp(
  `[${QUOTE_OPEN_LENIENT}]([^${QUOTE_CLOSE_LENIENT}]{2,4})[${QUOTE_CLOSE_LENIENT}]`,
  'g',
)

// ── R48-3（四十八轮）：check 域口径对齐（read-only 参照 check/count.ts checkNewNames）
// 原实现与 check/count.ts 同源双实现严重漂移：不限中文、无任何对白守卫（check 侧六轮
// 守卫一个没有），「快走」类对白报「疑似未登记专名」假阳，经 self-heal 重写反馈 +
// 作者信号学习自我放大。以下守卫族逐一移植 check 域既有口径（常量字面 copy + 出处
// 注记；不改 check/count.ts——评审批注「只读参照」）：

/** 纯汉字候选守卫（区间同源 check/count.ts HANZI：基本区 + 扩展 A 区；字面声明先例
 *  同 format/realms.ts——避免为区间常量拉入整个 count 模块） */
const PURE_HANZI_RE = /^[一-鿿㐀-䶿]{2,4}$/

/** 句读守卫字符集（同源 check/quotes.ts SPAN_PUNCT 单源） */
const SPAN_PUNCT_RE = new RegExp(`[${SPAN_PUNCT}]`)

/** span 内部开引号探测（嵌套截断守卫用；同源 check/count.ts innerOpenRe） */
const INNER_OPEN_RE = new RegExp(`[${QUOTE_OPEN}]`)

/** 引号外残留标点剥除（同源 check/count.ts punctRe——span 已整体移除后，行内残留的
 *  孤引号/括号/句读不参与「提示语成分」整行豁免判定） */
const OUTSIDE_PUNCT_RE = new RegExp(
  `[${QUOTE_OPEN}${QUOTE_CLOSE_LENIENT}${SPAN_PUNCT}「」『』]`,
  'gu',
)

/** 对白引导词收尾判定（逐字移植 check/count.ts DIALOGUE_GUIDE_RE，R29-B12 口径——
 *  span 开引号紧前以说话动词收尾 = 「引导词 + 引语」对白引用而非专名提及；单字集
 *  剔除叫/回/应等构词语素高发字防「名叫『萧策』」误豁免，词表收窄理由见其原注） */
const DIALOGUE_GUIDE_RE = /(?:说|道|问|骂|喊|答|吼|喝|吩咐|嘀咕|嘟囔|喃喃|低语)[：:，,]?\s*$/

/** 提示语成分字符表（逐字移植 check/count.ts ATTRIBUTION_CHARS，V-P2-13 口径）——
 *  引号外文本全由这些成分组成 = 整行对白，引号内是对白内容而非专名 */
const ATTRIBUTION_RE = /^[他她它我你您们的地得了着说问道喊叫答叹笑骂吼喝斥言语音低轻冷沉淡急缓一三四五六七八九十百两声句又再便就都连只才正竟自]+$/

/** 对白归属行结构（逐字移植 check/count.ts SPEECH_ATTRIBUTION_RE，X-P2-9/R62-29 口径）——
 *  1-4 汉字人名/称谓 + 说话动词 + 可选尾缀 */
const SPEECH_ATTRIBUTION_RE =
  /^[一-鿿㐀-䶿]{1,4}(?:说|道|问|喊|叫|答|叹|笑|骂|吼|喝|斥|呼|唤|念|回|应|嘀咕|嘟囔|喃喃|低语)(?:了|着|道)?$/

/** 名册文本 → 已登记名字数组（逐字移植 check/count.ts parseRosterNames，R30-2 口径；
 *  其为 check 域内私有未导出，本域按「只读参照」抄定形态）。逐行剥 ATX 标题/列表
 *  前缀/括注，按顿号/逗号/分号/冒号/斜杠/空白劈分，只收 2-4 字纯汉字 token。 */
function parseRosterNamesLocal(roster: string): string[] {
  const names: string[] = []
  for (const rawLine of roster.split(/\r?\n/)) {
    const cleaned = rawLine
      .replace(/^#{1,6}[ \t]*/, '') // ATX 标题
      .replace(/^[-*+]\s*/, '') // 无序列表
      .replace(/^\d+[.)、]\s*/, '') // 有序列表
      .replace(/[（(][^）)]*[）)]/g, '') // 括注
    for (const token of cleaned.split(/[、，,;；:：/／\s]+/)) {
      if (token && PURE_HANZI_RE.test(token)) names.push(token)
    }
  }
  return names
}

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
      // R42-39（四十二轮）：.md 判定收敛 isMdFileName（大小写不敏感）——.MD 角色卡
      // 此前被静默跳过（姓名不进离散名称集合）
      if (!isMdFileName(f)) continue
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
      // R42-39（四十二轮）：.md 判定收敛 isMdFileName（大小写不敏感）——.MD 物品卡
      // 此前被静默跳过（名称不进离散名称集合）
      if (!isMdFileName(f)) continue
      const parsed = readFile(join(itemDir, f))
      if (!parsed.ok) continue
      const name = parseFlat(parsed.fmRaw).get('名称')
      if (typeof name === 'string' && name.trim()) data.names.add(name.trim())
    }
  }

  // 名册：全文缓存（check 时 parseRosterNamesLocal 解析精确判重，R48-3；X-P3a：
  // 剥 front matter——名册是文档可能带 fm，fm 元信息（如「姓名: 模板示例」）不该
  // 参与专名匹配）
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

    // R48-3（四十八轮）：已登记名精确比对集合——离散名称（角色卡/物品卡）+ 名册解析
    // 名。原名册面 rosterText.includes 全文子串粗匹配，长名吞短名（「林晚晴」⊃「林晚」
    // 误判已登记、独立新角色漏报），对齐 check/count.ts checkNewNames 的 R30-2 精确
    // 全等口径；名册按 parseRosterNamesLocal 解析（2-4 字纯汉字 token）
    const registered = new Set(data.names)
    if (data.rosterText !== null) {
      for (const n of parseRosterNamesLocal(data.rosterText)) registered.add(n)
    }

    const violations: RuleViolation[] = []
    const seen = new Set<string>()
    // dd-P3：正文型规则先剥 fm（types.ts 契约）——fm 短行（摘要/备注）中被引号包裹的
    // 2-4 字词此前会误入专名核对，产生假阳/假阴
    // R48-3：改逐行处理（对齐 checkNewNames 行式守卫族——对白豁免按行判定，整文
    // matchAll 拿不到 span 行内位置）
    for (const rawLine of ruleStripFm(body).split(/\n+/)) {
      const line = rawLine.trim()
      const spans = [...line.matchAll(QUOTED_NAME_RE)]
      if (spans.length === 0) continue
      // R48-3：「动词+冒号+引语」结构整行豁免（对齐 R73-17）——引号外以冒号收尾 =
      // 「X：『引语』」的引语引入结构（引导动词词表永追不全），引号内是对白/引文而非专名
      const bare = line.replace(QUOTED_NAME_RE, '').replace(/[\s\u3000]/g, '')
      if (/[:：]$/.test(bare)) continue
      // R48-3：整行对白豁免（对齐 V-P2-13/X-P2-9）——引号外只剩提示语成分（含空），
      // 或为「1-4 字人名/称谓 + 说话动词」归属行：引号片段是对白内容，不报「未登记专名」
      // （「快走。」「住手！」类网文最高频对白行式此前每章批量假阳，经 self-heal 反馈
      // 自我放大——即本轮评审 P2 主诉）
      const outside = bare.replace(OUTSIDE_PUNCT_RE, '')
      if (outside === '' || ATTRIBUTION_RE.test(outside) || SPEECH_ATTRIBUTION_RE.test(outside)) {
        continue
      }
      for (const span of spans) {
        // R48-3：嵌套引号截断守卫（对齐 R67-9）——QUOTED_NAME_RE 跨体系配对但不感知
        // 嵌套，span 内部还有开引号 = 截断产物（对白内容非专名），跳过（漏报向安全）
        if (INNER_OPEN_RE.test(span[0]!.slice(1))) continue
        // R48-3：句读守卫（对齐 R76-3）——剥两端引号后的原文含句读 = 对白内容非专名，
        // 跳过（动作+对白混排行不落整行豁免，此守卫兜底；漏报向安全）
        if (SPAN_PUNCT_RE.test(span[0]!.slice(1, -1))) continue
        // R48-3：对白引导词豁免（对齐 R29-B12）——开引号紧前（隔一个冒号/逗号算紧邻）
        // 以说话动词收尾 = 「引导词+引语」对白引用而非专名提及；词表外引导词仍照报
        if (DIALOGUE_GUIDE_RE.test(line.slice(0, span.index ?? 0).trimEnd())) continue
        const name = span[1]!.trim()
        if (name.length < 2 || name.length > 4) continue
        if (seen.has(name)) continue // 同名去重
        if (registered.has(name)) continue // R48-3：精确全等判重（原 includes 粗匹配吞短名）
        seen.add(name)
        violations.push({
          ruleId: 'setting-consistency',
          level: 'yellow',
          message: `疑似未登记专名「${name}」——若为新角色/物品，请先在 设定/ 中补建对应设定卡`,
        })
      }
    }
    return violations
  },
}
