/**
 * 文风可量化/信息差检查族 —— 自 src/check/count.ts 缝 B 拆出。
 *
 * （⑤④产品巨件拆分波1）：count.ts（1144 行）纯移动拆分——
 * 本文件承载缝 B（StyleStats/computeStyleMetrics/checkStyleMetrics/adjStack 缓存族/
 * DE_RUN_SPLIT/POSSESSIVE 族/排比/结尾总结体/checkInfoLeak）。归属按「常量随所属
 * check 函数整体搬」实读判定：DIALOGUE_TAG_RE 唯一消费方是 computeStyleMetrics、
 * DIALOGUE_TAG_SHUO/DIDAO_RE 唯一消费方是 checkStyleMetrics，故三者随文风族落此，
 * 未随 DIALOGUE_GUIDE_RE（唯一消费方 checkNewNames）归缝 A count-dialogue.ts。
 * 对话/名册族见 count-dialogue.ts；front matter/意象/短篇项留 count.ts 残核
 * （头注保留原全部历史记载与拆分沿革）。
 * 依赖方向：check（types/quotes/count-dialogue 同层）/format（sentences/iron-rules）/
 * shared 既有方向，不入 AI 生成层（守护范围）。
 */

import type { CheckSectionResult, CheckItem } from './types.js'
import { splitSentences } from '../format/sentences.js'
import { QUOTED_SPAN_RE, stripQuotedSpans, SPAN_PUNCT } from './quotes.js'
// -：IronRules 类型下沉到 format 层（format/iron-rules.ts），消除 format→check 循环依赖
import type { IronRules } from '../format/iron-rules.js'
// 句长码点口径（代理对合 1 计）。
// -优化：实现收编 src/shared/text.ts 单源（原本地副本删）。
import { codePointLength } from '../shared/text.js'
// （拆分批）：HANZI 区间/SPEECH_VERBS 动词集是跨缝共享单源——
// 「留 count.ts 残核供两缝 import」经 ESM 环形依赖推演不可行（count.ts 的 re-export
// import 提升先于残核常量初始化，两新文件顶层 RegExp 构造即踩 TDZ ReferenceError），
// 故随缝 A 落 count-dialogue.ts export、本文件直接 import，单源不重复（口径不破）。
import { HANZI, SPEECH_VERBS } from './count-dialogue.js'

// 对话提示语正则模块常量化（循）——原在 checkStyleMetrics
// 每次调用 new RegExp 两枚；String.match 对带 g 的正则不保留 lastIndex，提升安全。
const DIALOGUE_TAG_SHUO_RE = new RegExp(`[${HANZI}]{2,}地说`, 'gu')
const DIALOGUE_TAG_DIDAO_RE = new RegExp(`[${HANZI}]{2,}地道(?=[:：\u201c\u2018「『])`, 'gu')

/**
 * 对话标签提示语结构锚定（computeStyleMetrics 对话标签占比用）。
 * 只看引号外文本后，裸字面匹配（`[汉字]{1,8}说|道|…(了|着)?`）仍把剥引号后
 * 残留的构词语素当标签——「“走吧。”他知道已经拦不住了。」剥引号后「他知道…」的
 * 「道」、「味道/道理/笑点」的语素均误命中，分子系统性虚高。改双侧边界锚定（对白
 * 提示语形态「X说：」「他道，」「XX喊道。」）：
 * - 动词段（1-8 汉字人名/代词前缀 + 说话动词 + 可选 了/着）整体前须行首/标点/空白；
 * - 动词（含尾缀）后须紧跟标点/冒号/行尾——构词语素后跟普通字（知「道」→已经）不再匹配。
 * stripQuotedSpans 语义不变（对白内容不算标签）。
 * 原循环/逐行 new RegExp 提升为模块级常量（无 g 标志，test 安全）。
 * 动词段收 SPEECH_VERBS 单源——原 8 动词窄于归属行豁免的 21 动词，
 * 标签占比分子系统性偏低（漏检向黄），对齐后双口径同词表。
 * （拆分批）：自 count.ts 缝 A 区段随消费方 computeStyleMetrics
 * 迁入（SPEECH_VERBS 单源仍在 count-dialogue.ts，见文件头注）。
 */
const TAG_ANCHOR = `[\\s${SPAN_PUNCT}「」『』“”‘’（）《》〈〉]`
export const DIALOGUE_TAG_RE = new RegExp(
  `(?:^|${TAG_ANCHOR})[${HANZI}]{1,8}(?:${SPEECH_VERBS})(?:了|着)?(?=$|${TAG_ANCHOR})`,
  'u',
)

/** 文风铁律可量化阈值 + parseIronRules 已下沉 format/iron-rules.ts（- 消循环依赖），此处仅用类型。 */

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
  /** 已分句结果（供 checkStyleMetrics 复用，避免重复 split；-BE-2） */
  _sentences?: string[]
  _sentencesWithColon?: string[]
  /** 形容词堆叠命中串列表（供 checkStyleMetrics 复用，避免重复全文匹配；，_sentences 同款口径） */
  _adjStackHits?: string[]
  /** 首个越界排比前缀（checkStyleMetrics 消费；与
   *  parallelStreakMax 同循环一次记出，_adjStackHits 同款内部复用先例）。
   *  undefined = 未越界或 maxParallelStreak 未启用。 */
  _parallelStreakHitPrefix?: string
}

/** 纯统计函数：对正文算文风 5 维数值指纹，不产 CheckItem（文风方案 §4.2） */
export function computeStyleMetrics(body: string, rules: IronRules): StyleStats {
  const sentences = splitSentences(body)
  const sentencesWithColon = splitSentences(body, true)

  // 单句超限占比
  let overlongRatio = 0
  if (rules.maxSentenceLen && rules.maxSentenceLen > 0) {
    if (sentences.length > 0) {
      // 句长码点口径（与 countWords 一致）
      const overlong = sentences.filter((s) => codePointLength(s) > rules.maxSentenceLen!).length
      overlongRatio = overlong / sentences.length
    }
  }

  // 形容词堆叠去重命中数（命中串列表随 `_sentences` 同款口径
  // 挂内部字段，checkStyleMetrics 复用免二次全文匹配）
  let adjStackHits = 0
  let adjStackHitList: string[] = []
  if (rules.maxAdjStack && rules.maxAdjStack > 0) {
    adjStackHitList = matchAdjStackHits(body, rules.maxAdjStack)
    adjStackHits = adjStackHitList.length
  }

  // 对话标签占比（分母=对话行数）
  let dialogueTagRatio = 0
  const dialogueLines = body
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => QUOTED_SPAN_RE.test(line))
  if (rules.maxDialogueTagRatio !== undefined && dialogueLines.length > 0) {
    // 标签判定只看引号外的提示语——对整行 test 会把对白里的
    // 「知道/别叫/笑道」等普通内容也算成对话标签，分子系统性虚高。
    // 剥引号后的判定改 DIALOGUE_TAG_RE 双侧边界锚定（构词语素不再误命中）。
    const tagged = dialogueLines.filter((line) => DIALOGUE_TAG_RE.test(stripQuotedSpans(line))).length
    dialogueTagRatio = tagged / dialogueLines.length
  }

  // 最大同构排比连续数（补全统计，不同于 checkStyleMetrics 的「首次越界即 break」）。
  // 循环内 new RegExp 提升为模块级常量 PARALLEL_PREFIX_RE（纯浪费）
  // 首个越界前缀同一循环一次记出（_parallelStreakHitPrefix）
  // ——checkStyleMetrics 原为取 hitPrefix 把本循环整跑第二遍（逐句 regex 重付）；「首次
  // 越界」取值与原 break 版逐位一致（同一句列、同一正则、同一 streak 口径）。
  let parallelStreakMax = 0
  let parallelStreakHitPrefix: string | undefined
  if (rules.maxParallelStreak !== undefined && rules.maxParallelStreak > 0) {
    let prev = ''
    let streak = 0
    let hitPrefix: string | undefined
    for (const sentence of sentencesWithColon) {
      const prefix = sentence.match(PARALLEL_PREFIX_RE)?.[0] ?? ''
      if (prefix && prefix === prev) {
        streak += 1
      } else {
        prev = prefix
        streak = prefix ? 1 : 0
      }
      if (streak > parallelStreakMax) parallelStreakMax = streak
      if (hitPrefix === undefined && streak > rules.maxParallelStreak) hitPrefix = prefix
    }
    parallelStreakHitPrefix = hitPrefix
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
    _adjStackHits: adjStackHitList,
    _parallelStreakHitPrefix: parallelStreakHitPrefix,
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
    // 复用 computeStyleMetrics 已算的命中串（computeFullStats/
    // checkStyleMetrics 委托链各跑一遍全文匹配的重复消除）
    const hits = stats._adjStackHits ?? matchAdjStackHits(body, rules.maxAdjStack)
    for (const h of hits) {
      items.push({
        checkId: 'style-adj-stack',
        level: 'yellow',
        message: `形容词堆叠超上限（${rules.maxAdjStack}）：「${h}」`,
      })
    }
  }

  // 对话提示语堆叠（"…地说/道"，优先"他说"，#5 第 8 节示例）
  // X地道 收窄为后续跟引语标点（""「『）——「十分地道，」这类
  // 词语误用（地道=名词「正宗」，非「说道」动词）不再计入；X地说 不受影响（无同形名词）
  // 消费模块常量（原每调用 new RegExp 两枚）
  // 堆叠项与上方占比项同族对齐——占比项自起只统计剥引号后的
  // 提示语，堆叠项却吃 raw body，对白内容里的「X地说」（角色嘴里的话，非作者叙述
  // 堆叠）被计入，同文件双口径分裂；对齐 stripQuotedSpans 单源，只收窄「哪些文本
  // 参与计数」（对白外命中数不变）。注意剥引号后 X地道 的引语标点 lookahead 只剩
  // ： 可命中（「」『“ 已随 span 剥除），与占比项 DIALOGUE_TAG_RE 的锚定环境一致。
  const tagProse = stripQuotedSpans(body)
  const tagHits = [
    ...(tagProse.match(DIALOGUE_TAG_SHUO_RE) ?? []),
    ...(tagProse.match(DIALOGUE_TAG_DIDAO_RE) ?? []),
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
  // 循环内 new RegExp 提升为模块级常量 PARALLEL_PREFIX_RE
  // hitPrefix 改读 computeStyleMetrics 同循环记出的
  // _parallelStreakHitPrefix（_adjStackHits 同款复用先例）——原「复算首个越界
  // prefix」把 computeStyleMetrics 已跑过的同构排比循环再跑一遍，此前 _sentencesWithColon
  // 复用只省了 splitSentences、逐句 regex 仍在重付；parallelStreakMax > 阈时该字段必有值
  //（max 由同一 streak 序列取 max），`?? ''` 仅为异源构造 stats 的防御（与原未越界初值同形）。
  if (rules.maxParallelStreak !== undefined && rules.maxParallelStreak > 0 && stats.parallelStreakMax > rules.maxParallelStreak) {
    const hitPrefix = stats._parallelStreakHitPrefix ?? ''
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

/** （修复批）：adjStack 正则按 maxAdjStack 记忆化——learn 收割逐段
 *  调用 matchAdjStackHits，原每次调用 new RegExp（同参反复编译）；maxAdjStack 经
 *  iron-rules clamp 后取值域有限（[0,20]），Map 命中即复用。`seg.match(/g 正则)` 会重置
 *  lastIndex，跨段/跨调用共享安全（同口径）。行为不变。 */
const adjStackRegexCache = new Map<number, RegExp>()
function adjStackRegex(maxAdjStack: number): RegExp {
  let re = adjStackRegexCache.get(maxAdjStack)
  if (!re) {
    re = new RegExp(`(?:[${HANZI}]{1,6}的(?:[、，,]\\s*)?){${maxAdjStack + 1},}`, 'gu')
    adjStackRegexCache.set(maxAdjStack, re)
  }
  return re
}

/**
 * adjStack 的「的」长游程切段守卫——的 ∈ [HANZI]，纯「的」
 * 长串（如 40 连发）可被 `(?:[汉字]{1,6}的){N,}` 以多种 {1,6} 分段方式匹配，失败
 * 回溯随游程长指数增长（已把 N clamp 到 [0,20]，但游程长在正文侧无界，
 * 粘贴事故/生成体正文可拖死检查）。预扫描按「的」连发游程切段丢弃——段内匹配
 * 本属垃圾（合法堆叠每单元是「≤6 汉字+的」，长连「的」不可能是合法定语堆叠），
 * 对切段逐一跑原正则、命中取并集；短游程不受影响照常检查。
 * （修复批）：界 {8,} → {3,} 收紧——4-7 连游程的
 * 分解歧义窗口一并封死。≥3 连「的」必非合法定语堆叠（每单元至少要吃 1 个头字，
 * 3 连意味着出现空头单元）；「的的」2 连的分解方式恰 1 种（c(2)=1，无歧义回溯），
 * 故歧义起点在 3 连，界收到歧义起点以下即 {3,}——主审实测 41 字符病理片段
 * （5×7 连「的」+断链尾）469ms → 0.1ms，正常文本命中零变化。
 */
const DE_RUN_SPLIT_RE = /的{3,}/

/** 形容词堆叠命中（去重 + 领属链豁免）——computeStyleMetrics 与 checkStyleMetrics 共用单源 */
function matchAdjStackHits(body: string, maxAdjStack: number): string[] {
  const re = adjStackRegex(maxAdjStack)
  const hits: string[] = []
  // 切「的」长游程后逐段匹配（String.match 对 /g 正则重置 lastIndex，段间共享安全）
  for (const seg of body.split(DE_RUN_SPLIT_RE)) {
    hits.push(...(seg.match(re) ?? []))
  }
  if (hits.length === 0) return []
  return [...new Set(hits)].filter((h) => !isPossessiveChain(h))
}

/** 排比前缀匹配——原 computeStyleMetrics/checkStyleMetrics 两处
 *  循环体内逐句 new RegExp(`^[汉字]{2}`)，提升为模块级常量（内容循环不变）。 */
const PARALLEL_PREFIX_RE = new RegExp(`^[${HANZI}]{2}`, 'u')

/**
 * 领属链排除——adjStackRegex 匹配任意「X的」链，「他的母亲的
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
 *  ：单元正则原在逐命中过滤循环内逐次 new，提升为模块级常量
 *  （matchAll 内部克隆消费，不携带 lastIndex 状态，共享安全）。 */
const POSSESSIVE_UNIT_RE = new RegExp(`([${HANZI}]{1,6})的(?:[、，,]\\s*)?`, 'gu')

function isPossessiveChain(hit: string): boolean {
  for (const m of hit.matchAll(POSSESSIVE_UNIT_RE)) {
    if (POSSESSIVE_HEADS.has(m[1]!)) return true
  }
  return false
}

function summaryEndingRegex(): RegExp {
  // `.*` 不跨行 → 换 `[\s\S]*`（多行结尾（分段总结体）此前漏检；漏检方向安全不误报）
  // 前段改惰性 `[\s\S]*?`——触发词与收束词取「最近」配对，最小匹配窗，避免
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
    // 空表（未配置）静默跳过——恒久「未启用」黄项只会训练作者无视机检面板；
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
