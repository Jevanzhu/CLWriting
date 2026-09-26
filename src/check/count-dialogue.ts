/**
 * 对话/名册/禁词/字数/句式/复读检查族 —— 自 src/check/count.ts 缝 A 拆出。
 *
 * （⑤④产品巨件拆分波1）：count.ts（1144 行）纯移动拆分——
 * 本文件承载缝 A（ATTRIBUTION/SPEECH/DIALOGUE_GUIDE/ROSTER 诸正则族、名册
 * 缓存与判重、禁词/字数/句长/复读）；文风可量化族见 count-style.ts（缝 B）；
 * front matter/意象/短篇专属项留 count.ts 残核，其头注保留原全部历史记载与拆分沿革。
 * 依赖方向：check（types/quotes 同层）/format（sentences）/shared/log 既有方向，
 * 不入 AI 生成层（守护范围）。
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import type { CheckSectionResult, CheckItem } from './types.js'
import { splitSentences, ngramRepeatRate } from '../format/sentences.js'
import { QUOTED_SPAN_RE, stripQuotedSpans, QUOTE_OPEN, QUOTE_CLOSE, SPAN_PUNCT } from './quotes.js'
// 句长码点口径（代理对合 1 计）。
// -优化：实现收编 src/shared/text.ts 单源（原本地副本删）。
import { codePointLength } from '../shared/text.js'
// -：unknown → message 三目收编 log.errMsg 单源（同批 run.ts 同款）
import { errMsg, log } from '../log/index.js'

/**
 * 汉字字符范围（基本区 + 扩展 A 区）。
 * 统一使用，避免不同检查项范围不一导致生僻字人名漏判。
 * 注释修正：「一-鿿」中 一=U+4E00、鿿=U+9FFF（基本区顶，非 U+9FA5——
 * U+9FA5 是「龥」，U+9FFD~U+9FFF 是 CJK 扩充进基本区顶的字，旧注释把区顶码位
 * 写错一位）；「㐀-䶿」= U+3400-U+4DBF（扩展 A 区）。导出：
 * api/check.ts 堆砌锚点正则收编本单源（此前第四处硬编码）。
 */
export const HANZI = '一-鿿㐀-䶿'

// （拆分批）：本常量跨缝共享（本文件 HANZI_CHAR_RE/
// SPEECH_ATTRIBUTION_RE/ROSTER_NAME_RE 与 count-style.ts 的 adjStack/排比/领属链
// 正则族均消费）。「留 count.ts 残核供两缝 import」备选经 ESM 环形依赖推演不可行
// （count.ts 的 re-export import 提升先于残核常量初始化，两新文件顶层 RegExp
// 构造即踩 TDZ），故随缝 A 落此单源、count-style.ts 直接 import、对外仍经
// count.ts re-export 桥接（消费面零改动），单源不重复。

/** ②：汉字单字符判定（复用 HANZI 区间单源），边界检测用。 */
const HANZI_CHAR_RE = new RegExp(`[${HANZI}]`)

/**
 * ②：≥2 字禁词的边界命中——命中位置的「前后都必须是非汉字」
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
 * 三处收紧：
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
    // （六轮修复批）：单字判定由 UTF-16 长度改
    // codePointLength——增补平面字（如 𠮷）在 UTF-16 下 length===2 被当多字词走红项
    // 边界命中分支，而「单字误报面大降黄」的取舍本意按**字符数**而非码元数成立。
    // 消费面同时经 isMdFileName 同源口径；hasBoundedHit 的索引步进是码元级（不改），
    // 增补平面词在其中的降黄/红项分诊按本行字符数判定，两处量纲各自正确。
    if (codePointLength(word) === 1) {
      // ③：单字禁词降黄（不再驱动打回）
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
 * 滑窗句级 n-gram 重复率（实装：此前实现是整句哈希，与注释宣称的 n-gram 不符，
 * 重复句改一两个字就抓不住）。算法：对每个句子取字符级滑窗 n-gram，统计
 * 「重复 n-gram 实例数 / 总 n-gram 数」为复读率——重复句改个别字仍有大量相同
 * n-gram 被计数；阈值经测试校准，保持不误报正常文本。
 */
const REPEAT_N_GRAM = 8

/** 绝对重复字符量阈值（双口径的第二口径）。
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
  // （评审修复批）：repeat_chars_threshold 是正整数语义
  // （绝对重复字数口径）——yaml 解析层只验 >0（口径），手写 0.5 直穿后
  // repeatChars > 0.5 近乎恒真 = 绝对字数口径形同恒报黄，违反「配置不生效必留痕」
  // 纪律。镜像姊妹键 repeat_threshold 的消费点夹紧先例：非正整数（含小数
  // /≤0，NaN 同判）warn 留痕 + 回落默认值，不静默改口径；在本消费点夹紧可同护
  // learn 侧 scoreByChecks 等其余调用方。
  let charThreshold = repeatCharThreshold
  if (!Number.isInteger(charThreshold) || charThreshold <= 0) {
    log.warn('check', `checks.repeat_chars_threshold ${charThreshold} 非正整数（绝对重复字数阈值口径），已回落默认值 ${REPEAT_CHARS_THRESHOLD}`)
    charThreshold = REPEAT_CHARS_THRESHOLD
  }
  // 滑窗口径收口到 format/sentences.ngramRepeatRate（与文风重扫共用）
  const { rate, total, repeatInstances, repeatChars } = ngramRepeatRate(body, REPEAT_N_GRAM)
  if (total > 0) {
    // 双口径——比率超阈（章长无关的密度语义）或绝对重复字符量超阈
    // （防大章稀释漏报）任一命中即报，message 注明触发口径
    if (rate > threshold) {
      items.push({
        checkId: 'repeat',
        level: 'yellow',
        message: `复读率 ${(rate * 100).toFixed(1)}% 超阈值 ${threshold * 100}%（重复 ${repeatInstances} 处）`,
      })
    } else if (repeatChars > charThreshold) {
      items.push({
        checkId: 'repeat',
        level: 'yellow',
        message: `重复字符量 ${repeatChars} 字超绝对阈值 ${charThreshold} 字（复读率 ${(rate * 100).toFixed(1)}% 未超，大章集中复读）`,
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
  // （评审修复批）：分号句读口径注记——splitSentences 全库
  // 单源默认不按「；」切（includeColon 供对话/排比场景显式开启，format/sentences.ts），
  // 分号串联的长串在此计为单句：分号确有句读功能，超长句占比可因此虚高。定性：
  // 误报向、advisory（黄项不驱动红闸，只提示不计闸）；维持不切的取舍是分句单源口径
  // 为复读/文风统计面共用，单独为本检改切会连带全库统计口径，如需分号细分应走
  // includeColon 专属口径另立项。
  // 句长统一码点口径（与 countWords 一致）——UTF-16 .length 对
  // astral 字符（emoji/生僻扩展区）一符计 2，句长虚高。codePointLength 见顶部 import。
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
 * 提示语成分字符表（对白行判定）：引号外文本全部由这些成分组成 → 该行是对白，
 * 引号内是对白内容。启发式词表，覆盖代词/说话动词/常见修饰与数量成分；
 * 叙述动词（看/走/举…）不在表内，叙述行不会被误判为对白。
 */
const ATTRIBUTION_CHARS = '他她它我你您们的地得了着说问道喊叫答叹笑骂吼喝斥言语音低轻冷沉淡急缓一三四五六七八九十百两声句又再便就都连只才正竟自'
// -：以下守卫族导出——setting-rule.ts 的「只读参照」
// 抄本纪律已被两次证明失效（抄定后只修 check 侧未同步 ai 域，即
// 现行实例），自本批起 ai 域删抄本改直接 import（ai→check 单向，quotes.ts/self-heal 先例）。
export const ATTRIBUTION_RE = new RegExp(`^[${ATTRIBUTION_CHARS}]+$`)

/** 引号外只剩提示语（或为空）→ 对白行。 */
function isAttributionOnly(outside: string): boolean {
  return outside === '' || ATTRIBUTION_RE.test(outside)
}

/** 说话动词集单源——SPEECH_ATTRIBUTION_RE（对白归属行豁免）与
 *  DIALOGUE_TAG_RE（对话标签占比分子）共用同一动词集。此前 DIALOGUE_TAG_RE 只有
 *  说/道/问/喊/叫/答/叹/笑 8 个，窄于归属行豁免的 21 个（骂/吼/喝/斥/呼/唤/念/回/
 *  应/嘀咕/嘟囔/喃喃/低语 不计标签）→ 标签占比分子系统性偏低（漏检向黄）。对齐后
 *  「“闭嘴！”他骂道。」这类行照常计入占比。
 *  已知登记不动：「他喊了一声，」的「了」后接数词「一」不满足双侧边界锚定
 *  （lookahead 要求动词/尾缀后紧跟标点或行尾）→ 该形态不计标签；修锚定易引入构词
 *  语素回潮（反例），本期只对齐动词集。
 *  （拆分批）：导出——DIALOGUE_TAG_RE 随其唯一消费方
 *  computeStyleMetrics 落 count-style.ts（缝 B），本动词集跨缝仍收单源（
 *  口径不破，同 HANZI 处理，见上方块注）。 */
export const SPEECH_VERBS = '说|道|问|喊|叫|答|叹|笑|骂|吼|喝|斥|呼|唤|念|回|应|嘀咕|嘟囔|喃喃|低语'

/** 对白归属行结构——1-4 汉字（人名/称谓）+ 说话动词 + 可选尾缀（了/着/道）。
 *  说话人名词不在提示语词表（只挡代词行），「快走。」林晚说。这类
 *  网文最高频对白行式按结构匹配豁免，否则引号内对白被当专名每章批量误报。
 *  ：汉字段改 ${HANZI} 插值（与全文件口径同源）——此前字面 \u4e00-\u9fa5
 *  漏基本区顶与扩展 A 区，生僻字人名的归属行不匹配、对白被当专名误报。
 *  ：动词段收 SPEECH_VERBS 单源（动词集语义不变，见上）。
 *  -：导出（setting-rule 抄本收编，见 ATTRIBUTION_RE 处注）。 */
export const SPEECH_ATTRIBUTION_RE =
  new RegExp(`^[${HANZI}]{1,4}(?:${SPEECH_VERBS})(?:了|着|道)?$`)

/**
 * 对白引导词收尾判定（checkNewNames 混排行守卫专用，刻意不复用
 * SPEECH_VERBS 全集）——span 开引号紧前（允许隔一个冒号/逗号）以这些说话动词收尾 =
 * 该 span 是「引导词 + 引语」的对白引用而非专名提及。单字集从 SPEECH_VERBS 剔除
 * 叫/回/应/念/叹/笑/斥/呼/唤/低语 等构词语素高发字（「名叫『萧策』」的「叫」会把
 * 真候选杀掉），双字词（吩咐/嘀咕/嘟囔/喃喃/低语）按 2 字符窗口整词收尾才认。
 * 已知残余面（漏报向安全，黄项启发式不追全）：「频道/知道/频道」等以「道」收尾的
 * 普通词紧邻引号时同样豁免——与同款取舍。
 * -：导出（setting-rule 抄本收编，见 ATTRIBUTION_RE 处注）。
 */
export const DIALOGUE_GUIDE_RE = /(?:说|道|问|骂|喊|答|吼|喝|吩咐|嘀咕|嘟囔|喃喃|低语)[：:，,]?\s*$/

/** 纯汉字名判定（名册侧名字过滤用，区间与候选抽取同源 HANZI）。
 *  （修复批）：补 CJK 增补平面区段（SIP 扩展 B–I + 兼容
 *  补充 U+20000-U+2FA1F、TIP 扩展 G/H U+30000-U+323AF）+ u 标志——HANZI 仅 BMP
 *  （基本区+扩展 A），Ext-B/C 生僻字姓名（如 𪀀）在名册侧恒被盲拒 → 已登记判重
 *  永不命中（真名伪报新专名候选）。u 标志使字符类内 astral 字面按码点计（不碎成
 *  代理对半区）；刻意不动 HANZI 常量本体——它被无 u 标志正则（HANZI_CHAR_RE/
 *  SPEECH_ATTRIBUTION_RE 等）消费，掺入 astral 区段会碎成代理对半区破坏语义。
 *  - /：导出——setting-rule 抄本（PURE_HANZI_RE，BMP-only）
 *  未随本处补增补平面同步，Ext-B 名两检两结论（主诉）；自本批起
 *  ai 域直接 import 本单源，抄本删除。 */
export const ROSTER_NAME_RE = new RegExp(`^[${HANZI}\u{20000}-\u{2FA1F}\u{30000}-\u{323AF}]{2,4}$`, 'u')

/**
 * 名册解析结果的 (mtimeNs,size) 指纹缓存——runAllChecks 每章调
 * checkNewNames，此前每章 readFileSync 整读名册 + 逐行正则解析（大书名册数百名 ×
 * 数百章的重复同步 IO）；指纹命中只付 1 次 statSync（ironRulesFp 同款范式，精度
 * mtimeNs 无陈旧窗口）。键按 rosterPath（含 bookRoot 绝对路径），FIFO 上限对齐
 * 章节元数据缓存 32 书纪律。
 */
const ROSTER_CACHE_MAX = 32
const rosterNamesCache = new Map<string, { mtimeNs: bigint; size: bigint; names: string[] }>()

/**
 * 名册文本 → 已登记名字数组（checkNewNames 精确判重专用）。
 *
 * 单源指向：grep src/check/ 无现成名册解析器（checkNewNames 此前直接对名册**全文**
 * 做 includes 粗匹配；src/ai/rules/setting-rule.ts 的名册面当年同为全文粗匹配口径），
 * 故按名册格式（行/顿号分隔，兼容 `已登记：A、B`、`- 已登记：A、B`、`### A` 等仓内
 * 既有形态）在本文件局部实现本解析，作为 check 域名册判重单源（
 * 起 setting-rule 名册面按「只读参照」抄定本解析为 parseRosterNamesLocal，双域同
 * 口径，对白守卫族同步对齐；-：抄本纪律失效，setting-rule 改
 * 直接 import 本函数——见 ATTRIBUTION_RE 处注）。
 *
 * 逐行剥 ATX 标题/列表前缀/括注（「云澈（主角）」→「云澈」），再按顿号/逗号/分号/
 * 冒号/斜杠/空白劈分；只收 2-4 字纯汉字 token（与候选抽取窗一致，说明性词汇
 * 「身份/动机」等字段名即便混入也只是多登记而无害——精确全等比对不会吞掉他名）。
 */
export function parseRosterNames(roster: string): string[] {
  const names: string[] = []
  for (const rawLine of roster.split(/\r?\n/)) {
    const cleaned = rawLine
      // `[ \t]*` 收窄（原 `\s*`）——`\s` 含换行/全角空格，本处虽逐行处理
      // 无吞行风险，但「行内空白」语义与 :935 标题计数正则统一收窄，防后续复用踩坑
      .replace(/^#{1,6}[ \t]*/, '') // ATX 标题
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
 * 判重口径由「名册全文 includes」改为「已登记名字集合精确全等」
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
  // existsSync→readFileSync 间隙名册被瞬删（TOCTOU）时 ENOENT 直穿
  // 炸整次机检——照（runner.ts readPieceList）同款降级：黄项提示本轮未跑，不静默消失。
  // 解析结果走指纹缓存——命中只付 1 次 statSync，未变名册不再
  // 每章整读+整解析（stat/读失败仍走原黄项降级路径，降级值不缓存）
  let registeredNames: string[]
  try {
    const st = statSync(rosterPath, { bigint: true })
    const hit = rosterNamesCache.get(rosterPath)
    if (hit && hit.mtimeNs === st.mtimeNs && hit.size === st.size) {
      registeredNames = hit.names
    } else {
      registeredNames = parseRosterNames(readFileSync(rosterPath, 'utf-8'))
      if (rosterNamesCache.size >= ROSTER_CACHE_MAX) {
        const oldest = rosterNamesCache.keys().next().value
        if (oldest !== undefined) rosterNamesCache.delete(oldest)
      }
      rosterNamesCache.set(rosterPath, { mtimeNs: st.mtimeNs, size: st.size, names: registeredNames })
    }
  } catch (e) {
    return {
      name: '新专名候选',
      items: [
        {
          checkId: 'roster-unreadable',
          level: 'yellow',
          message: `名册读取失败（${errMsg(e)}），新专名检查本轮未跑，修复后重查。`,
        },
      ],
    }
  }
  // （修复批）：名册 Set 化（构建一次，判重循环内 O 查）
  const registeredSet = new Set(registeredNames)
  // 粗抽：2-4 字中文专名候选——候选仅出自引号 span（QUOTED_SPAN_RE 命中段；
  // 注释如实化：叙述行裸名不入候选，扩裸名会引入高误报面，超出本轮）
  const candidates = new Set<string>()
  const spanRe = new RegExp(QUOTED_SPAN_RE.source, 'g')
  const punctRe = new RegExp(`[${QUOTE_OPEN}${QUOTE_CLOSE}${SPAN_PUNCT}「」『』]`, 'gu')
  // 句读命中判定外提——此前每个候选名 new RegExp 一次（一章数十候选×
  // 每章重跑，纯浪费；字符类内容循环内不变）
  const spanPunctRe = new RegExp(`[${SPAN_PUNCT}]`)
  // span 内部开引号探测（嵌套截断守卫，见下方循环内注释）
  const innerOpenRe = new RegExp(`[${QUOTE_OPEN}]`)
  for (const rawLine of body.split(/\n+/)) {
    const line = rawLine.trim()
    // match→matchAll——守卫需要 span 在行内的位置（取开引号
    // 紧前文本判引导词），裸字符串数组拿不到 index
    const spans = [...line.matchAll(spanRe)]
    if (spans.length === 0) continue
    // 「动词+冒号+引语」结构豁免——引导动词词表（挥手/点头/摆手…）
    // 永远追不全，词表外动词 + 冒号引出的对白（「他挥挥手：『住手。』」）此前整行按
    // 叙述行处理，引号内 2 字对白被当专名误报。引号外文本以冒号收尾 = 「X：『引语』」
    // 的引语引入结构，引号内是对白/引文而非专名（黄项候选漏报向安全：冒号后真提及
    // 的专名本就多在引语里，同 /的豁免口径）。
    if (/[:：]$/.test(line.replace(spanRe, '').replace(/[\s\u3000]/g, ''))) continue
    // 引号外只剩提示语成分（代词/说话动词/语气副词等）→ 整行是对白，
    // 引号片段是对白内容而非专名（此前「住手！」「快走」全报黄项刷屏）
    const outside = line.replace(spanRe, '').replace(/[\s\u3000]/g, '').replace(punctRe, '')
    if (isAttributionOnly(outside)) continue
    // 人名 + 说话动词的对白归属行同样豁免
    if (SPEECH_ATTRIBUTION_RE.test(outside)) continue
    for (const span of spans) {
      const q = span[0]
      // 嵌套引号截断守卫——QUOTED_SPAN_RE 跨体系配对但不感知嵌套，
      // 嵌套对白「他说『快走』了」被截成 span「他说『快走，剥引号后「他说快走」恰落
      // 2-4 字窗报伪专名黄项；span 内部还有开引号 = 截断产物（对白内容非专名），跳过
      // （漏报向安全：真嵌套提及的专名本就多在对白内容里，黄项启发式不追全）
      if (innerOpenRe.test(q.slice(1))) continue
      // （二十四轮 B 域）：句读守卫改在剥句读前的原文上判——punctRe 含全部句读
      // 且下方 name 已被它剥净，原 `spanPunctRe.test(name)` 恒 false 成死守卫，注释宣称
      // 的「含句读的片段是对白内容」失效；三条整行豁免只覆盖「整行是对白」形态，
      // 动作+对白混排行（网文最高频行式，如「他低声道：『别动。』然后按住她的肩。」）
      // 全部穿透成伪专名黄项刷屏。改判剥两端引号后的原文：含句读 = 对白内容非专名，
      // 跳过（漏报向安全：真提及的专名带句读本就在引语里）。
      if (spanPunctRe.test(q.slice(1, -1))) continue
      // 混排行残余面——动作+无句读短引语（「林晚喊道『站住』，
      // 追了出去。」）不落句读守卫也不落整行豁免，span 被当 2 字伪专名报黄。
      // span 开引号紧前（隔一个冒号/逗号算紧邻）以对白引导词收尾 → 判为对白引用跳过；
      // 引导词不在紧邻窗口（如「他说了很多，『诚实』才是关键」）或引导词词表外
      // （「名叫『萧策』」）仍照报，真候选不误伤（词表收窄理由见 DIALOGUE_GUIDE_RE 注释）
      if (DIALOGUE_GUIDE_RE.test(line.slice(0, span.index ?? 0).trimEnd())) continue
      const name = q.replace(punctRe, '')
      // （修复批）：长度窗按码点计（codePointLength 单源
      // 在本文件，代理对合 1 计，勿新写）——UTF-16 .length 对 astral 字一符
      // 计 2，含 Ext-B 字的姓名被窗误拒（「𪀀𪀀𪀀」3 码点计 6 > 4 静默跳过）。
      const nameLen = codePointLength(name)
      if (nameLen < 2 || nameLen > 4) continue
      // 精确全等判重（见 parseRosterNames/函数头注）——
      // 原 roster.includes(name) 是名册全文子串判定，长名吞短名致独立新角色漏报
      // （修复批）：判重集合化——原
      // registeredNames.includes 对名册数组逐名线性扫（数百名 × 每章数十候选，
      // 每章 O(名册×候选) 白付），构建一次 Set 后 O(1) 查，判定语义不变。
      if (!registeredSet.has(name)) candidates.add(name)
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
