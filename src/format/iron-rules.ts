/**
 * 文风铁律配置解析（第八轮方案 P2-A1：消除 format→check 循环依赖）。
 *
 * 从 文风铁律.md 解析可量化硬约束阈值 + 反和解硬禁词（#5 第 8 节）。
 * 纯文本解析、零依赖——format 基础层可安全引用（check/count.js 反向依赖 format，
 * 不可在 format 内 import check）。
 */
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../log/index.js'
// R73-15（二十一轮）：parseBannedWordsLine 移驻 style-entry（readBannedEntryWords 拆词
// 复用同套清洗；本文件原已单向 import style-entry，反向会成环——函数随消费方迁移）
import { readBannedEntryWords, parseBannedWordsLine } from './style-entry.js'

/** 文风铁律可量化硬约束（parseIronRules 输出） */
export interface IronRules {
  /** 单句上限字数 */
  maxSentenceLen?: number
  /** 形容词连续堆叠上限 */
  maxAdjStack?: number
  /** 对话提示语占对话行比例上限，0-1 */
  maxDialogueTagRatio?: number
  /** 连续同构排比句式上限 */
  maxParallelStreak?: number
  /** 是否检查结尾总结体 */
  avoidSummaryEnding?: boolean
  /** 文风铁律里的反和解/硬禁词清单，命中即红 */
  bannedWords?: string[]
  /** R73-15（二十一轮）：条目库禁词条目里解析不出任何词的条目场景名——机检消费面
   *  产黄项提示（禁词红闸对这些条目静默失明，作者须改写为逐行/顿号分词） */
  unparsedBannedEntries?: string[]
}

/** 从 文风铁律.md 解析可量化硬约束阈值 + 反和解硬禁词（#5 第 8 节）。 */
export function parseIronRules(text: string): IronRules {
  const rules: IronRules = {}
  const lenM = text.match(/单句上限字数[:：]\s*(\d+)/)
  if (lenM) rules.maxSentenceLen = Number(lenM[1])
  const stackM = text.match(/形容词连续堆叠上限[:：]\s*(\d+)/)
  if (stackM) {
    // R27-23（二十七轮）：上限夹取 [0,20]——该值直通 adjStackRegex 的 `{N+1,}` 量词，
    // 手滑多打一个 0（如 200）时长「的」串上的嵌套量词回退实测秒级；20 个连续
    // 「X的」单元已远超任何合法散文意图，语义无损
    rules.maxAdjStack = Math.min(Math.max(Number(stackM[1]), 0), 20)
  }
  // R26-39（二十六轮）：捕获放宽 `\d*\.?\d+%?`——省整数位小数（`对话标签占比: .5`）
  // 此前 `\d+` 要求首位数字整条漏配，阈值静默不生效；`50％`（全角）由 parseRatio 归一
  const tagRatioM = text.match(/对话标签占比[:：]\s*(\d*\.?\d+%?)/)
  if (tagRatioM) rules.maxDialogueTagRatio = parseRatio(tagRatioM[1]!)
  const parallelM = text.match(/排比连续数[:：]\s*(\d+)/)
  if (parallelM) rules.maxParallelStreak = Number(parallelM[1])
  if (/结尾总结体[:：]\s*(禁止|避免|少用)/.test(text)) rules.avoidSummaryEnding = true
  const bannedWords = parseAntiReconciliationWords(text)
  if (bannedWords.length > 0) rules.bannedWords = bannedWords
  return rules
}

/**
 * RB-KN-P1-1：读铁律阈值 + 条目库禁词合并——单一真相源（原先 check/runner 私有版
 * 只读铁律不合并条目库，而 S5 迁移已把禁词知识搬进条目库并瘦身铁律，迁移书的
 * checkBannedWords 红项因此恒空、禁词拦截与自愈打回整体失效）。
 * metrics/style 与 check/runner 均消费此实现；皆无 → 空规则。
 *
 * R73-31（二十一轮）：(mtimeNs,size)+条目库目录 stat 指纹缓存——runAllChecks 每章
 * 调用本函数，此前每章「铁律整读 + 禁词条目库全扫全读」（O(章数×条目库) 重复 IO，
 * 树红点聚合数百章书一次聚合全量重读）。同指纹直接回缓存（global-defaults R64-25
 * 同款范式，精度升 mtimeNs 防同毫秒改回同长内容撞缓存）；指纹 = 铁律 md stat +
 * 禁词类型目录 stat 摘要（含文件名 hash——改名不改 stat 也要失效）。命中返回浅拷贝
 * 防调用方 mutate 污染缓存；铁律读失败（TOCTOU）不缓存，下轮重试。
 */
export function readIronRules(bookRoot: string): IronRules {
  const fp = ironRulesFp(bookRoot)
  const hit = ironRulesCache.get(bookRoot)
  if (hit && hit.fp === fp) {
    // R27-27（二十七轮）：unparsedBannedEntries 与 bannedWords 同为缓存内可变数组，
    // 浅拷贝只拷后者——调用方 mutate 前者会污染缓存（与函数头「命中返回浅拷贝防
    // 污染」的承诺不符）；两数组一起拷
    return cloneIronRules(hit.rules)
  }
  const p = join(bookRoot, '文风', '文风铁律.md')
  // R65-16（十三轮）：existsSync→readFileSync 间隙铁律被瞬删（TOCTOU）时 ENOENT 直穿
  // 炸机检/文风重扫——读失败按空规则降级 + warn 留痕（对齐 X-P2-5 读失败按无推进降级）
  let text: string | null = null
  if (existsSync(p)) {
    try {
      text = readFileSync(p, 'utf-8')
    } catch (e) {
      log.warn('iron-rules', `文风铁律读取失败，按空规则降级：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const rules = text !== null ? parseIronRules(text) : {}
  // R73-15（二十一轮）：readBannedEntryWords 改拆词解析并回报「解析不出词」的条目，
  // 透传给机检消费面产黄项（禁词红闸对这些条目静默失明的留痕）
  const { words: entryWords, unparsed: unparsedEntries } = readBannedEntryWords(bookRoot)
  if (entryWords.length > 0) {
    rules.bannedWords = [...new Set([...(rules.bannedWords ?? []), ...entryWords])]
  }
  if (unparsedEntries.length > 0) {
    rules.unparsedBannedEntries = unparsedEntries
  }
  // 铁律读失败（存在但瞬读失败）不缓存降级值——指纹未变会让降级值存活到下次改动
  if (text !== null || !existsSync(p)) {
    ironRulesCache.set(bookRoot, { fp, rules })
    // 容量纪律（R70-21 同款）：超上限 FIFO 修剪最旧书目录（Map 插入序）
    while (ironRulesCache.size > IRON_RULES_CACHE_MAX) {
      const oldest = ironRulesCache.keys().next().value
      if (oldest === undefined) break
      ironRulesCache.delete(oldest)
    }
  }
  // R27-27（二十七轮）：miss 路径同样回拷贝——此前直接 return rules（缓存对象本体），
  // 首个调用方 mutate bannedWords/unparsedBannedEntries 污染的是缓存活引用（比命中
  // 路径浅拷贝漏项更深的同型缺陷，回归测试首调 mutate 即复现）
  return cloneIronRules(rules)
}

/** R27-27（二十七轮）：IronRules 防御性拷贝——数组字段逐个克隆，标量浅拷即可。 */
function cloneIronRules(r: IronRules): IronRules {
  return {
    ...r,
    ...(r.bannedWords ? { bannedWords: [...r.bannedWords] } : {}),
    ...(r.unparsedBannedEntries ? { unparsedBannedEntries: [...r.unparsedBannedEntries] } : {}),
  }
}

/** R73-31：readIronRules 进程级指纹缓存（bookRoot → 条目）。容量对齐章节元数据缓存
 *  64 书目录纪律（R70-21）；指纹见 ironRulesFp。 */
const IRON_RULES_CACHE_MAX = 64
const ironRulesCache = new Map<string, { fp: string; rules: IronRules }>()

/**
 * R73-31：readIronRules 全部输入的 stat 指纹——铁律 md (mtimeNs,size) + 禁词条目目录
 * （count:size:maxMtimeNs:文件名FNV，目录未装 = 'no-entries'）。禁词条目库是
 * readBannedEntryWords 的读放大源，指纹必须覆盖；文件名入 hash 防「改名不改 stat」。
 * 旧格式指纹与缓存比对天然 miss（一次性重算，语义无损）。
 */
function ironRulesFp(bookRoot: string): string {
  let ruleFp = 'absent'
  try {
    const st = statSync(join(bookRoot, '文风', '文风铁律.md'), { bigint: true })
    ruleFp = `${st.mtimeNs}:${st.size}`
  } catch {
    /* 无铁律 = absent（解析走空规则，仍缓存——确定性结果） */
  }
  const dir = join(bookRoot, '文风', '条目', '禁词')
  let entriesFp = 'no-entries'
  try {
    const names = readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('._')).sort()
    let size = 0n
    let maxMtime = 0n
    let nameHash = 0x811c9dc5
    for (const name of names) {
      for (let i = 0; i < name.length; i++) {
        nameHash ^= name.charCodeAt(i)
        nameHash = Math.imul(nameHash, 0x01000193) >>> 0
      }
      try {
        const st = statSync(join(dir, name), { bigint: true })
        size += st.size
        if (st.mtimeNs > maxMtime) maxMtime = st.mtimeNs
      } catch {
        /* 竞态消失：下轮指纹自然变化（count 与实际读到的文件数可能瞬时错位，方向安全） */
      }
    }
    entriesFp = `${names.length}:${size}:${maxMtime}:${nameHash.toString(16)}`
  } catch {
    /* 目录不存在 = 未装条目库（稳定态，可缓存） */
  }
  return `${ruleFp}|${entriesFp}`
}

/** R26-39（二十六轮）：占比解析归一——全角「％」此前 Number NaN 静默落 0（阈值 0 =
 *  全量误报）、省整数位小数「.5」被阈值捕获 regex 漏配。归一（％→%）后再解析；
 *  捕获侧 parseIronRules 的 regex 同步放宽为 `\d*\.?\d+%?`。 */
function parseRatio(raw: string): number {
  const text = raw.trim().replace('％', '%')
  const n = Number(text.replace('%', ''))
  if (!Number.isFinite(n)) return 0
  return text.endsWith('%') ? n / 100 : n > 1 ? n / 100 : n
}

function parseAntiReconciliationWords(text: string): string[] {
  const sections = [
    extractSection(text, /反和解/),
    extractSection(text, /硬禁词|禁词清单/),
  ].filter((section) => section.length > 0)
  if (sections.length === 0) return []

  const words: string[] = []
  for (const section of sections) {
    for (const rawLine of section.split('\n')) {
      // R73-15（二十一轮）：parseBannedWordsLine 移驻 style-entry.ts（实现逐字不变）
      words.push(...parseBannedWordsLine(rawLine))
    }
  }
  return [...new Set(words)]
}

/** R27-20（二十七轮）：段内更深层级子标题（如 ## 硬禁词 下的 ### 网文套话）不再
 *  截断采集——原「inSection 后遇任意标题即 break」把子标题之后的禁词全部丢在门外，
 *  红闸对它们永不命中且零提示（段内已采到词时 R73-15 失明黄项也不触发，双重静默）。
 *  现仅遇**同级或更高级**标题才终断；更深层级标题行本身不入采集（防标题文字被当词）。
 *  headingLevel 取行首 # 连续数。 */
function extractSection(text: string, headingRe: RegExp): string {
  const lines = text.split('\n')
  const out: string[] = []
  let inSection = false
  let sectionLevel = 0
  for (const line of lines) {
    const m = /^(#{1,6})\s+/.exec(line)
    if (m) {
      const level = m[1]!.length
      if (inSection) {
        if (level <= sectionLevel) break // 同级/更高级 → 段终
        continue // 更深层级子标题 → 跳过标题行本身，继续采集其后内容
      }
      if (headingRe.test(line)) {
        inSection = true
        sectionLevel = level
        continue
      }
    }
    if (inSection) out.push(line)
  }
  return out.join('\n').trim()
}