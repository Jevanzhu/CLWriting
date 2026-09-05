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
 * PM-7（性能与内存专项·2026-09-05）：gram 键从字符串改数值哈希。此前每窗
 * `s.slice(i, i+n)` 物化新字符串作 Map 键（每键 = 字符串头 + n×2B 码元，全章常驻
 * counts 不释放），超大单章机检瞬时 150-250MB。现改为双 32 位多项式滚动哈希
 * （Rabin-Karp 式出窗减除，滑窗 O(1) 增量、零字符串分配）组成 ≤2^53 的安全整数
 * 键（Map<number, number>），逐窗算术开销换内存峰值坍缩。语义硬约束——返回四字段
 * 与旧字符串键实现逐位等价（等价性由 test/format/pm7-ngram-hash.test.ts 内嵌
 * 旧实现参照在大规模语料上逐位断言背书）：跨句聚合（counts 全书统一累计，不同句
 * 相同短语仍算重复）、total/repeatInstances/repeatChars 推导全部不变。
 * 键布局与碰撞论证：键 = (trunc20(h1)|判别位)·2^32 + h2（h1/h2 为同字符序列在
 * 两个不同奇底数下的 32 位多项式值），总键域 2^53。判别位（h1 第 20 位）**只对
 * 真含 astral 码点（>0xFFFF）的窗置位**——含代理对的 gram 在旧字符串键下只可能
 * 出自码点路径且不与任何纯 BMP gram 相等，置位后键域 [2^52, 2^53) 与 BMP 键域
 * [0, 2^52) 结构性不相交，精确对齐 R31-18 语义；反之 astral 句里纯 BMP 码点组成
 * 的窗（join 后与 BMP 路径 gram 同串）**不置位**、与 BMP 路径同式哈希（码点值 =
 * 码元值），跨路径同短语照常并桶——按句置判别位会把这类并桶拆散（同一 8 字短语
 * 在含 emoji 句与纯 BMP 句各一次时旧实现计 1 处重复，拆散后变 0，语义回归）。
 * 同域内两不同 gram 碰撞需 20 位 h1 截断与 32 位 h2 同时相等，按随机哈希近似
 * birthday 界 ≈ k²/2^53（k = distinct gram 数；10 万级 ≈ 1×10⁻⁶，百万级 ≈
 * 1×10⁻⁴，写作语料远达不到）；且此哈希对抗的是自然文本，非对抗性构造（多项式
 * mod 2^k 的 Thue-Morse 型对抗序列不出现于小说正文）。碰撞一旦发生的失真也有界：
 * 仅两个 gram 计数并桶，repeatInstances 漂移 ≤ 并桶侧 count——不炸、不越界、
 * 不改变其余推导。53 位上限是刻意的：(h1 截断)·2^32 + h2 恰 ≤
 * Number.MAX_SAFE_INTEGER（2^53−1），双精度整数精确表示、无舍入暗坑（用满 64 位
 * 会溢出安全整数域，BigInt 则慢一个量级，均不取）。
 */
export function ngramRepeatRate(body: string, n = 8): { rate: number; total: number; repeatInstances: number; repeatChars: number } {
  const sentences = splitSentences(body).filter((s) => s.length >= n)
  const counts = new Map<number, number>()
  let total = 0
  const bump = (key: number) => {
    counts.set(key, (counts.get(key) ?? 0) + 1)
    total++
  }
  // PM-7：BASE^(n-1) mod 2^32——出窗码元/码点在多项式最高次项的系数，滑窗减除用。
  // 每次调用算一次（单次调用内 n 恒定），两底数不同源去相关。
  let pow1 = 1
  let pow2 = 1
  for (let i = 1; i < n; i++) {
    pow1 = Math.imul(pow1, GRAM_HASH_BASE1)
    pow2 = Math.imul(pow2, GRAM_HASH_BASE2)
  }
  // R31-18（三十一轮）：滑窗默认按 UTF-16 码元（快路径——纯 BMP 文本码元=码点，行为
  // 不变、热路径零额外开销）；句内含 astral 字符（代理对：emoji/CJK 扩展区）时改码点
  // 迭代取窗，防一个字符被拆两半计入不同 gram（伪不重复）或窗口对齐错位。注意
  // astral 句预过滤按码元长度 ≥n 不保证码点数 ≥n（代理对一符两元），窗数以码点数
  // 为准——码点不足 n 时该句零窗，与旧实现 `cps.slice` 循环自然不执行同口径。
  for (const s of sentences) {
    if (ASTRAL_CHAR_RE.test(s)) {
      const cps: number[] = []
      for (let i = 0; i < s.length; ) {
        const cp = s.codePointAt(i)!
        cps.push(cp)
        i += cp > 0xffff ? 2 : 1
      }
      if (cps.length < n) continue
      let h1 = 0
      let h2 = 0
      // PM-7：窗内 astral 码点计数——滑窗 O(1) 增减，判别位只随「窗真含 astral 码点」
      // 置位（见函数头注释：纯 BMP 码点窗须与 BMP 路径同键域跨路径并桶）
      let astralInWin = 0
      for (let i = 0; i < n; i++) {
        const cp = cps[i]!
        if (cp > 0xffff) astralInWin++
        h1 = (Math.imul(h1, GRAM_HASH_BASE1) + cp) >>> 0
        h2 = (Math.imul(h2, GRAM_HASH_BASE2) + cp) >>> 0
      }
      bump(((h1 & 0xfffff) | (astralInWin > 0 ? 0x100000 : 0)) * 0x100000000 + h2)
      for (let i = n; i < cps.length; i++) {
        const out = cps[i - n]!
        const inc = cps[i]!
        if (out > 0xffff) astralInWin--
        if (inc > 0xffff) astralInWin++
        h1 = (Math.imul(h1 - Math.imul(out, pow1), GRAM_HASH_BASE1) + inc) >>> 0
        h2 = (Math.imul(h2 - Math.imul(out, pow2), GRAM_HASH_BASE2) + inc) >>> 0
        bump(((h1 & 0xfffff) | (astralInWin > 0 ? 0x100000 : 0)) * 0x100000000 + h2)
      }
      continue
    }
    let h1 = 0
    let h2 = 0
    for (let i = 0; i < n; i++) {
      const c = s.charCodeAt(i)
      h1 = (Math.imul(h1, GRAM_HASH_BASE1) + c) >>> 0
      h2 = (Math.imul(h2, GRAM_HASH_BASE2) + c) >>> 0
    }
    bump((h1 & 0xfffff) * 0x100000000 + h2)
    for (let i = n; i < s.length; i++) {
      const out = s.charCodeAt(i - n)
      const inc = s.charCodeAt(i)
      h1 = (Math.imul(h1 - Math.imul(out, pow1), GRAM_HASH_BASE1) + inc) >>> 0
      h2 = (Math.imul(h2 - Math.imul(out, pow2), GRAM_HASH_BASE2) + inc) >>> 0
      bump((h1 & 0xfffff) * 0x100000000 + h2)
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

/** PM-7：双多项式滚动哈希底数（模 2^32 下的奇常数——奇则乘法可逆，出窗减除式
 *  滑窗依赖此性质）。16777619 = FNV 素数；2654435761 = Knuth 乘法散列黄金比常数。 */
const GRAM_HASH_BASE1 = 16777619
const GRAM_HASH_BASE2 = 2654435761

/** R31-18：代理对（U+D800-U+DFFF）探测——命中即该句含 astral 字符，走码点取窗路径。 */
const ASTRAL_CHAR_RE = /[\uD800-\uDFFF]/
