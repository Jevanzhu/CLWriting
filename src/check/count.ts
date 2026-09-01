/**
 * 可计数项 + 文风可量化 —— 依据 #10 第 2 节项 3-11。
 *
 * 红（#10 项 3-4）：front matter 格式、禁词
 * 黄（#10 项 5-11）：字数/复读/意象/句式/文风可量化/专名/信息差候选
 *
 * 全部零 token 脚本判定。
 */

import { readFileSync, existsSync } from 'node:fs'
import type { CheckSectionResult, CheckItem } from './types.js'
import type { ChapterMeta } from '../format/types.js'
import { validateEnums } from '../format/chapters.js'
import { splitSentences, ngramRepeatRate } from '../format/sentences.js'
import { QUOTED_SPAN_RE, stripQuotedSpans, QUOTE_OPEN, QUOTE_CLOSE, SPAN_PUNCT } from './quotes.js'
// P2-A1：IronRules 类型下沉到 format 层（format/iron-rules.ts），消除 format→check 循环依赖
import type { IronRules } from '../format/iron-rules.js'

/**
 * 汉字字符范围（基本区 + 扩展 A 区）。
 * 统一使用，避免不同检查项范围不一导致生僻字人名漏判。
 * R62-29 注释修正：「一-鿿」中 一=U+4E00、鿿=U+9FFF（基本区顶，非 U+9FA5——
 * U+9FA5 是「龥」，U+9FFD~U+9FFF 是 CJK 扩充进基本区顶的字，旧注释把区顶码位
 * 写错一位）；「㐀-䶿」= U+3400-U+4DBF（扩展 A 区）。R64-11（十二轮）导出：
 * api/check.ts 堆砌锚点正则收编本单源（此前第四处硬编码）。
 */
export const HANZI = '一-鿿㐀-䶿'

// R33-31（三十三轮）：对话提示语正则模块常量化（循 R26-47）——原在 checkStyleMetrics
// 每次调用 new RegExp 两枚；String.match 对带 g 的正则不保留 lastIndex，提升安全。
const DIALOGUE_TAG_SHUO_RE = new RegExp(`[${HANZI}]{2,}地说`, 'gu')
const DIALOGUE_TAG_DIDAO_RE = new RegExp(`[${HANZI}]{2,}地道(?=[:：\u201c\u2018「『])`, 'gu')

/**
 * front matter 格式检查（#10 项 3，🔴 红）。
 * 章号==文件名、枚举合法、必填齐。
 */
export function checkFrontMatter(
  chapter: ChapterMeta,
  fileName: string,
): CheckSectionResult {
  const items: CheckItem[] = []

  // 章号 == 文件名前缀（非数字文件名如 前言.md 不报红——与短篇版 checkPieceFrontMatter 对齐）
  // R33-30（三十三轮）：分隔符双侧容忍（`[/\\]`）——契约对路径形态脆弱（win 反斜杠
  // 直传时前缀识别失明）；现调用方传 basename 不触发，纯加固。
  const fileNum = Number(fileName.match(/(?:^|[/\\])(\d+)-/)?.[1])
  if (!Number.isNaN(fileNum) && fileNum !== chapter.章号) {
    items.push({
      checkId: 'fm-chapter-mismatch',
      level: 'red',
      message: `章号「${chapter.章号}」与文件名「${fileName}」前缀不一致`,
      chapter: chapter.章号,
    })
  }

  // R73-16（二十一轮 B-3）：必填枚举缺失（钩子类型/钩子强弱/情绪定位）此前在 readChapter
  // 静默补默认（悬念钩/中/铺垫），本检查对「缺字段」零红项，与 draft.ts「至少包含」文案相悖。
  // readChapter 现把缺失清单记在 _fmMissing，这里逐字段产红（fm-missing）——「缺字段」与
  // 「写了非法值」（fm-enum，validateEnums）分开呈现，自愈回灌的改法不同。
  for (const field of chapter._fmMissing ?? []) {
    items.push({
      checkId: 'fm-missing',
      level: 'red',
      message: `front matter 缺少必填字段「${field}」（合法值见 #7 第 3 节：钩子类型/钩子强弱/情绪定位），请补齐`,
      chapter: chapter.章号,
    })
  }

  // 枚举合法
  const enumErrs = validateEnums(chapter)
  for (const e of enumErrs) {
    items.push({ checkId: 'fm-enum', level: 'red', message: e, chapter: chapter.章号 })
  }

  return { name: 'front matter 格式', items }
}

/** R29-1②（二十九轮）：汉字单字符判定（复用 HANZI 区间单源），边界检测用。 */
const HANZI_CHAR_RE = new RegExp(`[${HANZI}]`)

/**
 * R29-1②（二十九轮）：≥2 字禁词的边界命中——命中位置的「前后都必须是非汉字」
 * （文本首尾算边界）才计命中，防成语/复合词裸子串误报（「一丝不苟」不再命中「一丝」）。
 * 方向取舍（有意为之）：禁词红项假阳代价最高（红项驱动自愈打回，误报烧真模型调用），
 * 由此引入的漏报（禁词嵌在连续汉字中段，如「说了句废话」的「废话」）向安全可接受，
 * 作者仍可把词条写成带标点的形态或下修为单字黄项观察。
 */
function hasBoundedHit(text: string, word: string): boolean {
  let idx = text.indexOf(word)
  while (idx !== -1) {
    const beforeOk = idx === 0 || !HANZI_CHAR_RE.test(text[idx - 1]!)
    const end = idx + word.length
    const afterOk = end >= text.length || !HANZI_CHAR_RE.test(text[end]!)
    if (beforeOk && afterOk) return true
    idx = text.indexOf(word, idx + 1) // 步进 1：不漏重叠位置上的合法边界命中
  }
  return false
}

/**
 * 禁词检查（#10 项 4，🔴 红）。
 * 命中作者设的禁词表（文风铁律.md 的禁词段）。
 * R29-1（二十九轮）三处收紧：
 * ① 匹配前剥对白引号 span（quotes.ts 单源 stripQuotedSpans）——对白是角色嘴里的话，
 *    不算作者叙述用词（角色骂禁词不等于作者写禁词）；
 * ② ≥2 字禁词加「前后非汉字」边界（见 hasBoundedHit 注释：防成语裸子串误报，
 *    漏报向安全）；
 * ③ 单字禁词降级为黄项——单字命中误报面最大（「顿」命中「安顿/顿开」），保留
 *    fail-noisy 可见性（黄项照出）但不再驱动红闸打回。
 */
export function checkBannedWords(
  body: string,
  bannedWords: string[],
): CheckSectionResult {
  const items: CheckItem[] = []
  const prose = stripQuotedSpans(body)
  for (const word of bannedWords) {
    if (!word) continue
    if (word.length === 1) {
      // R29-1③：单字禁词降黄（不再驱动打回）
      if (prose.includes(word)) {
        items.push({
          checkId: 'banned-word',
          level: 'yellow',
          message: `命中单字禁词「${word}」（单字误报面大，降级为黄项提示，不驱动打回）`,
        })
      }
    } else if (hasBoundedHit(prose, word)) {
      items.push({
        checkId: 'banned-word',
        level: 'red',
        message: `命中禁词「${word}」`,
      })
    }
  }
  return { name: '禁词', items }
}

/**
 * 字数检查（#10 项 5，🟡 黄）。
 * 偏离细纲目标字数过多 → 提示。
 */
export function checkWordCount(
  actualWords: number,
  targetWords: number,
  tolerancePct = 30,
): CheckSectionResult {
  const items: CheckItem[] = []
  if (targetWords > 0) {
    const diff = Math.abs(actualWords - targetWords) / targetWords * 100
    if (diff > tolerancePct) {
      items.push({
        checkId: 'word-count',
        level: 'yellow',
        message: `字数 ${actualWords} 偏离目标 ${targetWords}（偏差 ${Math.round(diff)}% > ${tolerancePct}%）`,
      })
    }
  }
  return { name: '字数', items }
}

/**
 * 复读检查（#10 项 6，🟡 黄）。
 * 滑窗句级 n-gram 重复率（P3-12 实装：此前实现是整句哈希，与注释宣称的 n-gram 不符，
 * 重复句改一两个字就抓不住）。算法：对每个句子取字符级滑窗 n-gram，统计
 * 「重复 n-gram 实例数 / 总 n-gram 数」为复读率——重复句改个别字仍有大量相同
 * n-gram 被计数；阈值经测试校准，保持不误报正常文本。
 */
const REPEAT_N_GRAM = 8

/** R29-B6（二十九轮）：绝对重复字符量阈值（双口径的第二口径）。
 *  量纲 = 重复 n-gram 实例折算字符数（每多出现一次计 REPEAT_N_GRAM 字，全书求和，
 *  见 ngramRepeatRate.repeatChars）。取值保守：200 字 ≈ 一段 30+ 字的复读块重复两遍，
 *  正常行文（人名/套语零星重现）远达不到；比率口径（15%）继续管小章，绝对口径兜
 *  大章集中复读（5000 字章重复 100 字 ≈ 2%，比率不报、绝对量 700+ 字必报）。 */
const REPEAT_CHARS_THRESHOLD = 200

export function checkRepeat(
  body: string,
  threshold = 0.15,
  repeatCharThreshold = REPEAT_CHARS_THRESHOLD,
): CheckSectionResult {
  const items: CheckItem[] = []
  // M-12（第八轮）：滑窗口径收口到 format/sentences.ngramRepeatRate（与文风重扫共用）
  const { rate, total, repeatInstances, repeatChars } = ngramRepeatRate(body, REPEAT_N_GRAM)
  if (total > 0) {
    // R29-B6：双口径——比率超阈（章长无关的密度语义）或绝对重复字符量超阈
    // （防大章稀释漏报）任一命中即报，message 注明触发口径
    if (rate > threshold) {
      items.push({
        checkId: 'repeat',
        level: 'yellow',
        message: `复读率 ${(rate * 100).toFixed(1)}% 超阈值 ${threshold * 100}%（重复 ${repeatInstances} 处）`,
      })
    } else if (repeatChars > repeatCharThreshold) {
      items.push({
        checkId: 'repeat',
        level: 'yellow',
        message: `重复字符量 ${repeatChars} 字超绝对阈值 ${repeatCharThreshold} 字（复读率 ${(rate * 100).toFixed(1)}% 未超，大章集中复读）`,
      })
    }
  }
  return { name: '复读', items }
}

/**
 * 句长体检（#10 项 8，🟡 黄）。
 * 句长方差 / 超长句占比。
 */
export function checkSentenceLength(
  body: string,
  maxLen = 60,
): CheckSectionResult {
  const items: CheckItem[] = []
  const sentences = splitSentences(body)
  // R73-19（二十一轮）：句长统一码点口径（与 countWords 一致）——UTF-16 .length 对
  // astral 字符（emoji/生僻扩展区）一符计 2，句长虚高。codePointLength 见下。
  const overlong = sentences.filter((s) => codePointLength(s) > maxLen)
  if (sentences.length > 0 && overlong.length / sentences.length > 0.2) {
    items.push({
      checkId: 'sentence-length',
      level: 'yellow',
      message: `超长句（>${maxLen}字）占比 ${(overlong.length / sentences.length * 100).toFixed(0)}%，句长偏长`,
    })
  }
  return { name: '句式体检', items }
}

/**
 * R73-19（二十一轮）：句长码点口径——手写码点遍历（代理对合 1 计），
 * 与 countWords 的 [...body].length 同口径；不用 Array.from 免逐句分配。
 */
function codePointLength(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    n++
    if (s.codePointAt(i)! > 0xffff) i++ // 代理对：astral 字符按 1 计
  }
  return n
}

/**
 * 提示语成分字符表（对白行判定）：引号外文本全部由这些成分组成 → 该行是对白，
 * 引号内是对白内容。启发式词表，覆盖代词/说话动词/常见修饰与数量成分；
 * 叙述动词（看/走/举…）不在表内，叙述行不会被误判为对白。
 */
const ATTRIBUTION_CHARS = '他她它我你您们的地得了着说问道喊叫答叹笑骂吼喝斥言语音低轻冷沉淡急缓一三四五六七八九十百两声句又再便就都连只才正竟自'
const ATTRIBUTION_RE = new RegExp(`^[${ATTRIBUTION_CHARS}]+$`)

/** 引号外只剩提示语（或为空）→ 对白行。 */
function isAttributionOnly(outside: string): boolean {
  return outside === '' || ATTRIBUTION_RE.test(outside)
}

/** R28-8（二十八轮）：说话动词集单源——SPEECH_ATTRIBUTION_RE（对白归属行豁免）与
 *  DIALOGUE_TAG_RE（对话标签占比分子）共用同一动词集。此前 DIALOGUE_TAG_RE 只有
 *  说/道/问/喊/叫/答/叹/笑 8 个，窄于归属行豁免的 21 个（骂/吼/喝/斥/呼/唤/念/回/
 *  应/嘀咕/嘟囔/喃喃/低语 不计标签）→ 标签占比分子系统性偏低（漏检向黄）。对齐后
 *  「“闭嘴！”他骂道。」这类行照常计入占比。
 *  已知登记不动（R28-8）：「他喊了一声，」的「了」后接数词「一」不满足双侧边界锚定
 *  （lookahead 要求动词/尾缀后紧跟标点或行尾）→ 该形态不计标签；修锚定易引入构词
 *  语素回潮（R26-11 反例），本期只对齐动词集。 */
const SPEECH_VERBS = '说|道|问|喊|叫|答|叹|笑|骂|吼|喝|斥|呼|唤|念|回|应|嘀咕|嘟囔|喃喃|低语'

/** X-P2-9：对白归属行结构——1-4 汉字（人名/称谓）+ 说话动词 + 可选尾缀（了/着/道）。
 *  说话人名词不在提示语词表（V-P2-13 只挡代词行），「快走。」林晚说。这类
 *  网文最高频对白行式按结构匹配豁免，否则引号内对白被当专名每章批量误报。
 *  R62-29：汉字段改 ${HANZI} 插值（与全文件口径同源）——此前字面 \u4e00-\u9fa5
 *  漏基本区顶与扩展 A 区，生僻字人名的归属行不匹配、对白被当专名误报。
 *  R28-8：动词段收 SPEECH_VERBS 单源（动词集语义不变，见上）。 */
const SPEECH_ATTRIBUTION_RE =
  new RegExp(`^[${HANZI}]{1,4}(?:${SPEECH_VERBS})(?:了|着|道)?$`)

/**
 * R29-B12（二十九轮）：对白引导词收尾判定（checkNewNames 混排行守卫专用，刻意不复用
 * SPEECH_VERBS 全集）——span 开引号紧前（允许隔一个冒号/逗号）以这些说话动词收尾 =
 * 该 span 是「引导词 + 引语」的对白引用而非专名提及。单字集从 SPEECH_VERBS 剔除
 * 叫/回/应/念/叹/笑/斥/呼/唤/低语 等构词语素高发字（「名叫『萧策』」的「叫」会把
 * 真候选杀掉），双字词（吩咐/嘀咕/嘟囔/喃喃/低语）按 2 字符窗口整词收尾才认。
 * 已知残余面（漏报向安全，黄项启发式不追全）：「频道/知道/频道」等以「道」收尾的
 * 普通词紧邻引号时同样豁免——与 R76-3 同款取舍。
 */
const DIALOGUE_GUIDE_RE = /(?:说|道|问|骂|喊|答|吼|喝|吩咐|嘀咕|嘟囔|喃喃|低语)[：:，,]?\s*$/

/**
 * R26-11（二十六轮）：对话标签提示语结构锚定（computeStyleMetrics 对话标签占比用）。
 * V-P1-7 只看引号外文本后，裸字面匹配（`[汉字]{1,8}说|道|…(了|着)?`）仍把剥引号后
 * 残留的构词语素当标签——「“走吧。”他知道已经拦不住了。」剥引号后「他知道…」的
 * 「道」、「味道/道理/笑点」的语素均误命中，分子系统性虚高。改双侧边界锚定（对白
 * 提示语形态「X说：」「他道，」「XX喊道。」）：
 * - 动词段（1-8 汉字人名/代词前缀 + 说话动词 + 可选 了/着）整体前须行首/标点/空白；
 * - 动词（含尾缀）后须紧跟标点/冒号/行尾——构词语素后跟普通字（知「道」→已经）不再匹配。
 * stripQuotedSpans 语义不变（V-P1-7：对白内容不算标签）。
 * R26-47（二十六轮）：原循环/逐行 new RegExp 提升为模块级常量（无 g 标志，test 安全）。
 * R28-8（二十八轮）：动词段收 SPEECH_VERBS 单源——原 8 动词窄于归属行豁免的 21 动词，
 * 标签占比分子系统性偏低（漏检向黄），对齐后双口径同词表。
 */
const TAG_ANCHOR = `[\\s${SPAN_PUNCT}「」『』“”‘’（）《》〈〉]`
export const DIALOGUE_TAG_RE = new RegExp(
  `(?:^|${TAG_ANCHOR})[${HANZI}]{1,8}(?:${SPEECH_VERBS})(?:了|着)?(?=$|${TAG_ANCHOR})`,
  'u',
)

/** R30-2（三十轮）：纯汉字名判定（名册侧名字过滤用，区间与候选抽取同源 HANZI）。 */
const ROSTER_NAME_RE = new RegExp(`^[${HANZI}]{2,4}$`)

/**
 * R30-2（三十轮）：名册文本 → 已登记名字数组（checkNewNames 精确判重专用）。
 *
 * 单源指向：grep src/check/ 无现成名册解析器（checkNewNames 此前直接对名册**全文**
 * 做 includes 粗匹配；src/ai/rules/setting-rule.ts 的名册面同为全文粗匹配口径），
 * 故按名册格式（行/顿号分隔，兼容 `已登记：A、B`、`- 已登记：A、B`、`### A` 等仓内
 * 既有形态）在本文件局部实现本解析，作为 check 域名册判重单源；setting-rule 的
 * 粗匹配口径不属本批可改范围，维持现状。
 *
 * 逐行剥 ATX 标题/列表前缀/括注（「云澈（主角）」→「云澈」），再按顿号/逗号/分号/
 * 冒号/斜杠/空白劈分；只收 2-4 字纯汉字 token（与候选抽取窗一致，说明性词汇
 * 「身份/动机」等字段名即便混入也只是多登记而无害——精确全等比对不会吞掉他名）。
 */
function parseRosterNames(roster: string): string[] {
  const names: string[] = []
  for (const rawLine of roster.split(/\r?\n/)) {
    const cleaned = rawLine
      .replace(/^#{1,6}\s*/, '') // ATX 标题
      .replace(/^[-*+]\s*/, '') // 无序列表
      .replace(/^\d+[.)、]\s*/, '') // 有序列表
      .replace(/[（(][^）)]*[）)]/g, '') // 括注
    for (const token of cleaned.split(/[、，,;；:：/／\s]+/)) {
      if (token && ROSTER_NAME_RE.test(token)) names.push(token)
    }
  }
  return names
}

/**
 * 新专名比对名册（#10 项 10，🟡 黄）。
 * 新专名 vs 名册.md，未登记 → 候选（不自动入册）。
 * R30-2（三十轮）：判重口径由「名册全文 includes」改为「已登记名字集合精确全等」
 * ——全文 includes 在名册更长名字包含候选（「林晚晴」⊃「林晚」）时误判已登记，
 * 独立新角色漏报；现按 parseRosterNames 解析出的名字数组逐名比对，候选与已登记名
 * 完全同名才算已登记。名册缺失/读失败路径不变（见下）。
 */
export function checkNewNames(
  body: string,
  rosterPath: string,
): CheckSectionResult {
  const items: CheckItem[] = []
  if (!existsSync(rosterPath)) return { name: '新专名候选', items }
  // R65-16（十三轮）：existsSync→readFileSync 间隙名册被瞬删（TOCTOU）时 ENOENT 直穿
  // 炸整次机检——照 R62-9（runner.ts readPieceList）同款降级：黄项提示本轮未跑，不静默消失
  let roster: string
  try {
    roster = readFileSync(rosterPath, 'utf-8')
  } catch (e) {
    return {
      name: '新专名候选',
      items: [
        {
          checkId: 'roster-unreadable',
          level: 'yellow',
          message: `名册读取失败（${e instanceof Error ? e.message : String(e)}），新专名检查本轮未跑，修复后重查。`,
        },
      ],
    }
  }
  // R30-2（三十轮）：名册文本解析为已登记名字数组（精确判重，见 parseRosterNames）
  const registeredNames = parseRosterNames(roster)
  // 粗抽：2-4 字中文专名候选——候选仅出自引号 span（QUOTED_SPAN_RE 命中段；
  // R31-12（三十一轮）注释如实化：叙述行裸名不入候选，扩裸名会引入高误报面，超出本轮）
  const candidates = new Set<string>()
  const spanRe = new RegExp(QUOTED_SPAN_RE.source, 'g')
  const punctRe = new RegExp(`[${QUOTE_OPEN}${QUOTE_CLOSE}${SPAN_PUNCT}「」『』]`, 'gu')
  // R62-28：句读命中判定外提——此前每个候选名 new RegExp 一次（一章数十候选×
  // 每章重跑，纯浪费；字符类内容循环内不变）
  const spanPunctRe = new RegExp(`[${SPAN_PUNCT}]`)
  // R67-9：span 内部开引号探测（嵌套截断守卫，见下方循环内注释）
  const innerOpenRe = new RegExp(`[${QUOTE_OPEN}]`)
  for (const rawLine of body.split(/\n+/)) {
    const line = rawLine.trim()
    // R29-B12（二十九轮）：match→matchAll——守卫需要 span 在行内的位置（取开引号
    // 紧前文本判引导词），裸字符串数组拿不到 index
    const spans = [...line.matchAll(spanRe)]
    if (spans.length === 0) continue
    // R73-17（二十一轮）：「动词+冒号+引语」结构豁免——引导动词词表（挥手/点头/摆手…）
    // 永远追不全，词表外动词 + 冒号引出的对白（「他挥挥手：『住手。』」）此前整行按
    // 叙述行处理，引号内 2 字对白被当专名误报。引号外文本以冒号收尾 = 「X：『引语』」
    // 的引语引入结构，引号内是对白/引文而非专名（黄项候选漏报向安全：冒号后真提及
    // 的专名本就多在引语里，同 X-P2-9/V-P2-13 的豁免口径）。
    if (/[:：]$/.test(line.replace(spanRe, '').replace(/[\s\u3000]/g, ''))) continue
    // 引号外只剩提示语成分（代词/说话动词/语气副词等）→ 整行是对白，
    // 引号片段是对白内容而非专名（V-P2-13：此前「住手！」「快走」全报黄项刷屏）
    const outside = line.replace(spanRe, '').replace(/[\s\u3000]/g, '').replace(punctRe, '')
    if (isAttributionOnly(outside)) continue
    // X-P2-9：人名 + 说话动词的对白归属行同样豁免
    if (SPEECH_ATTRIBUTION_RE.test(outside)) continue
    for (const span of spans) {
      const q = span[0]
      // R67-9（十五轮）：嵌套引号截断守卫——QUOTED_SPAN_RE 跨体系配对但不感知嵌套，
      // 嵌套对白「他说『快走』了」被截成 span「他说『快走，剥引号后「他说快走」恰落
      // 2-4 字窗报伪专名黄项；span 内部还有开引号 = 截断产物（对白内容非专名），跳过
      // （漏报向安全：真嵌套提及的专名本就多在对白内容里，黄项启发式不追全）
      if (innerOpenRe.test(q.slice(1))) continue
      // R76-3（二十四轮 B 域）：句读守卫改在剥句读前的原文上判——punctRe 含全部句读
      // 且下方 name 已被它剥净，原 `spanPunctRe.test(name)` 恒 false 成死守卫，注释宣称
      // 的「含句读的片段是对白内容」失效；三条整行豁免只覆盖「整行是对白」形态，
      // 动作+对白混排行（网文最高频行式，如「他低声道：『别动。』然后按住她的肩。」）
      // 全部穿透成伪专名黄项刷屏。改判剥两端引号后的原文：含句读 = 对白内容非专名，
      // 跳过（漏报向安全：真提及的专名带句读本就在引语里）。
      if (spanPunctRe.test(q.slice(1, -1))) continue
      // R29-B12（二十九轮）：混排行残余面——动作+无句读短引语（「林晚喊道『站住』，
      // 追了出去。」）不落 R76-3 句读守卫也不落整行豁免，span 被当 2 字伪专名报黄。
      // span 开引号紧前（隔一个冒号/逗号算紧邻）以对白引导词收尾 → 判为对白引用跳过；
      // 引导词不在紧邻窗口（如「他说了很多，『诚实』才是关键」）或引导词词表外
      // （「名叫『萧策』」）仍照报，真候选不误伤（词表收窄理由见 DIALOGUE_GUIDE_RE 注释）
      if (DIALOGUE_GUIDE_RE.test(line.slice(0, span.index ?? 0).trimEnd())) continue
      const name = q.replace(punctRe, '')
      if (name.length < 2 || name.length > 4) continue
      // R30-2（三十轮）：精确全等判重（见 parseRosterNames/函数头注）——
      // 原 roster.includes(name) 是名册全文子串判定，长名吞短名致独立新角色漏报
      if (!registeredNames.includes(name)) candidates.add(name)
    }
  }
  for (const name of candidates) {
    items.push({
      checkId: 'new-name',
      level: 'yellow',
      message: `新专名候选「${name}」未在名册中登记`,
    })
  }
  return { name: '新专名候选', items }
}

/**
 * 高频意象检查（#10 项 7，🟡 黄）。
 * 套路词/意象表命中频次超阈 → 提示（PRD 问题 9，"空气仿佛凝固"）。
 * 词表三级供给（数据源接线后由 runner 解析，本函数只吃现成表）：入参显式 >
 * book.yaml checks.imagery_words > 内置种子表（imagery-seed.ts）；书级/入参写了
 * 词表即整体替换（不合并），显式空数组 = 彻底关。入参 readonly——runner 直收
 * 种子表的 readonly 字面量，免调用方拷贝。
 */
export function checkImagery(
  body: string,
  imageryWords: readonly string[] = [],
  threshold = 3,
): CheckSectionResult {
  const items: CheckItem[] = []
  if (imageryWords.length === 0) {
    // X-P2-22：空表（未启用或显式关）静默跳过——恒久「未启用」黄项只会训练作者
    // 无视机检面板；数据源接线后空表只剩「作者明确关掉」一种来源，仍不产黄
    return { name: '高频意象', items }
  }
  for (const word of imageryWords) {
    if (!word) continue
    let count = 0
    let idx = body.indexOf(word)
    while (idx !== -1) {
      count++
      idx = body.indexOf(word, idx + word.length)
    }
    // R26-29（二十六轮）：阈值边界统一为 `>`（超过才报）——与 checkBodyParts/checkSimile
    // 的「≤阈 合法、>阈 报黄」语义一致（#27 第 5.3 节同款）；原 `>=` 让恰好踩线的
    // 「3 次整」也报，与身体部位/比喻两项口径分裂。
    if (count > threshold) {
      items.push({
        checkId: 'imagery-overuse',
        level: 'yellow',
        message: `高频意象「${word}」本章出现 ${count} 次（>${threshold}），疑似套路堆叠`,
      })
    }
  }
  return { name: '高频意象', items }
}

/** 文风铁律可量化阈值 + parseIronRules 已下沉 format/iron-rules.ts（P2-A1 消循环依赖），此处仅用类型。 */

/**
 * 文风机检纯统计（文风方案 §4.2，体检报告重扫用）。
 *
 * 把 checkStyleMetrics 的「判定 + 推 CheckItem」拆成两层：本函数只算数值指纹，
 * checkStyleMetrics 内部委托它再包装成 CheckItem（DRY + 守 439 绿）。
 *
 * 字段口径以现 checkStyleMetrics 实现为准（文风方案 §4.2 表为意向非契约）：
 * - overlongRatio：超 maxSentenceLen 的句子数 / 总句数；无 maxSentenceLen 时记 0
 * - adjStackHits：形容词堆叠去重命中数（与 checkStyleMetrics 的 new Set 口径一致）
 * - dialogueTagRatio：对话行中被标签修饰的占比（分母=含引号的对话行数，非全文）
 * - parallelStreakMax：最大同构排比连续数（补全统计；checkStyleMetrics 仍按首次越界推一条）
 * - summaryEnding：结尾 140 字是否命中总结体套路
 *
 * `_dialogueLines` 是内部辅助字段（对话行总数，供 checkStyleMetrics 判"有无对话行"不崩），外部聚合不用。
 */
export interface StyleStats {
  overlongRatio: number
  adjStackHits: number
  dialogueTagRatio: number
  parallelStreakMax: number
  summaryEnding: boolean
  /** 对话行总数（>0 才允许 dialogueTagRatio 有意义）；内部用，聚合层可忽略 */
  _dialogueLines: number
  /** 已分句结果（供 checkStyleMetrics 复用，避免重复 split；P2-BE-2） */
  _sentences?: string[]
  _sentencesWithColon?: string[]
}

/** 纯统计函数：对正文算文风 5 维数值指纹，不产 CheckItem（文风方案 §4.2） */
export function computeStyleMetrics(body: string, rules: IronRules): StyleStats {
  const sentences = splitSentences(body)
  const sentencesWithColon = splitSentences(body, true)

  // 单句超限占比
  let overlongRatio = 0
  if (rules.maxSentenceLen && rules.maxSentenceLen > 0) {
    if (sentences.length > 0) {
      // R73-19：句长码点口径（与 countWords 一致）
      const overlong = sentences.filter((s) => codePointLength(s) > rules.maxSentenceLen!).length
      overlongRatio = overlong / sentences.length
    }
  }

  // 形容词堆叠去重命中数
  let adjStackHits = 0
  if (rules.maxAdjStack && rules.maxAdjStack > 0) {
    adjStackHits = matchAdjStackHits(body, rules.maxAdjStack).length
  }

  // 对话标签占比（分母=对话行数）
  let dialogueTagRatio = 0
  const dialogueLines = body
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => QUOTED_SPAN_RE.test(line))
  if (rules.maxDialogueTagRatio !== undefined && dialogueLines.length > 0) {
    // V-P1-7：标签判定只看引号外的提示语——对整行 test 会把对白里的
    // 「知道/别叫/笑道」等普通内容也算成对话标签，分子系统性虚高。
    // R26-11：剥引号后的判定改 DIALOGUE_TAG_RE 双侧边界锚定（构词语素不再误命中）。
    const tagged = dialogueLines.filter((line) => DIALOGUE_TAG_RE.test(stripQuotedSpans(line))).length
    dialogueTagRatio = tagged / dialogueLines.length
  }

  // 最大同构排比连续数（补全统计，不同于 checkStyleMetrics 的「首次越界即 break」）。
  // R26-47（二十六轮）：循环内 new RegExp 提升为模块级常量 PARALLEL_PREFIX_RE（纯浪费）
  let parallelStreakMax = 0
  if (rules.maxParallelStreak !== undefined && rules.maxParallelStreak > 0) {
    let prev = ''
    let streak = 0
    for (const sentence of sentencesWithColon) {
      const prefix = sentence.match(PARALLEL_PREFIX_RE)?.[0] ?? ''
      if (prefix && prefix === prev) {
        streak += 1
      } else {
        prev = prefix
        streak = prefix ? 1 : 0
      }
      if (streak > parallelStreakMax) parallelStreakMax = streak
    }
  }

  // 结尾总结体
  let summaryEnding = false
  if (rules.avoidSummaryEnding) {
    const ending = body.trim().slice(-140)
    summaryEnding = summaryEndingRegex().test(ending)
  }

  return {
    overlongRatio,
    adjStackHits,
    dialogueTagRatio,
    parallelStreakMax,
    summaryEnding,
    _dialogueLines: dialogueLines.length,
    _sentences: sentences,
    _sentencesWithColon: sentencesWithColon,
  }
}

/**
 * 文风可量化检查（#10 项 9，🟡 黄）。
 * 贴近 文风铁律.md 的可量化硬约束：单句上限 / 形容词堆叠 / 对话提示语（#5 第 8 节）。
 * 阈值来自铁律；缺省项不检。零 token 启发式，只报不拦（ask 不 deny）。
 */
export function checkStyleMetrics(
  body: string,
  rules: IronRules,
): CheckSectionResult {
  const stats = computeStyleMetrics(body, rules)
  const items: CheckItem[] = []

  // 单句超铁律上限（逐句推一条，复用 stats 已分句结果）
  if (rules.maxSentenceLen && rules.maxSentenceLen > 0) {
    const sentences = stats._sentences ?? splitSentences(body)
    for (const s of sentences) {
      const len = codePointLength(s)
      if (len > rules.maxSentenceLen) {
        items.push({
          checkId: 'style-sentence-overlong',
          level: 'yellow',
          message: `单句 ${len} 字超文风铁律上限 ${rules.maxSentenceLen} 字：「${s.slice(0, 16)}…」`,
        })
      }
    }
  }

  // 形容词连续堆叠：去重后逐个推（保持原行为）
  if (rules.maxAdjStack && rules.maxAdjStack > 0) {
    for (const h of matchAdjStackHits(body, rules.maxAdjStack)) {
      items.push({
        checkId: 'style-adj-stack',
        level: 'yellow',
        message: `形容词堆叠超上限（${rules.maxAdjStack}）：「${h}」`,
      })
    }
  }

  // 对话提示语堆叠（"…地说/道"，优先"他说"，#5 第 8 节示例）
  // Z-17（第五十八轮）：X地道 收窄为后续跟引语标点（:：""「『）——「十分地道，」这类
  // 词语误用（地道=名词「正宗」，非「说道」动词）不再计入；X地说 不受影响（无同形名词）
  // R33-31（三十三轮）：消费模块常量（原每调用 new RegExp 两枚）
  const tagHits = [
    ...(body.match(DIALOGUE_TAG_SHUO_RE) ?? []),
    ...(body.match(DIALOGUE_TAG_DIDAO_RE) ?? []),
  ]
  if (tagHits.length) {
    for (const t of new Set(tagHits)) {
      items.push({
        checkId: 'style-dialogue-tag',
        level: 'yellow',
        message: `对话提示语堆叠「${t}」，建议简化（优先"他${t.endsWith('说') ? '说' : '道'}"）`,
      })
    }
  }

  // 对话标签占比：用 stats 算好的 ratio（口径与原实现一致，分母=对话行数）
  if (rules.maxDialogueTagRatio !== undefined && stats.dialogueTagRatio > rules.maxDialogueTagRatio && stats._dialogueLines > 0) {
    items.push({
      checkId: 'style-dialogue-tag-ratio',
      level: 'yellow',
      message: `对话标签占比 ${(stats.dialogueTagRatio * 100).toFixed(0)}% 超文风铁律上限 ${(rules.maxDialogueTagRatio * 100).toFixed(0)}%，可增加无标签对话。`,
    })
  }

  // 连续同构排比：首次越界即推一条 + break（保持原行为；max 留在 stats 供聚合用）。
  // R26-47：循环内 new RegExp 提升为模块级常量 PARALLEL_PREFIX_RE
  if (rules.maxParallelStreak !== undefined && rules.maxParallelStreak > 0 && stats.parallelStreakMax > rules.maxParallelStreak) {
    // 复算首个越界 prefix（复用 stats 已分句结果）
    const sentences = stats._sentencesWithColon ?? splitSentences(body, true)
    let prev = ''
    let streak = 0
    let hitPrefix = ''
    for (const sentence of sentences) {
      const prefix = sentence.match(PARALLEL_PREFIX_RE)?.[0] ?? ''
      if (prefix && prefix === prev) {
        streak += 1
      } else {
        prev = prefix
        streak = prefix ? 1 : 0
      }
      if (streak > rules.maxParallelStreak) {
        hitPrefix = prefix
        break
      }
    }
    items.push({
      checkId: 'style-parallel-streak',
      level: 'yellow',
      message: `连续同构排比「${hitPrefix}…」超过 ${rules.maxParallelStreak} 句，建议打散节奏。`,
    })
  }

  // 结尾总结体
  if (rules.avoidSummaryEnding && stats.summaryEnding) {
    items.push({
      checkId: 'style-summary-ending',
      level: 'yellow',
      message: '结尾疑似总结体，可改成动作、物件或余韵画面收束。',
    })
  }

  return { name: '文风可量化', items }
}

function adjStackRegex(maxAdjStack: number): RegExp {
  return new RegExp(`(?:[${HANZI}]{1,6}的(?:[、，,]\\s*)?){${maxAdjStack + 1},}`, 'gu')
}

/** R26-47（二十六轮）：排比前缀匹配——原 computeStyleMetrics/checkStyleMetrics 两处
 *  循环体内逐句 new RegExp(`^[汉字]{2}`)，提升为模块级常量（内容循环不变）。 */
const PARALLEL_PREFIX_RE = new RegExp(`^[${HANZI}]{2}`, 'u')

/**
 * R73-18（二十一轮）：领属链排除——adjStackRegex 匹配任意「X的」链，「他的母亲的
 * 家族的」这类人称代词/亲属词领属链与形容词堆叠（「苍白的干裂的颤抖的」）完全两回事，
 * 此前同判误报。逐单元拆开命中串，任一单元头是人称代词/亲属称谓 → 整条按领属链豁免。
 */
const POSSESSIVE_HEADS = new Set([
  // 人称代词（含复数/反身）
  '他', '她', '它', '我', '你', '您', '他们', '她们', '它们', '我们', '你们', '咱们', '自己', '别人', '他人',
  // 亲属/师门/主仆称谓（网文领属链高发词）
  '父亲', '母亲', '爸爸', '妈妈', '爹', '娘', '爷爷', '奶奶', '外公', '外婆', '姥爷', '姥姥',
  '哥哥', '姐姐', '弟弟', '妹妹', '兄长', '兄弟', '姐妹', '大哥', '大姐', '堂哥', '堂弟', '表哥', '表妹',
  '叔叔', '伯伯', '舅舅', '姑姑', '姨母', '婶婶', '儿子', '女儿', '孩子', '家人', '家族', '族人',
  '师父', '师傅', '老师', '师兄', '师姐', '师弟', '师妹', '主人', '老爷', '少爷', '夫人', '娘子', '前辈', '晚辈',
])

/** 领属链判定：命中串由 N 个「X的」单元组成，任一单元头命中 POSSESSIVE_HEADS → true。
 *  R26-47（二十六轮）：单元正则原在逐命中过滤循环内逐次 new，提升为模块级常量
 *  （matchAll 内部克隆消费，不携带 lastIndex 状态，共享安全）。 */
const POSSESSIVE_UNIT_RE = new RegExp(`([${HANZI}]{1,6})的(?:[、，,]\\s*)?`, 'gu')

function isPossessiveChain(hit: string): boolean {
  for (const m of hit.matchAll(POSSESSIVE_UNIT_RE)) {
    if (POSSESSIVE_HEADS.has(m[1]!)) return true
  }
  return false
}

/** 形容词堆叠命中（去重 + R73-18 领属链豁免）——computeStyleMetrics 与 checkStyleMetrics 共用单源 */
function matchAdjStackHits(body: string, maxAdjStack: number): string[] {
  const hits = body.match(adjStackRegex(maxAdjStack))
  if (!hits) return []
  return [...new Set(hits)].filter((h) => !isPossessiveChain(h))
}

function summaryEndingRegex(): RegExp {
  // P3-12：`.*` 不跨行 → 换 `[\s\S]*`（多行结尾（分段总结体）此前漏检；漏检方向安全不误报）
  // AA-P3-6：前段改惰性 `[\s\S]*?`——触发词与收束词取「最近」配对，最小匹配窗，避免
  // 同一收束窗内跨大段误配（结尾 140 字窗口内，贪婪会吞到最后一个收束词才回吐）。
  return /(这一刻|那一刻|这一战|此役|从此|直到很久以后|多年以后|命运|人生|终于明白|原来)[\s\S]*?(明白|懂得|领悟|真谛|道理|命运|人生|结束|开始|答案)/
}

/**
 * 信息差泄密候选（#10 项 11，🟡 黄）。
 * 关键词命中 → 只出候选、不拦截（真伪归阶段 6 三审，PRD 问题 3）。
 * 关键词两级供给（数据源接线后由 runner 解析，本函数只吃现成表）：入参显式 >
 * book.yaml checks.leak_keywords；无内置默认（逐书的秘密无通用词表），
 * 未设 = 空表静默不启用。入参 readonly——与 checkImagery 同口径。
 */
export function checkInfoLeak(
  body: string,
  leakKeywords: readonly string[] = [],
): CheckSectionResult {
  const items: CheckItem[] = []
  if (leakKeywords.length === 0) {
    // X-P2-22：空表（未配置）静默跳过——恒久「未启用」黄项只会训练作者无视机检面板；
    // 信息差无内置默认词表，空表 = 本书没配关键词，属正常态不产黄
    return { name: '信息差候选', items }
  }
  for (const kw of leakKeywords) {
    if (kw && body.includes(kw)) {
      items.push({
        checkId: 'info-leak-candidate',
        level: 'yellow',
        message: `信息差候选：正文出现「${kw}」，请确认是否提前泄露（真伪归三审）`,
      })
    }
  }
  return { name: '信息差候选', items }
}

// ── 短篇专属机检项（M8 #27 第 5.3 节，新增）──────────
//
// 短篇目标函数是单章情绪爆破，4 项专属软约束（吸收点 7.1）：
// 身体部位词 ≤5 / 「像」≤10 / 节数守恒=5 / 开头零环境。
// 全部零 token 脚本判定，黄项只报不拦（ask 不 deny）。

/** 短篇字数阈值（#27 第 5.2 节，🟡 黄）。
 *  总字数 8000–20000（工单第 0 节）；阈值待 beta 校准，本期定方向。 */
export function checkPieceWordCount(
  actualWords: number,
  min = 8000,
  max = 20000,
): CheckSectionResult {
  const items: CheckItem[] = []
  if (actualWords < min) {
    items.push({
      checkId: 'piece-word-short',
      level: 'yellow',
      message: `字数 ${actualWords} 低于短篇下限 ${min}（短篇目标 ${min}–${max}）`,
    })
  } else if (actualWords > max) {
    items.push({
      checkId: 'piece-word-long',
      level: 'yellow',
      message: `字数 ${actualWords} 超过短篇上限 ${max}（短篇目标 ${min}–${max}）`,
    })
  }
  return { name: '短篇字数', items }
}

/** 默认身体部位词表（吸收点 7.1 正文洁净，AI 味堆砌高发项） */
const DEFAULT_BODY_PARTS = ['眼睛', '眼神', '眼眶', '手指', '手掌', '心脏', '心跳', '脸庞', '嘴角', '眉头', '喉咙', '呼吸']

/**
 * 「手」的动作语境模式 —— 单字「手」直接 indexOf 会误伤「对手/高手/随手/手段」等非部位词，
 * 只统计带动作前/后缀的肢体动作（伸手、握住手等），剔除隐喻与惯用语。
 */
const HAND_ACTION_RE = /(?:伸|握|抓|拉|抬|挥|摊|攥|搓|叉|捂|托|撑|扶|搭|拽|按|放|松|紧|握住|抓住)了?手/g

/**
 * 身体部位词检查（#27 第 5.3 节，🟡 黄）。
 * 正文洁净：眼/心脏等堆砌计数超阈报黄（AI 味高发）。
 * 单字「手」单独走 HAND_ACTION_RE 动作语境匹配，避免「对手/高手/随手」误报。
 */
export function checkBodyParts(
  body: string,
  threshold = 5,
  words: string[] = DEFAULT_BODY_PARTS,
): CheckSectionResult {
  const items: CheckItem[] = []
  const over: string[] = []
  for (const word of words) {
    if (!word) continue
    let count = 0
    let idx = body.indexOf(word)
    while (idx !== -1) {
      count++
      idx = body.indexOf(word, idx + word.length)
    }
    if (count > threshold) over.push(`${word}×${count}`)
  }
  // 单字「手」走动作语境匹配，避免误伤惯用语
  const handCount = (body.match(HAND_ACTION_RE) ?? []).length
  if (handCount > threshold) over.push(`手×${handCount}`)
  if (over.length > 0) {
    items.push({
      checkId: 'body-parts',
      level: 'yellow',
      message: `身体部位词堆砌超阈（≤${threshold}）：${over.join('、')}`,
    })
  }
  return { name: '身体部位词', items }
}

/**
 * 「像」比喻密度检查（#27 第 5.3 节，🟡 黄）。
 * 比喻泛滥计数：明喻句式超阈报黄。
 * P3-12：此前把所有「像」字都计入比喻统计（含「相像/很像/好像/不像/像他这样的人」
 * 等非比喻），误报偏高——现按句式约束：像 + 名词性短语（可带「一样/似的/般」尾缀），
 * 排除非比喻「像」字用法；「像刀/像雪」等短比与「像X一样」长比都计。
 */
// R-9（十五轮登记销账）：前置排除改零宽 lookbehind——原消费型 (?:^|[^相很好不像]) 会
// 吞掉「像」前一个字符，相邻明喻（如「像刀像雪」）第二个「像」因前字符已被上一命中
// 消费而漏计（漏报不误报）；lookbehind 语义等价（行首无边=通过、前排他字符=拒绝）。
// R67-9（十五轮）登记口径：前排他集含「好」是排除高频非比喻「好像」的必要代价——
// 「恰好像刀」「正好像雪」等真·明喻被一并漏计；本检查为超阈黄项密度统计，漏报向
// 安全（不误报），且「恰好/正好」+明喻连用占比极低，零 token 边界不做分词级判别。
// R73-14（二十一轮 B-1）：前排他集再纳入「X像」名词首字（图像/偶像/摄像/录像/影像/
// 照像/画像/音像/映像/实像/虚像/镜像/显像/成像/雕像/塑像/石像/铜像/铁像/玉像/蜡像/
// 金像/肖像/绣像/头像/佛像/神像/遗像/铸像/拟像/造像/圣像/形象/印像/想像）——此前
// 词内「像」未排除名词，「他用图像处理软件处理图像数据。」实测命中 2 次、「摄像头
// 对准了门口」「她是全民偶像明星」各命中 1；短篇 strict 模式下 simile-density 升红
// 会把无一流比的名物章打回重写烧调用。代价（同 R67-9 登记式取舍）：「拳头像铁锤」
// 「石头像刀一样硬」等「X头像/X石像」明喻被一并漏计（漏报向安全）；「人像蝼蚁」
// 类人字领明喻不排（人像的肖像义在散文里远低于明喻用法）。后排他集补「样」——
// 「挺像样」「很像样」的「像样」非比喻。
const SIMILE_RE = /(?<![相很好不像图偶摄入影照实音画映形印想虚镜显成雕塑石铜铁玉蜡金肖绣头佛神遗铸拟造圣群])(像)(?!他|她|你|我|这|那|样)[^，。！？；、：\s像]{1,12}(?:一样|似的|一般|般)?/gu

export function checkSimile(
  body: string,
  threshold = 10,
): CheckSectionResult {
  const items: CheckItem[] = []
  // 统计明喻句式命中数（粗计；精确判定比喻语义需 NLP，零 token 取句式近似）
  const count = (body.match(SIMILE_RE) ?? []).length
  if (count > threshold) {
    items.push({
      checkId: 'simile-density',
      level: 'yellow',
      message: `比喻句「像…」出现 ${count} 次超阈值（≤${threshold}），比喻泛滥疑似 AI 味`,
    })
  }
  return { name: '比喻密度', items }
}

/**
 * 节数守恒检查（#27 第 5.3 节，🟡 黄）。
 * 正文实际节数（按空行切块）与五段结构一致。严重不符可定红（阈值实现期定）。
 */
export function checkSectionCount(
  body: string,
  expected = 5,
): CheckSectionResult {
  // R34D-12（三十四轮）：section_count 可配置（runner 传 short.section_count），文案
  // 不得硬编码「五段结构」——配置 ≠5 的 strict 短篇把黄提红后 formatRedForRewrite
  // 喂给自愈重写，重写目标被误导成五段。期望值统一插值 expected；五段节名枚举仅在
  // 缺省 5 段时保留（≠5 臆造不出节名，去枚举按期望节数描述）。
  const five = expected === 5
  const structLabel = five ? '五段结构' : `${expected} 段结构`
  const sectionGuide = five
    ? '建议写成 ## 开头钩子 / ## 铺垫 / ## 升级 / ## 反转 / ## 余韵'
    : `建议用 ## 标题标出 ${expected} 个节`
  const items: CheckItem[] = []
  // 有 ## 标题才按标题计五段；无标题时不把自然段空行误判为“节”。
  // 用 match 数标题行（split 会把首个 ## 之前的前导内容多计一节）。
  // R26-43（二十六轮）：`##` 后空白可选（`##标题` 紧排形态此前漏计 → 全部落
  // 「未使用 ## 标注」误导文案）；`##` 后须仍有内容（`.+`），裸 `##` 行不计。
  // R27-25（二十七轮）：计数先剥代码围栏（``` / ~~~）内的行——设定/知识块里
  // 引用示例的 `## xxx` 此前被当节标题计入，节数守恒虚高误绿
  // R28-9（二十八轮·先证伪后修）：评审上报「孤立闭合 ``` 翻真吞掉其后全部 ## 标题」
  // 经 CommonMark 对照**证伪**——非围栏态遇 ``` 行本就是「开栏」（围栏可无信息串），
  // 无配对时围栏延伸到文末、其内 ## 不计恰是 spec 正确行为，该项转维持登记。
  // 但推演发现真实 spec 偏离并做最小修复：CommonMark 要闭栏行与开栏**同字符、长度
  // 不小于开栏、其后只允许空白**；原 `(```|~~~)` 一视同仁互翻 → ① ~~~ 开的栏被 ```
  // 提前闭合（反之亦然）；② 围栏内的 ~~~/``` 内容行被误当闭栏；③ 带信息串的闭栏行
  // （如 ```js）在围栏内应属内容却被当闭栏。改记开栏字符+长度，闭栏行须三者皆符；
  // 开栏语义不变（非围栏态 ``` / ~~~ 行照旧开栏，信息串允许）。
  let fence: { ch: string; len: number } | null = null
  const stripped = body
    .split('\n')
    .filter((ln) => {
      // R33-1（三十三轮）：尾部 `\r?` 容忍——CRLF 文件按 \n 切行后行尾残留 \r，而
      // `.` 不匹配 \r 且本正则无 m 标志（$ 只认串尾），原样下 "```\r"/"```js\r" 匹配
      // 恒失败 → fence 恒 null → 围栏内 ## 全部计入节数，R27-25 语义在 win 主平台
      // 整体反转（短篇 strict 假红硬拦定稿）。标题行正则带 m 标志（JS 多行模式视 \r
      // 为行终止符）不受影响，只修本处。
      const m = ln.match(/^\s{0,3}(`{3,}|~{3,})(.*)\r?$/)
      if (fence === null) {
        // 非围栏态：```/~~~ 行（信息串可选）= 开栏（R27-25 语义不变），开栏行剥除
        if (m) fence = { ch: m[1]![0]!, len: m[1]!.length }
        return !m
      }
      // 围栏态：仅同类同长且其后只有空白的行 = 闭栏；其余（异类/更短/带信息串）
      // 是围栏内容，照旧剥除不计
      if (m && m[1]![0]! === fence.ch && m[1]!.length >= fence.len && m[2]!.trim() === '') {
        fence = null
      }
      return false
    })
    .join('\n')
  // R28-2（二十八轮）：R26-43 把 `\s` 放宽为 `\s*`（支持 `##标题` 紧排）后未排除更深
  // `#` 前缀——`^##\s*.+` 对「### 手记」以 `##` + 空 + `# 手记` 误命中，`###`/`####`
  // 子标题被当节标题计入 → 节数虚高 → section-count 假黄 → 短篇 strict 提红拦定稿。
  // 改 `^##(?!#)`：lookahead 排除 `###`/`####`，紧排 `##标题` 照旧命中、裸 `##` 行
  // 照旧不计（R26-43 语义不变）。
  const headings = stripped.match(/^##(?!#)\s*.+$/gm) ?? []
  let sections: number
  if (headings.length >= 2) {
    // 有 ## 标题：按标题数
    sections = headings.length
  } else if (headings.length === 1) {
    // RB-KN-P2-7：单标题给准确文案——原本文案说「未使用 ## 标注」失真（作者用了但只有 1 个），
    // 严格模式下被提升为红时误导作者「完全没写标题」
    items.push({
      checkId: 'section-count-heading-missing',
      level: 'yellow',
      message: `正文仅检测到 1 个 ## 标题，不足以标注${structLabel}；${sectionGuide}，本项不按自然段计节。`,
    })
    return { name: '节数守恒', items }
  } else {
    items.push({
      checkId: 'section-count-heading-missing',
      level: 'yellow',
      message: `正文未使用 ## 标注${structLabel}；${sectionGuide}，本项不按自然段计节。`,
    })
    return { name: '节数守恒', items }
  }
  if (sections !== expected) {
    items.push({
      checkId: 'section-count',
      level: 'yellow',
      message: `正文 ${sections} 节，期望 ${expected} 节（节数守恒）`,
    })
  }
  return { name: '节数守恒', items }
}

/** 默认环境描写关键词表（黄金 300 字直入钩子，吸收点 7.1） */
const DEFAULT_ENV_WORDS = ['天气', '阳光', '月光', '日升', '日落', '天空', '云层', '乌云', '风声', '狂风', '雨声', '雨点', '景色', '远山', '树林', '街道', '建筑']

/**
 * 开头零环境检查（#27 第 5.3 节，🟡 黄）。
 * 黄金 300 字直入钩子：开篇 300 字命中环境描写词报黄。
 */
export function checkOpeningNoEnv(
  body: string,
  openingChars = 300,
  envWords: string[] = DEFAULT_ENV_WORDS,
): CheckSectionResult {
  const items: CheckItem[] = []
  // R29-4（二十九轮）：opening 窗口先剥对白引号 span 再匹配环境词——角色嘴里说的
  // 「今天天气真好」是对白不是环境描写（叙述面），裸匹配此前误报对白密集的开篇。
  // 窗口尾截断的半个 span（有开无闭）不被识别为 span → 该处引号内容仍参与匹配，
  // 属可接受的漏报向残余（黄项 advisory，非红闸）。
  // R33-32（三十三轮）：码点口径（对齐 R73-19）——UTF-16 直接 slice 在含 astral 字符
  // 时窗口实际缩短；astral 码点最多占 2 个 UTF-16 单元，先取 openingChars*2 单元再按
  // 码点截断，窗口恒足 openingChars 码点。
  const opening = stripQuotedSpans([...body.slice(0, openingChars * 2)].slice(0, openingChars).join(''))
  const hits: string[] = []
  for (const word of envWords) {
    if (word && opening.includes(word)) hits.push(word)
  }
  if (hits.length > 0) {
    items.push({
      checkId: 'opening-env',
      level: 'yellow',
      message: `开头 ${openingChars} 字出现环境描写（${hits.slice(0, 3).join('、')}），黄金 300 字应直入钩子`,
    })
  }
  return { name: '开头零环境', items }
}
