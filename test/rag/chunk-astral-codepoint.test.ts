/**
 * R0916-6-P3-6（2026-09-16 评审修复批）：RAG 分块长度码点口径回归。
 * pushSegmentChunks 的 <20 成块下限 / ≤MAX_CHUNK_CHARS(1000) 上限原按 UTF-16 .length
 * 计——增补平面字符（𝄞 U+1D11E 等）一符计 2 被虚高：恰 1000 码点的段被误细分、
 * 不足 20 码点的短段被误保留。现收编 shared/text.ts codePointLength 单源。
 */
import { describe, it, expect } from 'vitest'
import { chunkBody } from '../../src/rag/chunk.js'
import { codePointLength } from '../../src/shared/text.js'

const MUSIC = '𝄞' // U+1D11E 音乐 G 谱号（增补平面，UTF-16 计 2 码元）

describe('R0916-6-P3-6: 分块长度码点口径（增补平面边界）', () => {
  it('恰 1000 码点含 astral 的段 → 单块不细分（原 UTF-16 口径 1500 码元会误细分）', () => {
    const seg = MUSIC.repeat(500) + '字'.repeat(500) // 1000 码点 = 1500 码元
    const chunks = chunkBody(seg)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.text).toBe(seg)
    expect(codePointLength(chunks[0]!.text)).toBe(1000)
    // start/end 仍为原文 UTF-16 偏移（召回→精准读取契约按 JS 串下标）
    expect(chunks[0]!.start).toBe(0)
    expect(chunks[0]!.end).toBe(seg.length)
  })

  it('恰 20 码点含 astral 的段成块；19 码点被滤（<20 下限按码点计，原码元口径误保留）', () => {
    const exactly20 = MUSIC.repeat(10) + '字'.repeat(10) // 20 码点 = 30 码元
    expect(chunkBody(exactly20)).toHaveLength(1)
    const nineteen = MUSIC.repeat(15) + '字'.repeat(4) // 19 码点 = 34 码元
    expect(chunkBody(nineteen)).toHaveLength(0)
  })

  it('超 1000 码点含 astral 的段细分：子块按码点 ≤ 上限且不劈开代理对', () => {
    const seg = MUSIC.repeat(600) + '字'.repeat(401) // 1001 码点 = 1601 码元
    const chunks = chunkBody(seg)
    expect(chunks.length).toBeGreaterThan(1)
    let totalCp = 0
    const loneHigh = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/
    const loneLow = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    for (const c of chunks) {
      expect(codePointLength(c.text)).toBeLessThanOrEqual(1000)
      expect(loneHigh.test(c.text)).toBe(false)
      expect(loneLow.test(c.text)).toBe(false)
      totalCp += codePointLength(c.text)
    }
    // 切分无损（段内无空白，trim 恒等）
    expect(totalCp).toBe(1001)
  })

  it('BMP 常规段行为零变化：恰 1000 字单块、1500 字细分两块', () => {
    expect(chunkBody('好'.repeat(1000))).toHaveLength(1)
    expect(chunkBody('好'.repeat(1500))).toHaveLength(2)
  })
})
