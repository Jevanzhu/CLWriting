/**
 * 文风收割打分分档（hh §八-16 自 LearnView.vue 抽出单源，纯搬家）。
 * LearnView（概览分布条）与 SampleCandidateList（筛选/候选卡着色）共用。
 */
export const TIER_A = 90
const TIER_B = 75

/** 打分分档：A ≥90 优质，B 75-89 良好，C 60-74 及格 */
export function tierOf(score: number): 'a' | 'b' | 'c' {
  if (score >= TIER_A) return 'a'
  if (score >= TIER_B) return 'b'
  return 'c'
}

/** R48-90（四十八轮）：打分分布统计单源——原 LearnView（概览分布条）与
 *  SampleCandidateList（头部统计）逐字双实现收编；档位口径随 tierOf 单源走。 */
export function scoreTierStats(samples: readonly { 打分: number }[]): {
  a: number
  b: number
  c: number
  total: number
} {
  let a = 0
  let b = 0
  let c = 0
  for (const s of samples) {
    const t = tierOf(s.打分)
    if (t === 'a') a++
    else if (t === 'b') b++
    else c++
  }
  return { a, b, c, total: samples.length }
}
