/**
 * 审稿角色 system prompt（方案 §四③；C2 起资源化——文案唯一源 = resources/prompts/review-*.md）。
 *
 * 六视角全量文件（通用段已内嵌，哈希粒度 = 整份视角文案）；
 * review-common.md 是未知 lens 的 fallback。输出契约统一由 submit_issues tool_use 强制。
 */
import { loadBuiltinPrompt } from './resource.js'

const LENSES = ['reader', 'editor', 'continuity', 'hook', 'emotion_peak', 'payoff'] as const

/** 通用审稿规则（所有视角共用；未知 lens 的 fallback） */
export const REVIEW_COMMON = loadBuiltinPrompt('review-common').text

export const REVIEW_SYSTEMS: Record<string, string> = Object.fromEntries(
  LENSES.map((lens) => [lens, loadBuiltinPrompt(`review-${lens}`).text]),
)

/** lens → system prompt */
export function reviewSystem(lens: string): string {
  return REVIEW_SYSTEMS[lens] ?? REVIEW_COMMON
}
