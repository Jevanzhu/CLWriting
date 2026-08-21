/**
 * 分句工具 —— 全项目统一按 。！？\n 切句（P2-BE-6 DRY）。
 *
 * 原先 check/count.ts / metrics/style.ts / learn/index.ts / ai/rules/style-remedy.ts
 * 各自内联 split，且 learn 少了 \n 口径不一致（可能漏检跨行）。统一收口到此模块。
 */

/** 分句：按中文句末标点（。！？）+ 换行切，去空白。includeColon 时额外按 ；切（对话/排比场景）。 */
export function splitSentences(body: string, includeColon = false): string[] {
  const re = includeColon ? /[。！？；\n]/ : /[。！？\n]/
  return body.split(re).map((s) => s.trim()).filter((s) => s.length > 0)
}

/**
 * M-12（第八轮）：滑窗句级 n-gram 复读率——count.ts checkRepeat 与 metrics/style.ts
 * computeRepeatRate 的共享实现（原先两处各写一套，style 那套是整句哈希且句长阈值不同，
 * 复读率系统性低估、avgRepeat>0.1 预警近乎永不触发，与「同口径」注释互相矛盾）。
 * 「重复 n-gram 实例数 / 总 n-gram 数」：重复句改个别字仍有大量相同 n-gram 被计数。
 */
export function ngramRepeatRate(body: string, n = 8): { rate: number; total: number; repeatInstances: number } {
  const sentences = splitSentences(body).filter((s) => s.length >= n)
  const counts = new Map<string, number>()
  let total = 0
  for (const s of sentences) {
    for (let i = 0; i + n <= s.length; i++) {
      const gram = s.slice(i, i + n)
      counts.set(gram, (counts.get(gram) ?? 0) + 1)
      total++
    }
  }
  let repeatInstances = 0
  for (const c of counts.values()) {
    if (c >= 2) repeatInstances += c - 1
  }
  return { rate: total > 0 ? repeatInstances / total : 0, total, repeatInstances }
}
