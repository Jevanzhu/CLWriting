/**
 * 分句工具 —— 全项目统一按 。！？!?\n 切句（P2-BE-6 DRY）。
 *
 * 原先 check/count.ts / metrics/style.ts / learn/index.ts / ai/rules/style-remedy.ts
 * 各自内联 split，且 learn 少了 \n 口径不一致（可能漏检跨行）。统一收口到此模块。
 */

/** 分句：按中文句末标点（。！？）+ 半角 !?（中英混排收尾，R27-29）+ 省略号 …
 *  （R31-10，三十一轮：省略号收句与句号同级，此前「她想说什么……」整句不切、句读
 *  统计面系统性失真）+ 换行切，去空白。includeColon 时额外按 ；切（对话/排比场景）。
 *  半角 `.` 不切——小数点/英文缩写误伤面大，混排句以 !? 高发形态覆盖即可。
 *  `……` 连写：按字符切分在两个 … 之间产一个空段，经既有 trim+filter 空段剔除后
 *  等效单边界（见 r31b-sentences-ellipsis 回归）。 */
export function splitSentences(body: string, includeColon = false): string[] {
  const re = includeColon ? /[。！？；…!?\n]/ : /[。！？…!?\n]/
  return body.split(re).map((s) => s.trim()).filter((s) => s.length > 0)
}

/**
 * M-12（第八轮）：滑窗句级 n-gram 复读率——count.ts checkRepeat 与 metrics/style.ts
 * computeRepeatRate 的共享实现（原先两处各写一套，style 那套是整句哈希且句长阈值不同，
 * 复读率系统性低估、avgRepeat>0.1 预警近乎永不触发，与「同口径」注释互相矛盾）。
 * 「重复 n-gram 实例数 / 总 n-gram 数」：重复句改个别字仍有大量相同 n-gram 被计数。
 * R29-B6（二十九轮）：返回值新增 repeatChars——绝对重复字符量（量纲：每个重复
 * n-gram 的「超出首次出现的实例」按 n 字折算，全书求和）。纯比率口径随章长稀释：
 * 大章里百字级复读块的占比被总 n-gram 数摊薄（5000 字章重复 100 字 ≈ 2% < 15% 阈），
 * 消费方（checkRepeat）可用绝对量双口径兜住漏报；存量消费方 metrics/style.ts 只读
 * .rate，新增字段向后兼容。
 */
export function ngramRepeatRate(body: string, n = 8): { rate: number; total: number; repeatInstances: number; repeatChars: number } {
  const sentences = splitSentences(body).filter((s) => s.length >= n)
  const counts = new Map<string, number>()
  let total = 0
  // R31-18（三十一轮）：滑窗默认按 UTF-16 码元（快路径——纯 BMP 文本码元=码点，行为
  // 不变、热路径零额外开销）；句内含 astral 字符（代理对：emoji/CJK 扩展区）时改码点
  // 迭代取窗，防一个字符被拆两半计入不同 gram（伪不重复）或窗口对齐错位。两路径的
  // gram 键空间不相交（含代理对的键只出自码点路径），混用同一 Map 无碰撞。
  for (const s of sentences) {
    if (ASTRAL_CHAR_RE.test(s)) {
      const cps = Array.from(s)
      for (let i = 0; i + n <= cps.length; i++) {
        const gram = cps.slice(i, i + n).join('')
        counts.set(gram, (counts.get(gram) ?? 0) + 1)
        total++
      }
      continue
    }
    for (let i = 0; i + n <= s.length; i++) {
      const gram = s.slice(i, i + n)
      counts.set(gram, (counts.get(gram) ?? 0) + 1)
      total++
    }
  }
  let repeatInstances = 0
  let repeatChars = 0
  for (const c of counts.values()) {
    if (c >= 2) {
      repeatInstances += c - 1
      repeatChars += (c - 1) * n
    }
  }
  return { rate: total > 0 ? repeatInstances / total : 0, total, repeatInstances, repeatChars }
}

/** R31-18：代理对（U+D800-U+DFFF）探测——命中即该句含 astral 字符，走码点取窗路径。 */
const ASTRAL_CHAR_RE = /[\uD800-\uDFFF]/
