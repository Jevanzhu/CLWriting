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
 * 机检不再两种结论；重评-0914-三轮 P2-3/P3-3（2026-09-14）起守卫族抄本删除、改
 * 直接 import check/count.ts 导出单源（「只读参照」抄本两次失同步，见文内块注）。
 * 语义判断（别名/化名/代称）留给审稿 AI。
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
import { testableConst } from '../../shared/testable.js'

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

/** 三件套换装 testableConst 工厂（TTL 覆盖档，null = 无覆盖、消费点回退常量；测试注入 setter 元组第二位原名原签名，测试面零感知）。 */
export const [getSettingTtlMs, __setSettingCacheTtlForTest] = testableConst<number | null>(null)

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
  if (cached && cached.sig === sig && Date.now() - cached.ts < (getSettingTtlMs() ?? SETTING_CACHE_TTL_MS)) {
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

// 重评-0914-三轮 P2-3/P3-3：check/count.ts 守卫族单源直引（抄本删除，沿革见上方块注）。
// R0912-3 在 check 侧补的增补平面区段 + u 标志随 parseRosterNames 单源自动生效——
// Ext-B 生僻字名册名自本批起进入 registered 集合，两检不再两结论。
import {
  ATTRIBUTION_RE,
  SPEECH_ATTRIBUTION_RE,
  DIALOGUE_GUIDE_RE,
  parseRosterNames,
} from '../../check/count.js'
// R0912-3 同款：候选名长度窗按码点计（代理对合 1 计）——UTF-16 .length 对 astral
// 字一符计 2。check 侧 :472 同口径单源（shared/text.ts）。
import { codePointLength } from '../../shared/text.js'

/** 句读守卫字符集（同源 check/quotes.ts SPAN_PUNCT 单源组装） */
const SPAN_PUNCT_RE = new RegExp(`[${SPAN_PUNCT}]`)

/** span 内部开引号探测（嵌套截断守卫用） */
const INNER_OPEN_RE = new RegExp(`[${QUOTE_OPEN}]`)

/** 引号外残留标点剥除（span 已整体移除后，行内残留的孤引号/括号/句读不参与
 *  「提示语成分」整行豁免判定） */
const OUTSIDE_PUNCT_RE = new RegExp(
  `[${QUOTE_OPEN}${QUOTE_CLOSE_LENIENT}${SPAN_PUNCT}「」『』]`,
  'gu',
)

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
      for (const n of parseRosterNames(data.rosterText)) registered.add(n)
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
        // 重评-0914-三轮 P2-3：长度窗改码点计（原 UTF-16 .length 对 astral 字一符计 2，
        // 与 check 侧 :472 codePointLength 口径分裂；单源见上方 import 注）
        const nameLen = codePointLength(name)
        if (nameLen < 2 || nameLen > 4) continue
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
