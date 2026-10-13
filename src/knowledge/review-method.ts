/**
 * 三审视角技法运行时注入。
 *
 * prompt 只留「审查契约 + 审计基线(通用章级判断条/连载连续性/输出契约)」;
 * 视角对口技法(章尾钩子/反转机制/打脸节奏/升级感/人物与对话/关系网/连续性)从
 * 知识层语料运行时注入,单源 = 书级 > 随包(corpus.ts)。书级命中登记名 =
 * `知识层/<rel>`,随包回落 = `知识层(内置)/<rel>`(「模型可见 ⟺ 已记录」)。
 * 书级缺失/两级皆缺 → 空段(退化到「只有契约与基线」,不阻断三审)。
 *
 * 本模块只留**策略**(lens + 书档 → 篇映射、单篇帽声明);装配单源 = src/knowledge/inject.ts。
 *
 * 映射按**书档分表**(`kind`):同名 lens 在长短两档含义不同——短篇的 payoff 是
 * 「设定收尾审」(伏笔回收/反转线索闭合),长篇的 payoff 是打脸节奏;短篇的 hook 审
 * 开篇抓力,长篇的 hook 审章尾留钩与跨章承接。故同一 lens 在两档取不同篇,不共用
 * 一张表(混用即跨档口径污染:拿连载判据审单篇)。
 */
import { assembleKnowledge, type KnowledgeAssembly } from './inject.js'
import {
  GENERAL_FILE_QUALITY,
  LONG_FILE_HOOKS,
  LONG_FILE_OUTLINE,
  LONG_FILE_QUALITY,
  LONG_FILE_REVERSAL,
  LONG_FILE_RHYTHM,
  LONG_FILE_SUSPENSE,
  SHORT_FILE_HOOKS,
  SHORT_FILE_QUALITY,
  SHORT_FILE_REVERSAL,
} from './catalog.js'

/** 单篇码点帽——本模块是**单文件映射**(每 lens 恰一篇),故此帽即注入段的有效总帽
 *  (与写稿面 select.ts 的多篇累计不同:那里另有合计帽,可被多篇命中触发)。
 *  须 ≥ 语料篇目规范上限(单篇 ≤3000 码点),低于此值会把篇尾自检清单整段截掉。 */
export const REVIEW_METHOD_FILE_CAP = 3000

/** 该书档位(与写稿面 kind 同口径) */
export type ReviewKind = 'long' | 'short'

/**
 * 书档 × lens → 视角对口技法篇(相对知识层根的 rel;单文件映射,缺口径即不注入)。
 *
 * 未列出的组合(如长篇无 payoff 视角之外的组合)→ 空段:调用方按「空段不入 prompt
 * 不登记」契约处置。短篇档不列 disclosure / plot_causality——两视角不在短篇任务书里
 *(判据见 contract.buildReviewTasks 头注)。
 */
const LENS_METHOD_FILE: Record<ReviewKind, Record<string, string>> = {
  long: {
    // 信息差编排（四方信息账 / 揭开时点 / 每章至少保住一处信息差）← 长篇悬念编排速查
    disclosure: LONG_FILE_SUSPENSE,
    // 事件因果化（单元靠因果而非时间串联 / 转折的意外合理推动力）← 长篇大纲方法速查
    plot_causality: LONG_FILE_OUTLINE,
    // 章尾留钩/跨章承接(章尾八式)← 长篇章节钩子速查
    hook: LONG_FILE_HOOKS,
    // 反转机制核对(埋线 ≥2-3 处/误导/揭示后兑现)← 长篇反转机制速查
    emotion_peak: LONG_FILE_REVERSAL,
    // 打脸节奏(铺垫优先/分层/兑现具体可感)← 长篇反转机制速查
    payoff: LONG_FILE_REVERSAL,
    // 升级感三步 + 期待兑现口径 ← 长篇节奏与升级感速查
    reader: LONG_FILE_RHYTHM,
    // 人物动机/因果逻辑/表达可信 ← 通用质量清单(逐项核对口径)
    editor: GENERAL_FILE_QUALITY,
    // 连载连续性(设定/时间线/卖点守恒)← 长篇质量清单
    continuity: LONG_FILE_QUALITY,
  },
  short: {
    // 开篇抓力/黄金段位/单篇牵引 ← 短篇章节钩子速查
    hook: SHORT_FILE_HOOKS,
    // 情绪曲线达峰 + 反转信息差可回溯 ← 短篇反转机制速查
    emotion_peak: SHORT_FILE_REVERSAL,
    // 设定收尾审(伏笔回收闭合/反转线索核对)← 短篇质量清单
    payoff: SHORT_FILE_QUALITY,
    // 情绪释放完成度(押与还的配比)← 短篇反转机制速查
    reader: SHORT_FILE_REVERSAL,
    // 人物动机/因果逻辑/表达可信 ← 通用质量清单
    editor: GENERAL_FILE_QUALITY,
    // 单篇设定自洽/前文接得上 ← 短篇质量清单
    continuity: SHORT_FILE_QUALITY,
  },
}

/** 段头(整块前缀,含其后换行——段文本是测试锚定面) */
const REVIEW_HEADING = '## 视角技法参考(按本书知识层提供,与下方焦点规则冲突时以焦点规则为准)\n'

/**
 * 组装某视角的技法注入段。bookRoot 缺省 → 只读随包(退化行为稳定可测)。
 * `enabled === false`(书级开关关停)→ 不读盘,段与登记一并空。
 * `kind` 缺省 long(写稿面 kind 的缺省档同口径);两级皆缺/读失败 → 空段
 * (调用方按「空段不入 prompt 不登记」处置)。
 */
export function buildReviewMethodInjection(
  lens: string,
  bookRoot?: string,
  enabled?: boolean,
  kind: ReviewKind = 'long',
): KnowledgeAssembly {
  const rel = LENS_METHOD_FILE[kind][lens]
  return assembleKnowledge({
    bookRoot,
    rels: rel === undefined ? [] : [rel],
    heading: REVIEW_HEADING,
    fileCap: REVIEW_METHOD_FILE_CAP,
    totalCap: Infinity, // 单文件映射:合计帽由单篇帽承载
    enabled,
    reasonOf: () => `视角 ${lens} 对口技法(${kind})`,
  })
}
