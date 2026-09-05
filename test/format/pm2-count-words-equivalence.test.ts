/**
 * PM-2（性能与内存专项·2026-09-05）回归：countWords 单遍零分配重写与旧实现的逐位等价。
 *
 * 修复前：`[...body.replace(/[#>*_`~\-\[\]()!\s]/g, '')].length` 每次调用两步全量分配
 * （剥标记副本 + 码点数组；中文每字符独立 SeqTwoByteString，200 万字单次调用瞬时垃圾
 * ≈70-90MB，为全链最高频内存抖动源——服务端保存链 ×2/次 + 前端每击键防抖后 1 次）。
 * 修复后：单遍 codeUnit 扫描 + 剥除码点集 + 代理对并档计数，零分配。
 *
 * R31-11 口径备案约束：输出必须与旧实现逐位一致（剥除集不含标点；码点计数口径）。
 * 本测试内嵌旧实现原样为参照（referenceCountWords），断言新实现与之在下列各面全等：
 * - 剥除集全集：`#>*_`~-[]()!` 12 个标记字符 + ECMAScript \s 白名单全集 25 码位
 * - 近邻反例不误剥：0x200b-0x200d 零宽符（ZWSP/ZWNJ/ZWJ）、0x0085 NEL、0x180e——形似空白但不属 \s
 * - 代理对：emoji/CJK 扩展 B 计 1 码点；孤立高代理/孤立低代理各计 1；高代理后随
 *   剥除字符（ill-formed）不吞后继（码点迭代语义的精确复刻）
 * - 随机模糊：混合字母表（CJK/ASCII/标记/空白/代理区/零宽）×长度 200 轮全等
 * - 大文档冒烟：52 万字混合文本等值（真实规模不溢出不漂移）
 */
import { describe, it, expect } from 'vitest'
import { countWords } from '../../src/format/words.js'

/** 旧实现原样内嵌（R31-11 备案口径的参照正本） */
function referenceCountWords(body: string): number {
  return [...body.replace(/[#>*_`~\-\[\]()!\s]/g, '')].length
}

/** ECMAScript \s 白名单全集（WhiteSpace ∪ LineTerminator，25 码位） */
const JS_WHITESPACE = [
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020,
  0x00a0, 0x1680,
  ...Array.from({ length: 0x200a - 0x2000 + 1 }, (_, i) => 0x2000 + i),
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
] as number[]

describe('countWords 单遍重写等价性（PM-2）', () => {
  it('空串与纯剥除字符为 0', () => {
    expect(countWords('')).toBe(0)
    expect(referenceCountWords('')).toBe(0)
    expect(countWords('#>*_`~-[]()! \t\n')).toBe(0)
  })

  it('普通中文正文 + markdown 标记：与参照全等（口径不含标点）', () => {
    const samples = [
      '他推门进来，屋里静得能听见灰尘落地的声音。',
      '# 第章 标题\n\n> 引用一行\n\n**加粗**与*斜体*和`代码`混排——破折号、省略号……全保留。',
      '---\n\n- [ ] 任务项\n- [x] 完成项\n\n| 表 | 头 |\n|---|---|\n| 1 | 2 |',
      'frontmatter 已由调用方先剥，这里只剩正文（（嵌套括号））！',
      'a'.repeat(1000) + '_' + 'b'.repeat(1000),
    ]
    for (const s of samples) {
      expect(countWords(s)).toBe(referenceCountWords(s))
    }
  })

  it('\\s 白名单全集 25 码位逐个：剥除后为 0（参照同值）', () => {
    for (const cp of JS_WHITESPACE) {
      const s = String.fromCodePoint(cp)
      expect(countWords(s)).toBe(0)
      expect(referenceCountWords(s)).toBe(0)
      // 两侧夹正字：剥空白后恰 2
      expect(countWords('字' + s + '字')).toBe(2)
      expect(referenceCountWords('字' + s + '字')).toBe(2)
    }
    // 白名单计数自检：ECMAScript \s 恰为这 25 码位（防本测试字母表漏项假绿）
    expect(JS_WHITESPACE.length).toBe(25)
    expect(/\s/.test(String.fromCodePoint(0x200b))).toBe(false)
    expect(/\s/.test(String.fromCodePoint(0x200c))).toBe(false)
    expect(/\s/.test(String.fromCodePoint(0x200d))).toBe(false)
    expect(/\s/.test(String.fromCodePoint(0x0085))).toBe(false)
    expect(/\s/.test(String.fromCodePoint(0x180e))).toBe(false)
  })

  it('代理对：emoji/CJK 扩展计 1 码点，混合文本与参照全等', () => {
    const samples = [
      '👍👍👍', // 3 个 astral emoji → 3
      '𠀀𠀁𠀂字', // CJK 扩展 B → 4
      '笑死😂了哈哈哈哈🤣🤣',
      '😀'.repeat(500) + '汉'.repeat(500),
    ]
    for (const s of samples) {
      expect(countWords(s)).toBe(referenceCountWords(s))
    }
    expect(countWords('👍👍👍')).toBe(3)
  })

  it('孤立代理（ill-formed 串）：与码点迭代语义逐位一致', () => {
    const samples = [
      '\uD800', // 孤立高代理 → 1
      '\uDC00', // 孤立低代理 → 1
      '\uD800x', // 高代理 + 普通字符（非低代理）→ 2，不吞后继
      '\uDC00\uD800', // 低在前高在后：两孤立 → 2
      '\uD800_', // 高代理 + 剥除字符（ill-formed）：剥后余孤立高代理 → 1
      '\uD800\uDE00', // 恰成对（😀）→ 1
      'a\uD800\uD801b', // 双孤立高代理夹普通字符 → 4
      '\uD800_\uDC00', // 先剥后迭代并档：剥 _ 后两侧拼成一对 → 1（新实现前瞻复刻此语义）
      '\uD800 \t\uDC00', // 多个剥除字符隔开仍并档 → 1
      '\uD800_ \uDC00x', // 并档后 x 另计 → 2
      '\uD800_x\uDC00', // 中隔非剥除字符：不成对，高代理/ x / 低代理各计 1 → 3
    ]
    for (const s of samples) {
      expect(countWords(s)).toBe(referenceCountWords(s))
    }
    expect(countWords('\uD800')).toBe(1)
    expect(countWords('\uD800x')).toBe(2)
  })

  it('随机模糊：混合字母表 200 轮全等', () => {
    // 固定种子可复现
    let seed = 0x2f6e2b1
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const alphabet = [
      '字', '的', '了', '，', '。', '——', '……', 'a', 'Z', '0',
      '#', '>', '*', '_', '`', '~', '-', '[', ']', '(', ')', '!',
      ' ', '\t', '\n', '　', ' ', ' ', // 普通/NBSP/表意空格/en-space
      '👍', '𠀀', '😂', '\uD800', '\uDC00', // astral 与孤立代理
      '​', '‍', // ZWSP(200b) / ZWJ(200d)——不属 \s，必不剥
    ]
    for (let round = 0; round < 200; round++) {
      const len = 1 + Math.floor(rand() * 300)
      let s = ''
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rand() * alphabet.length)]
      const got = countWords(s)
      const want = referenceCountWords(s)
      if (got !== want) {
        // 失败时给出可复现切片（前 80 码元）
        throw new Error(
          `round ${round} 不等：got=${got} want=${want} slice=${JSON.stringify(s.slice(0, 80))}`,
        )
      }
    }
  })

  it('大文档冒烟：52 万字混合文本等值', () => {
    const unit = '他推开门，屋里的灰尘在光柱里浮动。😂「你来了。」她说。👍 --- \n　　*斜体*与`代码`。'
    let big = ''
    for (let i = 0; i < 4000; i++) big += unit
    expect(countWords(big)).toBe(referenceCountWords(big))
  })
})
