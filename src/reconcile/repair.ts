/**
 * 源文件修复确认 —— 依据 ⑱ 手改对账 spec 第 2 节（补 ① M1 占位）。
 *
 * M1 容错读写库（format/*）读 md 返回 ParseError（file/line/message，结构化）；
 * 本模块补完整交互：人话定位 + 修复建议分层 + 降级不崩 + 坏文件原样保留。
 *
 * 原则（⑱ 第 1 节）：
 * - 文件即真相、坏文件先保留——修复前不删不覆盖，作者的字哪怕坏了也是真相。
 * - 检测→提议→永不拒绝——发现坏文件提议修复，不报错阻断；修好前相关功能降级。
 * - 语义判断 M3 桩、M4 真——明显笔误/缺字段给具体改法；判不准列可能项 ask；AI 语义修复 M4。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { rebuild } from '../cache/rebuild.js'
import type { ParseError } from '../format/types.js'

/** 修复建议类型（⑱ 第 2 节分层） */
export type RepairSuggestionKind = 'obvious' | 'uncertain' | 'ai-only'

/** 修复建议（⑱ 第 2 节，M3 出结构化建议 + 作者手动修通道） */
export interface RepairSuggestion {
  /** 对应的解析错误 */
  error: ParseError
  /** 人话定位（文件:行：原因，零机器味） */
  location: string
  /** 建议类型 */
  kind: RepairSuggestionKind
  /** 具体改法（obvious 给「X→Y」；uncertain 列可能项；ai-only 占位） */
  proposal: string
  /** AI 语义修复（M3 桩 / M4 真）——M3 一律 null */
  aiProposal: null
}

/** 修复确认结果（⑱ 第 2 节） */
export interface RepairReport {
  /** 发现的坏文件错误 */
  errors: ParseError[]
  /** 每个错误的修复建议 */
  suggestions: RepairSuggestion[]
  /** 是否触发降级（有坏文件则相关功能降级，系统其余照常） */
  degraded: boolean
}

/**
 * 全量扫描源文件解析错误（⑱ 第 2 节）。
 * 复用 rebuild 收错（幂等，④ 重建器）；坏文件计入 errors 不中断。
 */
export function detectParseErrors(bookRoot: string): ParseError[] {
  const cachePath = join(bookRoot, '.cache', 'index.db')
  const result = rebuild(bookRoot, cachePath)
  return result.errors
}

/**
 * 对一个解析错误出修复建议（⑱ 第 2 节分层）。
 * M3 脚本能判的：明显笔误（枚举值附近）、缺必填字段；判不准的列可能项；语义 M4 桩。
 */
export function proposeRepair(error: ParseError): RepairSuggestion {
  const location = formatLocation(error)
  const { kind, proposal } = analyze(error)

  return {
    error,
    location,
    kind,
    proposal,
    aiProposal: null, // M3 桩：AI 语义修复建议 M4 出
  }
}

/** 人话定位（⑱ 第 2 节：位置 + 人话，不出解析器堆栈） */
function formatLocation(error: ParseError): string {
  const short = error.file.replace(/\\/g, '/').split('/').slice(-2).join('/') // 末两级路径
  return error.line > 0 ? `${short} 第${error.line}行：${error.message}` : `${short}：${error.message}`
}

/**
 * 分析错误 → 建议分层（⑱ 第 2 节）。
 * - obvious：枚举值笔误（状态值非法）、缺默认字段 → 给具体改法
 * - uncertain：其他格式违例 → 列可能项 ask
 * - ai-only：语义层（M3 一律 null，标 ai-only 留 M4）
 */
function analyze(error: ParseError): { kind: RepairSuggestionKind; proposal: string } {
  const msg = error.message

  // 枚举值笔误：状态值不是 进行中/已收尾/已放弃（③ 第 5 节）
  const statusMatch = msg.match(/状态[值]?(?:.*?)(?:不是|非法|无效).*?/) || msg.includes('状态')
  if (statusMatch && /进行|收尾|放弃|生效|有效/.test(msg)) {
    // 猜最接近的合法值（编辑距离最近，M3 朴素实现）
    const guess = guessEnumValue(msg)
    return {
      kind: 'obvious',
      proposal: `状态值不合法。合法值：进行中 / 已收尾 / 已放弃。${guess ? `你是不是想写「${guess}」？` : ''}`,
    }
  }

  // 缺必填字段
  if (msg.includes('缺少必填字段')) {
    const field = msg.match(/缺少必填字段[：:]\s*(\S+)/)?.[1] ?? '该字段'
    return {
      kind: 'obvious',
      proposal: `缺必填字段「${field}」，在 front matter（--- 之间）补一行，如「${field}: <值>」。`,
    }
  }

  // front matter 格式违例（无 ---、坏 YAML）
  if (msg.includes('front matter') || msg.includes('---') || msg.includes('YAML') || msg.includes('解析失败')) {
    return {
      kind: 'uncertain',
      proposal: 'front matter 格式不对。检查文件开头是否是 `---` 包裹的键值表（每行 `键: 值`），可能是少了分隔符或多了缩进。',
    }
  }

  // 其他：判不准，列方向 ask
  return {
    kind: 'uncertain',
    proposal: '这个错误脚本判不准怎么修。对照同目录其他文件的格式看看，或等 AI 辅助修复（M4）。',
  }
}

/** 猜最接近的合法枚举值（⑱ 第 2 节，M3 朴素编辑距离） */
function guessEnumValue(msg: string): string | null {
  const legal = ['进行中', '已收尾', '已放弃']
  // 从 message 里提取疑似非法值（引号内或「」内）
  const m = msg.match(/[「『"]([^」』"]+)[」』"]/)?.[1] ?? msg.match(/值[『「]?(.+?)[」』]?(?:不是|非法|无效)/)?.[1]
  if (!m) return null
  // 选字符重合最多的
  let best: string | null = null
  let bestScore = 0
  for (const l of legal) {
    let score = 0
    for (const ch of m) if (l.includes(ch)) score++
    if (score > bestScore) {
      bestScore = score
      best = l
    }
  }
  return bestScore > 0 ? best : null
}

/**
 * 修复确认完整报告（⑱ 第 2 节）。
 * 检测全部错误 + 逐个出建议 + 标降级。坏文件原样保留（本函数不改任何文件）。
 */
export function repairReport(bookRoot: string): RepairReport {
  const errors = detectParseErrors(bookRoot)
  const suggestions = errors.map(proposeRepair)
  return {
    errors,
    suggestions,
    degraded: errors.length > 0,
  }
}

/** 修复报告 → 人话（⑱ 第 2 节，对作者零机器味 + 修复指引） */
export function formatRepairReport(report: RepairReport): string {
  if (report.errors.length === 0) {
    return '✓ 所有源文件格式正常，没有坏文件。'
  }
  const lines: string[] = []
  lines.push(`✗ 发现 ${report.errors.length} 个源文件有问题，逐个修：\n`)
  for (const s of report.suggestions) {
    lines.push(`· ${s.location}`)
    lines.push(`  ${s.proposal}`)
    if (s.kind === 'ai-only') lines.push('  （AI 语义修复建议待 M4）')
    lines.push('')
  }
  lines.push('修好前相关功能降级（坏文件的账本暂不入缓存/机检），系统其余照常。坏文件原样保留，修复是改好后显式保存。')
  return lines.join('\n')
}

/** 降级判定：某文件是否因坏而不入缓存（⑱ 第 2 节降级不崩） */
export function isDegradedFile(filePath: string, report: RepairReport): boolean {
  return report.errors.some((e) => existsSync(e.file) && e.file === filePath)
}
