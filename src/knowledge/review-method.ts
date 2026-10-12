/**
 * 三审视角技法运行时注入(统一批)。
 *
 * prompt 只留「审查契约 + 审计基线(通用章级判断条/连载连续性/输出契约)」;
 * 视角对口技法(章尾八式/反转机制/打脸节奏/升级感三步/对话与人物/关系网)从
 * 知识层语料运行时注入,单源 = 书级 > 随包(corpus.ts)。书级命中登记名 =
 * `知识层/<rel>`,随包回落 = `知识层(内置)/<rel>`(「模型可见 ⟺ 已记录」)。
 * 书级缺失/两级皆缺 → 空段(退化到「只有契约与基线」,不阻断三审)。
 *
 * 本模块只留**策略**(lens → 篇映射、单篇帽声明);装配单源 = src/knowledge/inject.ts。
 */
import { assembleKnowledge, type KnowledgeAssembly } from './inject.js'
import { METHOD_FILE_CHARACTER, METHOD_FILE_HOOKS, METHOD_FILE_REVERSAL, METHOD_FILE_RHYTHM } from './catalog.js'

/** 单篇码点帽——本模块是**单文件映射**(每 lens 恰一篇),故此帽即注入段的有效总帽
 *  (与写稿面 select.ts 的多篇累计不同:那里另有合计帽,可被多篇命中触发)。 */
export const REVIEW_METHOD_FILE_CAP = 2000

/** lens → 视角对口技法篇(相对知识层根的 rel;单文件映射,缺口径即不注入)。 */
const LENS_METHOD_FILE: Record<string, string> = {
  // 章尾八式(突然揭示/紧急危机/.../回声/留白)← 章节钩子速查
  hook: METHOD_FILE_HOOKS,
  // 反转机制核对(埋线 ≥2-3 处/误导/一次性揭示/揭示后兑现)← 反转设计速查
  emotion_peak: METHOD_FILE_REVERSAL,
  // 打脸节奏(铺垫优先/分层/兑现具体可感)← 反转设计速查
  payoff: METHOD_FILE_REVERSAL,
  // 升级感三步 + 期待值口径 ← 节奏与升级感速查
  reader: METHOD_FILE_RHYTHM,
  // 对话技法(潜台词/冲突即对话/标签克制/声音区分)+ 人物三维度 ← 人物与对话技法速查
  editor: METHOD_FILE_CHARACTER,
  // 关系网(张力来源/事件驱动)← 人物与对话技法速查
  continuity: METHOD_FILE_CHARACTER,
}

/** 段头(整块前缀,含其后换行——段文本是测试锚定面) */
const REVIEW_HEADING = '## 视角技法参考(按本书知识层提供,与下方焦点规则冲突时以焦点规则为准)\n'

/**
 * 组装某视角的技法注入段。bookRoot 缺省 → 只读随包(退化行为稳定可测)。
 * `enabled === false`(书级开关关停)→ 不读盘,段与登记一并空。
 * 两级皆缺/读失败 → 空段(调用方按「空段不入 prompt 不登记」处置)。
 */
export function buildReviewMethodInjection(
  lens: string,
  bookRoot?: string,
  enabled?: boolean,
): KnowledgeAssembly {
  const rel = LENS_METHOD_FILE[lens]
  return assembleKnowledge({
    bookRoot,
    rels: rel === undefined ? [] : [rel],
    heading: REVIEW_HEADING,
    fileCap: REVIEW_METHOD_FILE_CAP,
    totalCap: Infinity, // 单文件映射:合计帽由单篇帽承载
    enabled,
    reasonOf: () => `视角 ${lens} 对口技法`,
  })
}
