/**
 * R1W-5（win 平台专项复审 R1）：保留设备名判定补「带扩展名形态」。
 *
 * 「CON.md」「aux.txt」与裸名同为 win 保留设备名（CreateDirectoryW 报
 * ERROR_INVALID_NAME），判定取首段后与 format/filename.ts winCompatNamePart
 * 单一真相源口径对齐；CLOCK$ 随之补齐。合法名（同前缀非保留名 / 普通中文名）
 * 不受误伤。
 */
import { describe, expect, it } from 'vitest'
import { isInvalidBookName } from '../../src/install/books.js'

describe('isInvalidBookName 保留名带扩展名形态（R1W-5）', () => {
  it('保留名 + 扩展名（任意大小写）→ 拒绝', () => {
    expect(isInvalidBookName('CON.md')).toBe(true)
    expect(isInvalidBookName('aux.txt')).toBe(true)
    expect(isInvalidBookName('Nul.异世界')).toBe(true)
    expect(isInvalidBookName('com1')).toBe(true)
    expect(isInvalidBookName('LPT3.旧稿')).toBe(true)
    expect(isInvalidBookName('CLOCK$.md')).toBe(true)
  })

  it('保留名 + 尾点/尾空格形态 → 拒绝（既有口径保持）', () => {
    expect(isInvalidBookName('CON.')).toBe(true)
    expect(isInvalidBookName('NUL ')).toBe(true)
  })

  it('同前缀非保留名与普通名 → 放行（不误伤）', () => {
    expect(isInvalidBookName('conan.md')).toBe(false)
    expect(isInvalidBookName('COM10')).toBe(false)
    expect(isInvalidBookName('auxiliary')).toBe(false)
    expect(isInvalidBookName('我的书')).toBe(false)
  })
})
