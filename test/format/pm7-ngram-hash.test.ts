/**
 * PM-7（性能与内存专项·2026-09-05）回归：ngramRepeatRate 数值哈希键重写与旧实现的逐位等价。
 *
 * 修复前：滑窗每窗 `s.slice(i, i+n)` 物化新字符串作 Map<string, number> 键累计（astral
 * 路径 `cps.slice(i, i+n).join('')` 同罪且更贵）——键空间 = 窗口数 × (字符串头 + n×2B
 * 码元)，全章常驻 counts 不释放，超大单章机检瞬时 150-250MB。
 * 修复后：双 32 位多项式滚动哈希（Rabin-Karp 式出窗减除）组成 ≤2^53 安全整数键
 * Map<number, number>，滑窗 O(1) 增量、零字符串分配；判别位只对真含 astral 码点的窗
 * 置位（对齐 R31-18「含代理对的键只出自码点路径」，同时保住 astral 句内纯 BMP 码点窗
 * 与 BMP 路径 gram 的跨路径并桶——见「跨路径并桶」用例）。
 *
 * 等价性口径：返回四字段（rate/total/repeatInstances/repeatChars）与旧字符串键实现
 * 逐位相等。哈希碰撞是唯一理论失真源（birthday 界 k²/2^53，10 万级 distinct gram
 * ≈ 1×10⁻⁶），本测试内嵌旧实现原样为参照（referenceNgramRepeatRate，仅复用未改动的
 * splitSentences——被改面只在计数键），在下列各面逐位断言无碰撞等价：
 * - 随机中文 5 万字长文（含跨句重复短语——全书聚合不按句重置）
 * - astral 混排（emoji/CJK 扩展 B/数学字母区；跨句 astral 重复 + 跨路径同短语并桶）
 * - 边界：空串/短句/单句不足 n/恰 n 句/纯 ASCII/码元 ≥n 但码点 <n 的 astral 句
 * - n=2 与 n=16 边界 + 随机模糊（混合字母表 × n∈{1,2,8,16} × 300 轮）
 * - 高重复计数（同字 ×5000 的并桶计数）
 * - 性能烟雾：5 万字语料新实现耗时低于参照（min-of-3 取最小防抖动）
 */
import { describe, it, expect } from 'vitest'
import { ngramRepeatRate, splitSentences } from '../../src/format/sentences.js'

/** 旧实现原样内嵌（改写前 ngramRepeatRate 逐行拷贝，字符串键参照正本） */
function referenceNgramRepeatRate(
  body: string,
  n = 8,
): { rate: number; total: number; repeatInstances: number; repeatChars: number } {
  const sentences = splitSentences(body).filter((s) => s.length >= n)
  const counts = new Map<string, number>()
  let total = 0
  for (const s of sentences) {
    if (/[\uD800-\uDFFF]/.test(s)) {
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

/** 四字段逐位断言（rate = 整数分子/整数分母，两侧整数逐位等则 double 逐位等） */
function expectEquivalent(body: string, n: number) {
  const got = ngramRepeatRate(body, n)
  const want = referenceNgramRepeatRate(body, n)
  expect(got.total, `total 不等（n=${n}，body 前 60 码元=${JSON.stringify(body.slice(0, 60))}）`).toBe(want.total)
  expect(got.repeatInstances, `repeatInstances 不等（n=${n}）`).toBe(want.repeatInstances)
  expect(got.repeatChars, `repeatChars 不等（n=${n}）`).toBe(want.repeatChars)
  expect(got.rate, `rate 不等（n=${n}）`).toBe(want.rate)
  return got
}

/** 确定性 LCG（与 pm2-count-words-equivalence 同款，固定种子可复现） */
let seed = 1
const resetSeed = (s: number) => {
  seed = s
}
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}

/** 跨句重复短语（20 字，>8：短语内完整窗 20-8+1=13 个，注入两个不同句） */
const CROSS_BMP = '他自幽暗回廊尽头缓步走来袖口沾着未干墨迹'
/** 跨句重复短语（含 emoji：一半窗带判别位、一半窗为 astral 句内纯 BMP 码点窗） */
const CROSS_ASTRAL = '他自幽暗回廊尽头缓步走来😀袖口沾着未干墨迹'

/** 随机中文长文：随机句（4-30 字，0x4E00 起随机 800 字池）× 混合句末/换行切分，
 *  在第 5 句与第 40 句各注入一次 CROSS_BMP（不同句的相同 8-gram 必然跨句聚合）。 */
function buildChineseCorpus(targetChars: number): string {
  const sentences: string[] = []
  let written = 0
  while (written < targetChars) {
    const len = 4 + Math.floor(rand() * 27)
    let s = ''
    for (let i = 0; i < len; i++) s += String.fromCharCode(0x4e00 + Math.floor(rand() * 800))
    if (sentences.length === 5 || sentences.length === 40) s = CROSS_BMP + s
    sentences.push(s)
    written += s.length
  }
  const delims = ['。', '！', '？', '。\n']
  return sentences.map((s) => s + delims[Math.floor(rand() * delims.length)]).join('')
}

/** astral 混排语料：BMP 池 + emoji/扩展 B/数学字母区；句含代理对即走码点路径。
 *  注入点：第 4/20 句各一次 CROSS_ASTRAL（跨句 astral 聚合）；第 8 句（astral 句）与
 *  第 30 句（纯 BMP 句）各一次 CROSS_BMP（跨路径同短语并桶）。 */
function buildAstralCorpus(targetUnits: number): string {
  const pool = ['夜', '色', '沉', '的', '长', '街', '尽', '头', '灯', '火', '😀', '😂', '🤣', '𠮷', '𠀀', '𝓐', '𝓩', '，']
  const sentences: string[] = []
  let written = 0
  while (written < targetUnits) {
    const len = 4 + Math.floor(rand() * 20)
    let s = ''
    for (let i = 0; i < len; i++) s += pool[Math.floor(rand() * pool.length)]
    if (sentences.length === 4 || sentences.length === 20) s = CROSS_ASTRAL + s
    if (sentences.length === 8) s = CROSS_BMP + '😀' + s // astral 句里的纯 BMP 短语
    if (sentences.length === 30) s = CROSS_BMP + s // 同一短语再入纯 BMP 句
    sentences.push(s)
    written += s.length
  }
  const delims = ['。', '！', '？', '…', '\n']
  return sentences.map((s) => s + delims[Math.floor(rand() * delims.length)]).join('')
}

describe('ngramRepeatRate 数值哈希键等价性（PM-7）', () => {
  it('随机中文 5 万字长文：四字段逐位相等，跨句重复短语真实计入（非空转）', () => {
    resetSeed(0x2f6e2b1)
    const corpus = buildChineseCorpus(50_000)
    expect(corpus.length).toBeGreaterThanOrEqual(50_000)
    const got = expectEquivalent(corpus, 8)
    // 语义锚：20 字短语在两个不同句 → 短语内完整窗 ≥13 个各计 2 次——跨句聚合未被
    // 按句重置（重置则此处为 0）；且重复真实发生，等价断言不空转
    expect(got.repeatInstances).toBeGreaterThanOrEqual(13)
  })

  it('跨句聚合（小样本精确值）：同一 8 字短语在两个不同句 → 3 个重叠滑窗各计 2 次', () => {
    const body = '他大步流星地走了过去。夜风掀动窗纸把灯吹得摇晃。他大步流星地走了过去。'
    const got = expectEquivalent(body, 8)
    // 手算锚（主审亲核订正）：10 字句 n=8 有 10-8+1=3 个重叠滑窗（原稿误按「唯一
    // 重复窗」算 1/8，漏计窗口重叠——等价断言对内嵌参照本就通过，错的只是手算值），
    // 三窗在句3 全部再现 → repeatInstances = Σ(c-1) = 3、repeatChars = 3×8 = 24
    expect(got.repeatInstances).toBe(3)
    expect(got.repeatChars).toBe(24)
    // 反例：中间句隔断后无任何共享 8-gram → 0
    expect(expectEquivalent('他大步流星地走了过去。夜风掀动窗纸把灯吹得摇晃。各自独立成句没有共享。', 8).repeatInstances).toBe(0)
  })

  it('跨路径并桶（R31-18 精确语义）：同一 BMP 短语在 astral 句与 BMP 句各一次 → 计 3 处重复', () => {
    // 句1 含 😀 走码点路径，但「他大步流星地走了」等 3 个纯 BMP 码点窗 join 后与
    // 句2（纯 BMP 路径）的 3 个窗同串——旧实现并桶计 2 次；若按句置判别位拆键域，
    // 此处会漏计成 0（回归）。含 😀 的第 4 窗独立不并。
    const phrase = '他大步流星地走了过去'
    const got = expectEquivalent(phrase + '😀。' + phrase + '。', 8)
    expect(got.repeatInstances).toBe(3)
    expect(got.total).toBe(7) // 句1 码点 11 → 4 窗；句2 码元 10 → 3 窗
  })

  it('astral 混排语料（emoji/扩展 B/数学字母区）：四字段逐位相等，跨句 astral 重复计入', () => {
    resetSeed(0x5d17c0de)
    const corpus = buildAstralCorpus(20_000)
    expect(/[\uD800-\uDFFF]/.test(corpus)).toBe(true)
    const got = expectEquivalent(corpus, 8)
    // 语义锚：CROSS_ASTRAL 两句各一次 → 短语内完整窗（含 😀 的与纯 BMP 的都算）≥13
    expect(got.repeatInstances).toBeGreaterThanOrEqual(13)
  })

  it('边界：空串/短句/单句不足 n/恰 n 句/纯 ASCII/码元 ≥n 但码点 <n 的 astral 句', () => {
    const edges: Array<[string, number]> = [
      ['', 8],
      ['短。', 8],
      ['不足八字', 8],
      ['他大步流星地走了过。', 8], // 恰 n=8：单窗
      ['a'.repeat(200), 8], // 纯 ASCII
      ['😀'.repeat(5) + '。', 8], // 10 码元 ≥8 但 5 码点 <8 → 该句零窗，全书 total=0
      ['😀'.repeat(5) + '。他大步流星地走了过去。', 8], // 零窗句 + 正常句：total 只计正常句
      ['他大步流星地走了过去😀。', 1], // n=1：多项式幂预计算的退化边界（B^0=1）
      ['完全不同的三句话。彼此毫无重复。各自独立成句。', 2],
      ['夜风掀动窗纸。他把信折好收进袖中，吹熄了灯。', 16], // 全部句长 <16 → total=0
    ]
    for (const [body, n] of edges) expectEquivalent(body, n)
    // 码点不足句单独成体时四字段全零（rate 分母为 0 走 0 兜底）
    expect(ngramRepeatRate('😀'.repeat(5) + '。', 8)).toEqual({
      rate: 0,
      total: 0,
      repeatInstances: 0,
      repeatChars: 0,
    })
  })

  it('n=2 与 n=16 边界：中文/astral 语料上四字段逐位相等', () => {
    resetSeed(0x71f3a9)
    const zh = buildChineseCorpus(8_000)
    resetSeed(0x1c9b2e)
    const astral = buildAstralCorpus(4_000)
    for (const corpus of [zh, astral]) {
      for (const n of [2, 16]) {
        const got = expectEquivalent(corpus, n)
        expect(got.total).toBeGreaterThan(0)
      }
    }
  })

  it('高重复计数：「哈」×5000 单句并桶（1 个 distinct gram × 4993 窗）', () => {
    const body = '哈'.repeat(5000)
    const got = expectEquivalent(body, 8)
    // 闭-form：5000-8+1=4993 窗全同 gram → count=4993，repeatInstances=4992
    expect(got.total).toBe(4993)
    expect(got.repeatInstances).toBe(4992)
    expect(got.repeatChars).toBe(4992 * 8)
    // 多句切分变体（跨句高计数聚合）+ astral 高重复（emoji ×3000）
    expectEquivalent(('哈哈'.repeat(50) + '。').repeat(50), 8)
    expectEquivalent('😀'.repeat(3000) + '。' + '😀'.repeat(2000) + '。', 8)
  })

  it('随机模糊：混合字母表（含孤立代理/零宽/astral）× n∈{1,2,8,16} × 300 轮全等', () => {
    resetSeed(0x4b7e21)
    const alphabet = [
      '字', '的', '了', '，', '。', '！', '？', '…', '；', '\n', 'a', 'Z', '0', ' ', '　',
      '😀', '😂', '𠮷', '𠀀', '𝓐', '\uD800', '\uDC00', // astral 与孤立代理
      '​', '‍', // ZWSP(200b) / ZWJ(200d)——非空白、不切句，进 gram
    ]
    const ns = [1, 2, 8, 16]
    for (let round = 0; round < 300; round++) {
      const len = 1 + Math.floor(rand() * 300)
      let s = ''
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rand() * alphabet.length)]
      const n = ns[Math.floor(rand() * ns.length)]!
      const got = ngramRepeatRate(s, n)
      const want = referenceNgramRepeatRate(s, n)
      if (
        got.total !== want.total ||
        got.repeatInstances !== want.repeatInstances ||
        got.repeatChars !== want.repeatChars ||
        got.rate !== want.rate
      ) {
        throw new Error(
          `round ${round}（n=${n}）不等：got=${JSON.stringify(got)} want=${JSON.stringify(want)} slice=${JSON.stringify(s.slice(0, 80))}`,
        )
      }
    }
  })
})

// 墙钟类用例受管理 flaky 面（同 test/check/scale.test.ts 口径）：describe 级 retry:2，
// 抖动自动重跑；真退化（复杂度劣化）稳定越界连败仍红，可捕性不变。
describe('ngramRepeatRate 数值哈希键性能烟雾（PM-7）', { retry: 2 }, () => {
  it('5 万字中文语料：新实现耗时低于字符串键参照（min-of-3 取最小防抖动）', () => {
    resetSeed(0x2f6e2b1) // 与等价性用例同种子同语料，先证同体再比时
    const corpus = buildChineseCorpus(50_000)
    expect(ngramRepeatRate(corpus).repeatInstances).toBe(
      referenceNgramRepeatRate(corpus).repeatInstances,
    )
    const run = (fn: () => unknown) => {
      const t0 = performance.now()
      fn()
      return performance.now() - t0
    }
    // 先跑参照 3 次（顺带预热 JIT），再跑新实现 3 次，各取最小
    const refMs = Math.min(...[0, 1, 2].map(() => run(() => referenceNgramRepeatRate(corpus))))
    const newMs = Math.min(...[0, 1, 2].map(() => run(() => ngramRepeatRate(corpus))))
    console.log(
      `[pm7-perf] 5万字中文｜字符串键参照 ${refMs.toFixed(1)}ms｜数值哈希新实现 ${newMs.toFixed(1)}ms（${(refMs / newMs).toFixed(1)}×）`,
    )
    // 宽松下界断言：只要新实现不慢于参照即过（真实收益在内存峰值——键从
    // 每窗一字符串坍缩为 ≤2^53 整数；耗时通常另有 2-4× 加速，见日志）
    expect(newMs).toBeLessThan(refMs)
  })
})
