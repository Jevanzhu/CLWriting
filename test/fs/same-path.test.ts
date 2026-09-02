/**
 * R1W-7（win 平台专项复审 R1）：samePath 路径同一性原语单测。
 *
 * win32 大小写不敏感（双侧 toLowerCase）；posix 全等。mockPlatform 双臂覆盖——
 * 本机真实平台只占其一，另一臂经 Object.defineProperty(process,'platform') 注入
 * （user-data-path.test.ts 既有范式）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { samePath } from '../../src/fs/user-data-path.js'

const ORIG_PLATFORM = process.platform

function mockPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

afterEach(() => {
  mockPlatform(ORIG_PLATFORM)
})

describe('samePath（R1W-7）', () => {
  it('win32 臂：大小写/盘符漂移判同；不同路径判异', () => {
    mockPlatform('win32')
    expect(samePath('C:\\Lib\\MyBook', 'c:\\lib\\mybook')).toBe(true)
    expect(samePath('C:\\Lib\\MyBook', 'C:\\Lib\\MYBOOK')).toBe(true)
    expect(samePath('C:\\Lib\\MyBook', 'C:\\Lib\\Other')).toBe(false)
    expect(samePath('C:\\Lib', 'C:\\Lib\\MyBook')).toBe(false)
  })

  it('posix 臂：严格全等（大小写敏感语义保持）', () => {
    mockPlatform('linux')
    expect(samePath('/a/B', '/a/B')).toBe(true)
    expect(samePath('/a/B', '/a/b')).toBe(false)
  })
})
