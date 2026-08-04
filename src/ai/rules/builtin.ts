/**
 * 内置静态规则（源 1：writer.ts 三处硬编码归一）。
 *
 * writer.ts:21/42/56 三处「避免AI味」约束字面量搬到此处 toPrompt()，
 * 验收要求 prompts/writer.ts 约束字面量归零。
 */
import type { WritingRule, RuleViolation } from './types.js'

/** 原 writer.ts 三处硬编码的统一约束文本 */
const AI_CLICHE_PROMPT =
  '避免AI味：不堆砌华丽辞藻，不用「值得一提的是」「不禁」「映入眼帘」等AI高频套话；用具体细节而非抽象概括。'

/**
 * AI 高频套话词表（writer.ts 点名 3 个 + 少量高频确认项）。
 * 保守列表——仅收录公认 AI 套话，避免误报。
 */
const CLICHE_WORDS = [
  '值得一提的是',
  '不禁',
  '映入眼帘',
  '不得不说',
  '不言而喻',
  '众所周知',
  '一言难尽',
  '毫无疑问',
] as const

/** AI 高频套话规则（黄级：提示不卡流程） */
export const aiClicheRule: WritingRule = {
  id: 'ai-cliche',
  level: 'yellow',
  tasks: ['self-heal', 'spawn-write', 'rewrite'],
  toPrompt: () => AI_CLICHE_PROMPT,
  check(body: string): RuleViolation[] {
    return CLICHE_WORDS.filter((w) => body.includes(w)).map((w) => ({
      ruleId: 'ai-cliche',
      level: 'yellow' as const,
      message: `AI高频套话「${w}」——删除或替换为具体描写`,
    }))
  },
}
