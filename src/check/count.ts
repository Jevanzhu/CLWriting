/**
 * 可计数项 + 文风可量化 —— 依据 #10 第 2 节项 3-11。
 *
 * 红（#10 项 3-4）：front matter 格式、禁词
 * 黄（#10 项 5-11）：字数/复读/意象/句式/文风可量化/专名/信息差候选
 *
 * 全部零 token 脚本判定。
 *
 * （⑤④产品巨件拆分波1）：本单件（1144 行）纯移动拆分——
 * 对话/名册/禁词/字数/句式/复读族 → count-dialogue.ts（缝 A）；文风可量化/信息差族
 * → count-style.ts（缝 B，DIALOGUE_TAG_RE/对话提示语堆叠正则随其唯一消费方
 * computeStyleMetrics/checkStyleMetrics 落 B）。本文件保留 front matter/高频意象/
 * 短篇专属项（checkFrontMatter/checkImagery/checkPieceWordCount/checkBodyParts/
 * checkSimile/checkSectionCount/checkOpeningNoEnv），并对全部迁出导出**逐名
 * re-export 桥接**——消费方（check/runner、learn、metrics、ai/rules/setting-rule、
 * studio/server/api、scripts/harvest-corpus 与 test/*）import 面零改动。两新文件
 * 头注各记拆分归属与跨缝单源（HANZI/SPEECH_VERBS）处理；本头注上方原文全部
 * 历史记载原样保留。
 */

import type { CheckSectionResult, CheckItem } from './types.js'
import type { ChapterMeta } from '../format/types.js'
import { validateEnums } from '../format/chapters.js'
// （修复批）：章号前缀解析单源（fm-chapter-mismatch 收编，见 checkFrontMatter）
import { chapterNoFromName } from '../format/filename.js'
// G203（0918三轮修复批）：`##` 段落标题识别单源（剥围栏 + 标题行正则整体收编
// format/section-heading——此前本处与 metrics/collectBodyAnchors 两套识别器口径分裂；
// 围栏行识别原经 format/fence 的 matchFenceLine，随段整体收编后本文件不再直用）
import { extractSectionHeadings } from '../format/section-heading.js'
import { stripQuotedSpans } from './quotes.js'

// 拆分桥接：迁出导出逐名 re-export，全库 import 面零改动。
// 缝 A（count-dialogue.ts）：HANZI 跨缝单源落 A（含 count-style.ts 正则族消费，
// 「留本残核」经 ESM 环形依赖推演不可行，见 count-style.ts 头注）。
export {
  HANZI,
  ATTRIBUTION_RE,
  SPEECH_ATTRIBUTION_RE,
  DIALOGUE_GUIDE_RE,
  ROSTER_NAME_RE,
  parseRosterNames,
  checkNewNames,
  checkBannedWords,
  checkWordCount,
  checkRepeat,
  checkSentenceLength,
} from './count-dialogue.js'
// 缝 B（count-style.ts）
export { DIALOGUE_TAG_RE, computeStyleMetrics, checkStyleMetrics, checkInfoLeak } from './count-style.js'
export type { StyleStats } from './count-style.js'

/**
 * front matter 格式检查（#10 项 3，🔴 红）。
 * 章号==文件名、枚举合法、必填齐。
 */
export function checkFrontMatter(chapter: ChapterMeta, fileName: string): CheckSectionResult {
  const items: CheckItem[] = []

  // 章号 == 文件名前缀（非数字文件名如 前言.md 不报红——与短篇版 checkPieceFrontMatter 对齐）
  // 路径形态容忍（win 反斜杠直传前缀不失明；现调用方传 basename
  // 不触发，纯加固）——basename 化后再交单源解析。
  // （修复批）：前缀解析收编 format/filename.ts
  // chapterNoFromName 单源——此前自带窄正则只认 `-` 分隔，`6—标题.md`（tree 排序/
  // 线索核验同宽容集形态）在此解析不出前缀 → fm-chapter-mismatch 对真不一致静默
  // 失明。只统一「解析」一步：null（无数字前缀）= 不报（既有豁免语义不变），解析
  // 出章号才判 mismatch，本处判断逻辑零改动。
  const fileNum = chapterNoFromName(fileName.split(/[/\\]/).pop() ?? fileName)
  if (fileNum !== null && fileNum !== chapter.章号) {
    items.push({
      checkId: 'fm-chapter-mismatch',
      level: 'red',
      message: `章号「${chapter.章号}」与文件名「${fileName}」前缀不一致`,
      chapter: chapter.章号,
    })
  }

  // 必填枚举缺失（钩子类型/钩子强弱/情绪定位）此前在 readChapter
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

/**
 * 子串非重叠计数单源——checkImagery / checkBodyParts
 * 两处逐字同构的 indexOf 步进循环收编（步进 needle.length = 不计重叠命中，口径与
 * 原实现逐位一致）。grep 佐证该形态全仓仅此两处，落文件内 helper 不入 shared/text.ts
 * ——单消费域不下沉（避免推测性泛化），第三处出现时再议上移。
 * （拆分批）：两消费方（checkImagery/checkBodyParts）均留本
 * 残核，helper 随留，不迁不导出。
 */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

/**
 * 高频意象检查（#10 项 7，🟡 黄）。
 * 套路词/意象表命中频次超阈 → 提示（PRD 问题 9，"空气仿佛凝固"）。
 * 词表三级供给（数据源接线后由 runner 解析，本函数只吃现成表）：入参显式 >
 * book.yaml checks.imagery_words > 内置种子表（imagery-seed.ts）；书级/入参写了
 * 词表即整体替换（不合并），显式空数组 = 彻底关。入参 readonly——runner 直收
 * 种子表的 readonly 字面量，免调用方拷贝。
 */
export function checkImagery(body: string, imageryWords: readonly string[] = [], threshold = 3): CheckSectionResult {
  const items: CheckItem[] = []
  if (imageryWords.length === 0) {
    // 空表（未启用或显式关）静默跳过——恒久「未启用」黄项只会训练作者
    // 无视机检面板；数据源接线后空表只剩「作者明确关掉」一种来源，仍不产黄
    return { name: '高频意象', items }
  }
  // 计数前剥对白引号 span——禁词（checkBannedWords ①）/
  // 开头（1045）同文件均剥，唯本检查吃原文：意象词多为叙述套语，对白里角色说
  // 「气氛」「空气」属人物语言非作者叙述套路，对白密集章逐句累加黄项刷屏。
  // stripQuotedSpans 单源（quotes.ts）对齐。
  const prose = stripQuotedSpans(body)
  for (const word of imageryWords) {
    if (!word) continue
    // 计数循环收编 countOccurrences 单源（原与 checkBodyParts 双份逐字同构）
    const count = countOccurrences(prose, word)
    // 阈值边界统一为 `>`（超过才报）——与 checkBodyParts/checkSimile
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

// ── 短篇专属机检项（#27 第 5.3 节，新增）──────────
//
// 短篇目标函数是单章情绪爆破，4 项专属软约束（吸收点 7.1）：
// 身体部位词 ≤5 / 「像」≤10 / 节数守恒=5 / 开头零环境。
// 全部零 token 脚本判定，黄项只报不拦（ask 不 deny）。

/** 短篇字数阈值（#27 第 5.2 节，🟡 黄）。
 *  总字数 8000–20000（工单第 0 节）；阈值待 beta 校准，本期定方向。 */
export function checkPieceWordCount(actualWords: number, min = 8000, max = 20000): CheckSectionResult {
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
const DEFAULT_BODY_PARTS = [
  '眼睛',
  '眼神',
  '眼眶',
  '手指',
  '手掌',
  '心脏',
  '心跳',
  '脸庞',
  '嘴角',
  '眉头',
  '喉咙',
  '呼吸',
]

/**
 * 「手」的动作语境模式 —— 单字「手」直接 indexOf 会误伤「对手/高手/随手/手段」等非部位词，
 * 只统计带动作前/后缀的肢体动作（伸手、握住手等），剔除隐喻与惯用语。
 */
const HAND_ACTION_RE = /(?:伸|握|抓|拉|抬|挥|摊|攥|搓|叉|捂|托|撑|扶|搭|拽|按|放|松|紧|握住|抓住)了?手/g

/**
 * 身体部位词检查（#27 第 5.3 节，🟡 黄）。
 * 正文洁净：眼/心脏等堆砌计数超阈报黄（AI 味高发）。
 * 单字「手」单独走 HAND_ACTION_RE 动作语境匹配，避免「对手/高手/随手」误报。
 * （修复批）：计数前剥对白引号 span（对白是角色嘴里的话非作者
 * 叙述，见函数体内注释——同批 checkSimile 对齐）。
 */
export function checkBodyParts(body: string, threshold = 5, words: string[] = DEFAULT_BODY_PARTS): CheckSectionResult {
  const items: CheckItem[] = []
  const over: string[] = []
  // （修复批；win 线同题锚 ④）：计数前剥对白引号 span
  // （quotes.ts 单源 stripQuotedSpans）——同文件禁词（checkBannedWords ①）/
  // 意象（checkImagery ）/开头环境（checkOpeningNoEnv ）均经剥引号
  // 统计，唯本检查与 checkSimile 吃原文：对白里角色说「我的眼睛…」是人物语言非
  // 作者叙述堆砌，对白密集章逐次累加黄项刷屏；本项属短篇 strict 升红族（runner.ts
  // STRICT_SHORT_CHECK_IDS 的 body-parts），误报驱动打回重写白烧真调用。单字「手」
  // 的动作语境匹配路径同口径。阈值与升红逻辑零改动，只收窄「哪些文本参与计数」。
  // 对齐家族约定（注释自证「同族均剥」），prose 变量口径同 checkBannedWords。
  const prose = stripQuotedSpans(body)
  for (const word of words) {
    if (!word) continue
    // 计数循环收编 countOccurrences 单源（原与 checkImagery 双份逐字同构）
    const count = countOccurrences(prose, word)
    if (count > threshold) over.push(`${word}×${count}`)
  }
  // 单字「手」走动作语境匹配，避免误伤惯用语（/ ④：同在剥对白后的叙述面上计数）
  const handCount = (prose.match(HAND_ACTION_RE) ?? []).length
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
 * 此前把所有「像」字都计入比喻统计（含「相像/很像/好像/不像/像他这样的人」
 * 等非比喻），误报偏高——现按句式约束：像 + 名词性短语（可带「一样/似的/般」尾缀），
 * 排除非比喻「像」字用法；「像刀/像雪」等短比与「像X一样」长比都计。
 */
// （十五轮登记销账）：前置排除改零宽 lookbehind——原消费型 (?:^|[^相很好不像]) 会
// 吞掉「像」前一个字符，相邻明喻（如「像刀像雪」）第二个「像」因前字符已被上一命中
// 消费而漏计（漏报不误报）；lookbehind 语义等价（行首无边=通过、前排他字符=拒绝）。
// 登记口径：前排他集含「好」是排除高频非比喻「好像」的必要代价——
// 「恰好像刀」「正好像雪」等真·明喻被一并漏计；本检查为超阈黄项密度统计，漏报向
// 安全（不误报），且「恰好/正好」+明喻连用占比极低，零 token 边界不做分词级判别。
// 前排他集再纳入「X像」名词首字（图像/偶像/摄像/录像/影像/
// 照像/画像/音像/映像/实像/虚像/镜像/显像/成像/雕像/塑像/石像/铜像/铁像/玉像/蜡像/
// 金像/肖像/绣像/头像/佛像/神像/遗像/铸像/拟像/造像/圣像/群像/形象/印像/想像）——此前
// 词内「像」未排除名词，「他用图像处理软件处理图像数据。」实测命中 2 次、「摄像头
// 对准了门口」「她是全民偶像明星」各命中 1；短篇 strict 模式下 simile-density 升红
// 会把无一流比的名物章打回重写烧调用。代价（同登记式取舍）：「拳头像铁锤」
// 「石头像刀一样硬」等「X头像/X石像」明喻被一并漏计（漏报向安全）；「人像蝼蚁」
// 类人字领明喻不排（人像的肖像义在散文里远低于明喻用法）。后排他集补「样」——
// 「挺像样」「很像样」的「像样」非比喻。
// （修复批）：注释补齐实现口径——下方正则前排他集实含「群」
// （「群像」），上列词表此前漏列，照注释读会误判正则多收一字。
// 导出：语料收割（scripts/harvest-corpus.ts）对 simile-density
// 复用本正则直扫正文取真实比喻短语作幸存者判定锚——message 只报次数（「像…」是
// 模板字面量），文案解析提不出锚。单一真相源，防两处正则漂移。
export const SIMILE_RE =
  /(?<![相很好不像图偶摄入影照实音画映形印想虚镜显成雕塑石铜铁玉蜡金肖绣头佛神遗铸拟造圣群])(像)(?!他|她|你|我|这|那|样)[^，。！？；、：\s像]{1,12}(?:一样|似的|一般|般)?/gu

export function checkSimile(body: string, threshold = 10): CheckSectionResult {
  const items: CheckItem[] = []
  // （修复批；win 线同题锚 ④）：统计前剥对白引号 span
  // （禁词/意象/开头/身体部位同款口径，quotes.ts 单源 stripQuotedSpans）——对白里
  // 角色说「像…一样」是人物语言，非作者叙述比喻堆砌；对白密集章虚黄，短篇 strict
  // （runner STRICT_SHORT_CHECK_IDS 的 simile-density）升红会把对白密集章误打回
  // 重写。SIMILE_RE 匹配的是「像…」句式（非特定词表），剥对白后剩余叙述照常命中，
  // 无需改正则；剥引号必须在 checkSimile 调用点做而非收进 SIMILE_RE 本体：
  // scripts/harvest-corpus.ts 语料收割复用本正则直扫原文取真实比喻短语
  // 作幸存者判定锚，收割面要原文全量命中（含引号内），改正则会漂移收割锚口径——
  // 单一真相源只保正则本体，剥引号由消费方各自决定。
  const prose = stripQuotedSpans(body)
  // 统计明喻句式命中数（粗计；精确判定比喻语义需 NLP，零 token 取句式近似）
  const count = (prose.match(SIMILE_RE) ?? []).length
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
export function checkSectionCount(body: string, expected = 5): CheckSectionResult {
  // section_count 可配置（runner 传 short.section_count），文案
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
  // G203（0918三轮修复批）：剥围栏 + 标题行识别整段收编 format/section-heading 单源
  //（/////语义沿革注释随迁彼处文件头注）——此前
  // 本处手写围栏状态机 + 正则与 metrics/collectBodyAnchors 的第二套识别器口径分裂
  //（紧排 `##标题` 漏识 / 围栏内 `##` 误收），两处消费同源后消除漂移面。节数口径
  // 逐位不变（本函数只用标题数，不用标题文字）。
  const headings = extractSectionHeadings(body)
  let sections: number
  if (headings.length >= 2) {
    // 有 ## 标题：按标题数
    sections = headings.length
  } else if (headings.length === 1) {
    // 单标题给准确文案——原本文案说「未使用 ## 标注」失真（作者用了但只有 1 个），
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
const DEFAULT_ENV_WORDS = [
  '天气',
  '阳光',
  '月光',
  '日升',
  '日落',
  '天空',
  '云层',
  '乌云',
  '风声',
  '狂风',
  '雨声',
  '雨点',
  '景色',
  '远山',
  '树林',
  '街道',
  '建筑',
]

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
  // opening 窗口先剥对白引号 span 再匹配环境词——角色嘴里说的
  // 「今天天气真好」是对白不是环境描写（叙述面），裸匹配此前误报对白密集的开篇。
  // 码点口径（对齐）——UTF-16 直接 slice 在含 astral 字符
  // 时窗口实际缩短；astral 码点最多占 2 个 UTF-16 单元，先取 openingChars*2 单元再按
  // 码点截断，窗口恒足 openingChars 码点。
  // （修复批）：剥引号与开窗 swap——原序「先截窗
  // 后剥引号」下窗尾截断的半个 span（有开无闭）不被识别，引号内容仍参与匹配；而本项
  // 在 runner.ts STRICT_SHORT_CHECK_IDS 严格升红集内（黄→红拦定稿闸），短篇开篇恰在
  // 窗尾截断对白即误报白烧重写费。现改为**全文先剥再开窗**（stripQuotedSpans 在完整
  // 正文上识别配对 span，随后才做码点窗），截断半 span 形态根除；窗口语义不变
  //（= 去对白后叙述面的前 openingChars 码点），非对白开篇的命中面逐位不变。
  const opening = [...stripQuotedSpans(body).slice(0, openingChars * 2)].slice(0, openingChars).join('')
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
