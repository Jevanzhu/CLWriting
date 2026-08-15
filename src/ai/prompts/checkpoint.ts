/**
 * checkpoint 摘要模板 + 输出钳制（批次 B2 / CS-11 + DSH-4 直抄）。
 *
 * 8 段模板逐字结构（dsh summarizer.ts:31-66）：段名保留英文防漂移 + 中文括注。
 * 两条纪律由调用方配合完成：
 * - 合并而非复制：待压区已含先前 checkpoint 时，摘要指令要求输出唯一一份累计存档；
 * - 空摘要 fail-open：摘要空 ≠ 压缩成功（compaction.ts compactHistory 兜底，绝不占位）。
 *
 * KV-cache 友好调用形态（DSH-4）：摘要指令不是独立 system prompt，而是
 * 「同一 system + tools + 待压消息前缀原样重放 + 末尾追加一条 user 指令」——
 * 摘要调用成为刚结束对话的真前缀延伸，直接吃前缀缓存。
 */

/** 摘要块的 XML 标记（插入历史后的识别/合并提取依据；字节稳定利于前缀缓存） */
export const CHECKPOINT_TAG_OPEN = '<compacted-summary>'
export const CHECKPOINT_TAG_CLOSE = '</compacted-summary>'

/** 插入历史时的前导说明（dsh CHECKPOINT_PREAMBLE：视为既定背景，不 acknowledge） */
export const CHECKPOINT_PREAMBLE =
  '以下是对此前对话的压缩存档（checkpoint）。将其视为既定背景，直接继续对话，不要复述、确认或评论这份存档。'

/** 8 段 checkpoint 段名（英文防漂移 + 中文括注） */
export const CHECKPOINT_SECTIONS = [
  'Primary Request and Intent（作者的核心请求与意图）',
  'Key Technical Concepts（本书关键设定与概念）',
  'Files and Code（涉及的章节/文件与内容要点）',
  'Errors and Fixes（工具执行失败与修正过程）',
  'Pending Jobs（悬而未决的事项）',
  'Current Work（当前正在讨论的内容）',
  'Next Step（约定的下一步）',
  'Critical Context（不可丢失的关键上下文）',
] as const

/**
 * 摘要指令（作为末尾 user 消息追加，KV-cache 友好形态的「末尾追加」半边）。
 * @param priorSummary 待压区已含的先前 checkpoint 正文（合并而非复制；缺省则全新压缩）
 */
export function buildCheckpointInstruction(priorSummary?: string): string {
  const lines: string[] = [
    '请把以上对话压缩为一份 checkpoint 存档，供后续对话在上下文被压缩后无缝继续。',
    '',
    '输出格式：按以下 8 个段落输出，段名逐字使用（含中文括注），每段一段正文；该段没有内容就写 (none)，绝不丢段：',
    ...CHECKPOINT_SECTIONS.map((s, i) => `${i + 1}. ${s}`),
    '',
    '规则：',
    '- 保留精确的章节号、数字、文件名、人物名与设定名，不要概括成模糊表述',
    '- 工具调用只记要点（调用了什么、结果如何），不复述全文',
    '- 不要提及本次摘要请求本身',
  ]
  if (priorSummary !== undefined) {
    lines.push(
      '- 以上对话开头已含一份先前的 checkpoint 存档：把它的内容合并进本次存档，输出唯一一份累计 checkpoint，不要保留两份',
    )
  }
  return lines.join('\n')
}

/** 从既有摘要消息文本中提取 checkpoint 正文（合并输入）；无标记或正文空 → null */
export function extractPriorSummary(content: string): string | null {
  const i = content.indexOf(CHECKPOINT_TAG_OPEN)
  if (i === -1) return null
  const j = content.indexOf(CHECKPOINT_TAG_CLOSE, i + CHECKPOINT_TAG_OPEN.length)
  const body = (
    j === -1 ? content.slice(i + CHECKPOINT_TAG_OPEN.length) : content.slice(i + CHECKPOINT_TAG_OPEN.length, j)
  ).trim()
  return body === '' ? null : body
}

// ── 输出侧钳制（cherry middleware.ts:48-73 实测：固定 2048 会恰好不够 → 摘要为空） ──

export const COMPRESSION_MIN_OUTPUT_TOKENS = 4096
export const COMPRESSION_MAX_OUTPUT_TOKENS = 16384

/**
 * 摘要输出预算 = clamp(contextWindow * 0.25, 4096, 16384)。
 * @param contextWindow 模型上下文窗口（token）；未知/非法 → 给上限（宁可多给）
 */
export function clampCheckpointOutputTokens(contextWindow?: number): number {
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return COMPRESSION_MAX_OUTPUT_TOKENS
  }
  const budget = Math.floor(contextWindow * 0.25)
  return Math.min(COMPRESSION_MAX_OUTPUT_TOKENS, Math.max(COMPRESSION_MIN_OUTPUT_TOKENS, budget))
}
