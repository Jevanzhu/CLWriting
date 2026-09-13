/**
 * R1W-7（win 平台专项复审 R1）：samePath 路径同一性原语单测。
 *
 * win32 大小写不敏感（双侧 toLowerCase）；linux 全等；darwin 折叠 + NFC 归一
 * （R51-D-2 / 复审-0913-mac适配 P3-3）。mockPlatform 三臂覆盖——本机真实平台只占
 * 其一，另两臂经 Object.defineProperty(process,'platform') 注入
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
  it('win32 臂：大小写/盘符漂移判同；不同路径判异；NFC/NFD 异形是不同文件（NTFS 敏感）', () => {
    mockPlatform('win32')
    expect(samePath('C:\\Lib\\MyBook', 'c:\\lib\\mybook')).toBe(true)
    expect(samePath('C:\\Lib\\MyBook', 'C:\\Lib\\MYBOOK')).toBe(true)
    expect(samePath('C:\\Lib\\MyBook', 'C:\\Lib\\Other')).toBe(false)
    expect(samePath('C:\\Lib', 'C:\\Lib\\MyBook')).toBe(false)
    // 复审-0913-mac适配 P3-3：win 不做 NFC 折叠——分解形/合成形在 NTFS 是不同文件
    const nfc = 'C:\\Lib\\Étude'
    const nfd = 'C:\\Lib\\E\u0301tude'
    expect(nfd).not.toBe(nfc)
    expect(samePath(nfc, nfd)).toBe(false)
  })

  it('posix 臂：严格全等（大小写敏感语义保持）', () => {
    mockPlatform('linux')
    expect(samePath('/a/B', '/a/B')).toBe(true)
    expect(samePath('/a/B', '/a/b')).toBe(false)
    expect(samePath('/a/É', '/a/E\u0301')).toBe(false)
  })

  it('darwin 臂：NFC/NFD 异形判同（APFS 惯存 NFD）+ 大小写折叠；异名判异（复审-0913-mac适配 P3-3）', () => {
    mockPlatform('darwin')
    const nfc = '/Lib/Étude'
    const nfd = '/Lib/E\u0301tude'
    expect(nfd).not.toBe(nfc)
    expect(samePath(nfc, nfd)).toBe(true)
    expect(samePath('/Lib/MyBook', '/lib/mybook')).toBe(true)
    expect(samePath('/Lib/MyBook', '/Lib/Other')).toBe(false)
    expect(samePath('/Lib', '/Lib/MyBook')).toBe(false)
  })
})
