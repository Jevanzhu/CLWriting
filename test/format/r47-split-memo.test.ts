/**
 * R47-4（四十七轮）：splitFrontMatter 2-slot 引用 memo 回归。
 *
 * 语义锚：① 纯函数语义不变（有 fm / 无 fm / 未闭合 fm 三态与逐字提取不变）；
 * ② 同值命中返回等价结果（含 null 结果缓存）；③ 轮转覆盖后旧 slot 内容重新计算
 * 仍正确（2-slot 有界，无陈旧串扰）；④ 长度预过滤（同长不同串不误命中）。
 */
import { describe, it, expect } from 'vitest'
import { splitFrontMatter } from '../../src/format/frontmatter-core.js'

const DOC = `---\n章号: 12\n标题: 雪\n---\n\n北境的雪落了三天。`
const DOC2 = `---\n章号: 13\n---\n\n另一章。` // 同为合法 fm、长度不同
const SAME_LEN_NO_FM = '--- 分隔线不是 fm --- 正文开头' // 与 DOC 等长不保证，只要求不误命中

describe('R47-4：splitFrontMatter 2-slot memo', () => {
  it('纯函数语义不变：有 fm 提取逐字正确', () => {
    expect(splitFrontMatter(DOC)).toEqual({ fmRaw: '章号: 12\n标题: 雪', body: '\n北境的雪落了三天。' })
  })

  it('无 fm / 未闭合 fm → null（memo 缓存 null 结果同样正确）', () => {
    expect(splitFrontMatter('普通正文，无 fm')).toBeNull()
    expect(splitFrontMatter('普通正文，无 fm')).toBeNull() // null 也走缓存路径
    expect(splitFrontMatter('---\n章号: 1\n未闭合')).toBeNull()
  })

  it('同值重复调用返回等价结果（值等价命中）', () => {
    const a = splitFrontMatter(DOC)
    const b = splitFrontMatter(`${DOC}`) // 新字符串字面量（可能不同引用）
    expect(b).toEqual(a)
  })

  it('轮转覆盖（>2 个不同输入交替）后旧输入重算仍正确', () => {
    expect(splitFrontMatter(DOC)).not.toBeNull()
    expect(splitFrontMatter(DOC2)).toEqual({ fmRaw: '章号: 13', body: '\n另一章。' })
    expect(splitFrontMatter('第三段内容完全不同，无 fm')).toBeNull()
    // DOC 已被轮转淘汰 → 重算路径，结果仍逐字正确
    expect(splitFrontMatter(DOC)).toEqual({ fmRaw: '章号: 12\n标题: 雪', body: '\n北境的雪落了三天。' })
  })

  it('长度预过滤不误命中：同长不同串各自正确', () => {
    const s1 = `---\nA: 1\n---\n\nx`
    const s2 = `---\nB: 2\n---\n\ny`
    expect(splitFrontMatter(s1)).toEqual({ fmRaw: 'A: 1', body: '\nx' })
    expect(splitFrontMatter(s2)).toEqual({ fmRaw: 'B: 2', body: '\ny' })
    expect(splitFrontMatter(s1)).toEqual({ fmRaw: 'A: 1', body: '\nx' })
    void SAME_LEN_NO_FM
  })
})
