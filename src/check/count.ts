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
import { splitSentences } from '../format/sentences.js'
import { QUOTED_SPAN_RE, stripQuotedSpans, QUOTE_OPEN, QUOTE_CLOSE, SPAN_PUNCT } from './quotes.js'
// P2-A1：IronRules 类型下沉到 format 层（format/iron-rules.ts），消除 format→check 循环依赖
import type { IronRules } from '../format/iron-rules.js'

/**
 * 汉字字符范围（基本区 + 扩展 A 区）。
 * 统一使用，避免不同检查项范围不一导致生僻字人名漏判。
 * 「一-鿿」= \u4e00-\u9fa5（基本区），「㐀-䶿」= \u3400-\u4dbf（扩展 A 区）。
 */
const HANZI = '一-鿿㐀-䶿'

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
  const fileNum = Number(fileName.match(/(?:^|\/)(\d+)-/)?.[1])
  if (!Number.isNaN(fileNum) && fileNum !== chapter.章号) {
    items.push({
      checkId: 'fm-chapter-mismatch',
      level: 'red',
      message: `章号「${chapter.章号}」与文件名「${fileName}」前缀不一致`,
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

/**
 * 禁词检查（#10 项 4，🔴 红）。
 * 命中作者设的禁词表（文风铁律.md 的禁词段）。
 */
export function checkBannedWords(
  body: string,
  bannedWords: string[],
): CheckSectionResult {
  const items: CheckItem[] = []
  for (const word of bannedWords) {
    if (body.includes(word)) {
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
 * 滑窗句级 n-gram 重复率。
 */
export function checkRepeat(
  body: string,
  threshold = 0.15,
): CheckSectionResult {
  const items: CheckItem[] = []
  const sentences = splitSentences(body).filter((s) => s.length >= 6)
  const counts = new Map<string, number>()
  for (const s of sentences) {
    counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  // 重复实例数 = 每个重复句子（出现≥2次）的总出现次数 - 1
  let repeatInstances = 0
  for (const c of counts.values()) {
    if (c >= 2) repeatInstances += c - 1
  }
  if (sentences.length > 0) {
    const rate = repeatInstances / sentences.length
    if (rate > threshold) {
      items.push({
        checkId: 'repeat',
        level: 'yellow',
        message: `复读率 ${(rate * 100).toFixed(1)}% 超阈值 ${threshold * 100}%（重复 ${repeatInstances} 处）`,
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
  const overlong = sentences.filter((s) => s.length > maxLen)
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

/** X-P2-9：对白归属行结构——1-4 汉字（人名/称谓）+ 说话动词 + 可选尾缀（了/着/道）。
 *  说话人名词不在提示语词表（V-P2-13 只挡代词行），「快走。」林晚说。这类
 *  网文最高频对白行式按结构匹配豁免，否则引号内对白被当专名每章批量误报。 */
const SPEECH_ATTRIBUTION_RE =
  /^[\u4e00-\u9fa5]{1,4}(?:说|道|问|喊|叫|答|叹|笑|骂|吼|喝|斥|呼|唤|念|回|应|嘀咕|嘟囔|喃喃|低语)(?:了|着|道)?$/

/**
 * 新专名比对名册（#10 项 10，🟡 黄）。
 * 新专名 vs 名册.md，未登记 → 候选（不自动入册）。
 */
export function checkNewNames(
  body: string,
  rosterPath: string,
): CheckSectionResult {
  const items: CheckItem[] = []
  if (!existsSync(rosterPath)) return { name: '新专名候选', items }
  const roster = readFileSync(rosterPath, 'utf-8')
  // 粗抽：2-4 字中文专名候选（带引号或书名号的优先）
  const candidates = new Set<string>()
  const spanRe = new RegExp(QUOTED_SPAN_RE.source, 'g')
  const punctRe = new RegExp(`[${QUOTE_OPEN}${QUOTE_CLOSE}${SPAN_PUNCT}「」『』]`, 'gu')
  for (const rawLine of body.split(/\n+/)) {
    const line = rawLine.trim()
    const spans = line.match(spanRe)
    if (!spans) continue
    // 引号外只剩提示语成分（代词/说话动词/语气副词等）→ 整行是对白，
    // 引号片段是对白内容而非专名（V-P2-13：此前「住手！」「快走」全报黄项刷屏）
    const outside = line.replace(spanRe, '').replace(/[\s\u3000]/g, '').replace(punctRe, '')
    if (isAttributionOnly(outside)) continue
    // X-P2-9：人名 + 说话动词的对白归属行同样豁免
    if (SPEECH_ATTRIBUTION_RE.test(outside)) continue
    for (const q of spans) {
      const name = q.replace(punctRe, '')
      if (name.length < 2 || name.length > 4) continue
      // 含句读的片段是对白内容，不是专名
      if (new RegExp(`[${SPAN_PUNCT}]`).test(name)) continue
      if (!roster.includes(name)) candidates.add(name)
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
 * 意象表默认空——初始数据靠 M4 知识层平移 / book.yaml 配置（#10 第 4/8 节待 beta）。
 */
export function checkImagery(
  body: string,
  imageryWords: string[] = [],
  threshold = 3,
): CheckSectionResult {
  const items: CheckItem[] = []
  if (imageryWords.length === 0) {
    // X-P2-22：词表未配置即静默跳过——恒久「未启用」黄项只会训练作者无视机检面板；
    // 检查器本体保留，待数据源（知识层/book.yaml）接入后自然生效
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
    if (count >= threshold) {
      items.push({
        checkId: 'imagery-overuse',
        level: 'yellow',
        message: `高频意象「${word}」本章出现 ${count} 次（≥${threshold}），疑似套路堆叠`,
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
      const overlong = sentences.filter((s) => s.length > rules.maxSentenceLen!).length
      overlongRatio = overlong / sentences.length
    }
  }

  // 形容词堆叠去重命中数
  let adjStackHits = 0
  if (rules.maxAdjStack && rules.maxAdjStack > 0) {
    const stackRe = adjStackRegex(rules.maxAdjStack)
    const hits = body.match(stackRe)
    if (hits) adjStackHits = new Set(hits).size
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
    const tagRe = new RegExp(`[${HANZI}]{1,8}(说|道|问|喊|叫|答|叹|笑)(了|着)?`, 'u')
    const tagged = dialogueLines.filter((line) => tagRe.test(stripQuotedSpans(line))).length
    dialogueTagRatio = tagged / dialogueLines.length
  }

  // 最大同构排比连续数（补全统计，不同于 checkStyleMetrics 的”首次越界即 break”）
  let parallelStreakMax = 0
  if (rules.maxParallelStreak !== undefined && rules.maxParallelStreak > 0) {
    let prev = ''
    let streak = 0
    for (const sentence of sentencesWithColon) {
      const prefix = sentence.match(new RegExp(`^[${HANZI}]{2}`, 'u'))?.[0] ?? ''
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
      if (s.length > rules.maxSentenceLen) {
        items.push({
          checkId: 'style-sentence-overlong',
          level: 'yellow',
          message: `单句 ${s.length} 字超文风铁律上限 ${rules.maxSentenceLen} 字：「${s.slice(0, 16)}…」`,
        })
      }
    }
  }

  // 形容词连续堆叠：去重后逐个推（保持原行为）
  if (rules.maxAdjStack && rules.maxAdjStack > 0) {
    const stackRe = adjStackRegex(rules.maxAdjStack)
    const hits = body.match(stackRe)
    if (hits) {
      for (const h of new Set(hits)) {
        items.push({
          checkId: 'style-adj-stack',
          level: 'yellow',
          message: `形容词堆叠超上限（${rules.maxAdjStack}）：「${h}」`,
        })
      }
    }
  }

  // 对话提示语堆叠（"…地说/地道"，优先"他说"，#5 第 8 节示例）
  const tagHits = body.match(new RegExp(`[${HANZI}]{2,}地(说|道)`, 'gu'))
  if (tagHits) {
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

  // 连续同构排比：首次越界即推一条 + break（保持原行为；max 留在 stats 供聚合用）
  if (rules.maxParallelStreak !== undefined && rules.maxParallelStreak > 0 && stats.parallelStreakMax > rules.maxParallelStreak) {
    // 复算首个越界 prefix（复用 stats 已分句结果）
    const sentences = stats._sentencesWithColon ?? splitSentences(body, true)
    let prev = ''
    let streak = 0
    let hitPrefix = ''
    for (const sentence of sentences) {
      const prefix = sentence.match(new RegExp(`^[${HANZI}]{2}`, 'u'))?.[0] ?? ''
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

function summaryEndingRegex(): RegExp {
  return /(这一刻|那一刻|这一战|此役|从此|直到很久以后|多年以后|命运|人生|终于明白|原来).*(明白|懂得|领悟|真谛|道理|命运|人生|结束|开始|答案)/
}

/**
 * 信息差泄密候选（#10 项 11，🟡 黄）。
 * 关键词命中 → 只出候选、不拦截（真伪归阶段 6 三审，PRD 问题 3）。
 * 关键词源默认空——由信息差设定 / book.yaml 提供（#10 第 2 节项 11）。
 */
export function checkInfoLeak(
  body: string,
  leakKeywords: string[] = [],
): CheckSectionResult {
  const items: CheckItem[] = []
  if (leakKeywords.length === 0) {
    // X-P2-22：同高频意象——关键词源未配置静默跳过，不再产恒久黄项
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
 * 比喻泛滥计数：以「像」开头的比喻句超阈报黄。
 */
export function checkSimile(
  body: string,
  threshold = 10,
): CheckSectionResult {
  const items: CheckItem[] = []
  // 统计「像」字出现次数（粗计；精确判定比喻句需语义，零 token 取近似）
  let count = 0
  let idx = body.indexOf('像')
  while (idx !== -1) {
    count++
    idx = body.indexOf('像', idx + 1)
  }
  if (count > threshold) {
    items.push({
      checkId: 'simile-density',
      level: 'yellow',
      message: `「像」出现 ${count} 次超阈值（≤${threshold}），比喻泛滥疑似 AI 味`,
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
  const items: CheckItem[] = []
  // 有 ## 标题才按标题计五段；无标题时不把自然段空行误判为“节”。
  // 用 match 数标题行（split 会把首个 ## 之前的前导内容多计一节）
  const headings = body.match(/^##\s.+$/gm) ?? []
  let sections: number
  if (headings.length >= 2) {
    // 有 ## 标题：按标题数
    sections = headings.length
  } else {
    items.push({
      checkId: 'section-count-heading-missing',
      level: 'yellow',
      message: `正文未使用 ## 标注五段结构；建议写成 ## 开头钩子 / ## 铺垫 / ## 升级 / ## 反转 / ## 余韵，本项不按自然段计节。`,
    })
    return { name: '节数守恒', items }
  }
  if (sections !== expected) {
    items.push({
      checkId: 'section-count',
      level: 'yellow',
      message: `正文 ${sections} 节，五段结构期望 ${expected} 节（节数守恒）`,
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
  const opening = body.slice(0, openingChars)
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
