/**
 * 三审视角技法运行时注入(统一批)。
 *
 * prompt 只留「审查契约 + 审计基线(通用章级判断条/连载连续性/输出契约)」;
 * 视角对口技法(章尾八式/反转机制/打脸节奏/升级感三步/对话与人物/关系网)从
 * 知识层语料运行时注入,单源 = 书级 > 随包(corpus.ts)。书级命中登记名 =
 * `知识层/<rel>`,随包回落 = `知识层(内置)/<rel>`(「模型可见 ⟺ 已记录」)。
 * 书级缺失/两级皆缺 → 空段(退化到「只有契约与基线」,不阻断三审)。
 */
import { clipWithNotice } from '../shared/text.js'
import { resolveCorpusFile } from './corpus.js'
import { log } from '../log/index.js'
import { METHOD_FILE_CHARACTER, METHOD_FILE_HOOKS, METHOD_FILE_REVERSAL, METHOD_FILE_RHYTHM } from './select.js'

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

export interface ReviewMethodInjection {
  /** 注入段全文;该 lens 无对口技法/两级皆缺 → 空串 */
  text: string
  /** 注入源登记名(注入序) */
  sources: string[]
}

/**
 * 组装某视角的技法注入段。bookRoot 缺省 → 只读随包(退化行为稳定可测)。
 * 两级皆缺/读失败 → 空段(调用方按「空段不入 prompt 不登记」处置)。
 */
export function buildReviewMethodInjection(lens: string, bookRoot?: string): ReviewMethodInjection {
  const file = LENS_METHOD_FILE[lens]
  if (file === undefined) return { text: '', sources: [] }
  const resolved = resolveCorpusFile(bookRoot, file)
  if (resolved === null) {
    log.warn('knowledge-review', `视角 ${lens} 技法篇两级皆缺,跳过:${file}`)
    return { text: '', sources: [] }
  }
  const body = clipWithNotice(resolved.body, REVIEW_METHOD_FILE_CAP)
  const title = file.slice(file.lastIndexOf('/') + 1).replace(/\.md$/, '')
  return {
    text: `## 视角技法参考(按本书知识层提供,与下方焦点规则冲突时以焦点规则为准)\n### ${title}\n${body}`,
    sources: [resolved.source],
  }
}
