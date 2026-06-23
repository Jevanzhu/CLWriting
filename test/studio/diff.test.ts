/**
 * lineDiff 行级 LCS 测试(横切 P0):验证改写 diff 的正确性。
 * lineDiff 在 rewrite.ts(2.5 改写核心),LCS 对齐 same/add/del。
 */
import { describe, it, expect } from 'vitest'
import { lineDiff } from '../../src/studio/server/api/rewrite.js'

describe('lineDiff(行级 LCS)', () => {
  it('相同文本 → 全 same', () => {
    const d = lineDiff('a\nb\nc', 'a\nb\nc')
    expect(d.length).toBe(3)
    expect(d.every((l) => l.type === 'same')).toBe(true)
  })

  it('末尾追加一行', () => {
    const d = lineDiff('a\nb', 'a\nb\nc')
    expect(d.filter((l) => l.type === 'add')).toEqual([{ type: 'add', text: 'c' }])
    expect(d.filter((l) => l.type === 'del')).toEqual([])
  })

  it('中间插入一行', () => {
    const d = lineDiff('a\nc', 'a\nb\nc')
    expect(d.filter((l) => l.type === 'add')).toEqual([{ type: 'add', text: 'b' }])
  })

  it('删除一行', () => {
    const d = lineDiff('a\nb\nc', 'a\nc')
    expect(d.filter((l) => l.type === 'del')).toEqual([{ type: 'del', text: 'b' }])
    expect(d.filter((l) => l.type === 'add')).toEqual([])
  })

  it('修改一行 → del 旧 + add 新', () => {
    const d = lineDiff('a\nold\nc', 'a\nnew\nc')
    expect(d.some((l) => l.type === 'del' && l.text === 'old')).toBe(true)
    expect(d.some((l) => l.type === 'add' && l.text === 'new')).toBe(true)
    expect(d.filter((l) => l.type === 'same').map((l) => l.text)).toEqual(['a', 'c'])
  })

  it('顺序无关:多行变更各标对', () => {
    const d = lineDiff('a\nb\nc', 'a\nB\nc\nD')
    const addTexts = d.filter((l) => l.type === 'add').map((l) => l.text)
    const delTexts = d.filter((l) => l.type === 'del').map((l) => l.text)
    expect(delTexts).toEqual(['b'])
    expect(addTexts).toEqual(['B', 'D'])
  })
})
