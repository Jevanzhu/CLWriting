/**
 * 规范形原语单测（平台规范化批一，2026-09-03）：src/fs/text-canonical.ts。
 *
 * canonicalizeText = 剥前导 BOM + \r\n/孤立 \r 归一 LF；bufferNeedsCanonical =
 * 字节级幂等探测（v4 迁移用）；isNfcName/toNfcName = 文件名 NFC 归一薄封装。
 */
import { describe, expect, it } from 'vitest'
import { bufferNeedsCanonical, canonicalizeText, isNfcName, toNfcName } from '../../src/fs/text-canonical.js'

describe('canonicalizeText', () => {
  it('CRLF → LF', () => {
    expect(canonicalizeText('a\r\nb\r\nc')).toBe('a\nb\nc')
  })

  it('孤立 \\r（旧 mac 形态）→ LF', () => {
    expect(canonicalizeText('a\rb\rc')).toBe('a\nb\nc')
  })

  it('混排行尾（CRLF 与孤立 \\r 并存）全归一', () => {
    expect(canonicalizeText('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
  })

  it('剥前导 BOM；串中部 BOM 不是前导、保留（归一不越权改内容）', () => {
    expect(canonicalizeText('\uFEFF正文')).toBe('正文')
    expect(canonicalizeText('a\uFEFFb')).toBe('a\uFEFFb')
  })

  it('BOM + CRLF 复合形态一次归一干净', () => {
    expect(canonicalizeText('\uFEFF# 标题\r\n\r\n正文。\r\n')).toBe('# 标题\n\n正文。\n')
  })

  it('规范形文本零改动（幂等）', () => {
    const clean = '# 标题\n\n正文。\n'
    expect(canonicalizeText(clean)).toBe(clean)
  })

  it('空串/纯换行边界', () => {
    expect(canonicalizeText('')).toBe('')
    expect(canonicalizeText('\r\n')).toBe('\n')
    expect(canonicalizeText('\uFEFF')).toBe('')
  })
})

describe('bufferNeedsCanonical（字节级探测，v4 幂等闸）', () => {
  it('BOM 字节（EF BB BF 前导）→ true', () => {
    expect(bufferNeedsCanonical(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toBe(true)
  })

  it('任意位置含 0x0D（CR 字节）→ true', () => {
    expect(bufferNeedsCanonical(Buffer.from('a\r\nb', 'utf-8'))).toBe(true)
    expect(bufferNeedsCanonical(Buffer.from('a\rb', 'utf-8'))).toBe(true)
  })

  it('规范形字节（无 BOM 无 CR）→ false；空 Buffer → false', () => {
    expect(bufferNeedsCanonical(Buffer.from('a\nb\n', 'utf-8'))).toBe(false)
    expect(bufferNeedsCanonical(Buffer.alloc(0))).toBe(false)
  })

  it('非前导 BOM 字节序列不误报（EF BB BF 出现在串中非首三位）', () => {
    expect(bufferNeedsCanonical(Buffer.from([0x61, 0xef, 0xbb, 0xbf]))).toBe(false)
  })
})

describe('isNfcName / toNfcName', () => {
  it('NFC 名 isNfcName=true；NFD 名 false；toNfcName 归一', () => {
    const nfc = '가'
    const nfd = nfc.normalize('NFD')
    expect(nfd).not.toBe(nfc)
    expect(isNfcName(nfc)).toBe(true)
    expect(isNfcName(nfd)).toBe(false)
    expect(toNfcName(nfd)).toBe(nfc)
    expect(isNfcName(toNfcName(nfd))).toBe(true)
  })

  it('纯 ASCII 名恒 NFC', () => {
    expect(isNfcName('abc-1.md')).toBe(true)
    expect(toNfcName('abc-1.md')).toBe('abc-1.md')
  })
})
