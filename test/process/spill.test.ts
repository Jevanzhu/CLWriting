/**
 * spill 低配（批次 B3 / DSH-2）单测：
 * - ≤阈值原引用透传（无外置、无副本）
 * - 超阈值：头尾预览 + 通知行（省略量 / locator / 取回指引），全文落盘幂等
 * - 预算纪律：预览总长 ≤ maxInlineChars（砍头砍尾收敛）
 * - best-effort：落盘失败回退原文
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spillIfLarge, writeSpillFile, type SpillThresholds } from '../../src/process/spill.js'

const T: SpillThresholds = { maxInlineChars: 2000, headChars: 1200, tailChars: 400 }

describe('spillIfLarge', () => {
  it('≤阈值：原引用透传（toBe 同一字符串，无 locator）', () => {
    const text = '短内容'
    const out = spillIfLarge(text, T, () => {
      throw new Error('不应触发落盘')
    })
    expect(out.preview).toBe(text)
    expect(out.locator).toBeUndefined()
  })

  it('超阈值：头尾预览 + 通知行（省略量/locator/read_chapter 指引），预览 ≤ 预算', () => {
    const head = '头'.repeat(1500)
    const mid = '中'.repeat(2000)
    const tail = '尾'.repeat(500)
    const text = head + mid + tail
    const out = spillIfLarge(text, T, () => '工作区/spills/abc0123456789def.md')
    expect(out.locator).toBe('工作区/spills/abc0123456789def.md')
    expect(out.preview.startsWith('头'.repeat(1200))).toBe(true) // 1200+400+通知行 ≈ 1681 ≤ 2000，无需砍预算
    expect(out.preview.endsWith('尾'.repeat(400))).toBe(true)
    expect(out.preview).toContain('已省略')
    expect(out.preview).toContain('工作区/spills/abc0123456789def.md')
    expect(out.preview).toContain('read_chapter')
    expect(Array.from(out.preview).length).toBeLessThanOrEqual(T.maxInlineChars)
    // 中段不进预览
    expect(out.preview).not.toContain('中')
  })

  it('预算纪律：极小预算迫使砍头砍尾，预览仍 ≤ maxInlineChars（floor 收敛）', () => {
    const text = '甲'.repeat(3000)
    const tight: SpillThresholds = { maxInlineChars: 300, headChars: 1200, tailChars: 400 }
    const out = spillIfLarge(text, tight, () => '工作区/spills/x.md')
    expect(Array.from(out.preview).length).toBeLessThanOrEqual(300)
    expect(out.preview).toContain('工作区/spills/x.md')
  })

  it('预算装不下通知行（配置错误）：回退原文 best-effort', () => {
    const text = '乙'.repeat(100)
    const broken: SpillThresholds = { maxInlineChars: 5, headChars: 2, tailChars: 1 }
    const out = spillIfLarge(text, broken, () => '工作区/spills/y.md')
    expect(out.preview).toBe(text)
    expect(out.locator).toBeUndefined()
  })

  it('落盘失败（writeSpill 返回 null）：原文透传，绝不把成功调用变失败', () => {
    const text = '丙'.repeat(2500)
    const out = spillIfLarge(text, T, () => null)
    expect(out.preview).toBe(text)
    expect(out.locator).toBeUndefined()
  })

  it('code point 度量：emoji 按 1 计（Array.from，不按 UTF-16 单元）', () => {
    const emoji = '😀'.repeat(2100) // UTF-16 长度 4200，code point 2100
    const out = spillIfLarge(emoji, { maxInlineChars: 2000, headChars: 1000, tailChars: 300 }, () => '工作区/spills/e.md')
    expect(out.locator).toBeDefined()
    // 触发了外置（若按 UTF-16 计会因 4200>2000 同样触发，但省略量按 code point 计）
    expect(out.preview).toContain('已省略')
  })
})

describe('writeSpillFile', () => {
  it('落到 工作区/spills/<sha256 前 16>.md，同内容幂等（同 locator 同内容重写）', () => {
    const root = mkdtempSync(join(tmpdir(), 'clwriting-spill-'))
    try {
      const text = '全文内容' + 'z'.repeat(3000)
      const loc1 = writeSpillFile(root, text)
      const loc2 = writeSpillFile(root, text)
      expect(loc1).toBe(loc2)
      expect(loc1).toMatch(/^工作区\/spills\/[0-9a-f]{16}\.md$/)
      const fp = join(root, loc1!)
      expect(existsSync(fp)).toBe(true)
      expect(readFileSync(fp, 'utf8')).toBe(text) // 落盘的是全文，不是预览
      // 不同内容 → 不同哈希文件
      const other = writeSpillFile(root, text + '!')
      expect(other).not.toBe(loc1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('目录已存在（第二次写不同内容）不报错；父路径为文件时返回 null（best-effort）', () => {
    const root = mkdtempSync(join(tmpdir(), 'clwriting-spill2-'))
    try {
      expect(writeSpillFile(root, 'aaaa'.repeat(600))).toMatch(/^工作区\/spills\//)
      expect(writeSpillFile(root, 'bbbb'.repeat(600))).toMatch(/^工作区\/spills\//)
      // 工作区 是普通文件 → mkdir 失败 → null
      const root2 = mkdtempSync(join(tmpdir(), 'clwriting-spill3-'))
      try {
        writeFileSync(join(root2, '工作区'), 'blocker')
        expect(writeSpillFile(root2, 'cccc'.repeat(600))).toBeNull()
      } finally {
        rmSync(root2, { recursive: true, force: true })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
