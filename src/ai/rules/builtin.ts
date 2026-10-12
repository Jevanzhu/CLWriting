/**
 * 内置静态规则：writer.ts 三处「避免AI味」约束字面量收此 toPrompt
 *（约束字面量在 prompts/writer.ts 归零——规则文本单源即本文件）。
 *
 * 词表与句式表是**判定面单源**在 src/check/ai-patterns.ts（注入侧与机检侧都从那里取，
 * 改词表只改一处；本文件只 re-export 供既有消费面取值）。判断面（什么算 AI 味、为何
 * 要改、怎么改）在语料：`知识层/去味/去AI味判断速查.md`——两侧互指。
 */
import { ruleStripFm, type WritingRule, type RuleViolation } from './types.js'
import { AI_PATTERN_RULES, CLICHE_WORDS } from '../../check/ai-patterns.js'

export { AI_PATTERN_RULES, CLICHE_WORDS, type AiPatternRule } from '../../check/ai-patterns.js'

/** 原 writer.ts 三处硬编码的统一约束文本 */
const AI_CLICHE_PROMPT =
  '避免AI味：不堆砌华丽辞藻，不用「值得一提的是」「不禁」「映入眼帘」等AI高频套话；用具体细节而非抽象概括。'

/** AI 高频套话 + 套路句式规则（黄级：提示不卡流程） */
export const aiClicheRule: WritingRule = {
  id: 'ai-cliche',
  level: 'yellow',
  // draft-save 挂载：作者手改落盘的删除信号要走本规则（闭环）
  tasks: ['self-heal', 'spawn-write', 'rewrite', 'draft-save'],
  toPrompt: () => AI_CLICHE_PROMPT,
  check(body: string): RuleViolation[] {
    const prose = ruleStripFm(body)
    const out: RuleViolation[] = CLICHE_WORDS.filter((w) => prose.includes(w)).map((w) => ({
      ruleId: 'ai-cliche',
      level: 'yellow' as const,
      message: `AI高频套话「${w}」——删除或替换为具体描写`,
    }))
    for (const p of AI_PATTERN_RULES) {
      const hit = prose.match(p.re)
      if (hit) {
        out.push({
          ruleId: 'ai-cliche',
          level: 'yellow' as const,
          message: `套路句式「${hit[0].trim().slice(0, 24)}」——${p.fix}`,
        })
      }
    }
    return out
  },
}
