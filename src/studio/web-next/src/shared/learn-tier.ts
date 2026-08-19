/**
 * 文风收割打分分档（hh §八-16 自 LearnView.vue 抽出单源，纯搬家）。
 * LearnView（概览分布条）与 SampleCandidateList（筛选/候选卡着色）共用。
 */
export const TIER_A = 90
export const TIER_B = 75

/** 打分分档：A ≥90 优质，B 75-89 良好，C 60-74 及格 */
export function tierOf(score: number): 'a' | 'b' | 'c' {
  if (score >= TIER_A) return 'a'
  if (score >= TIER_B) return 'b'
  return 'c'
}
