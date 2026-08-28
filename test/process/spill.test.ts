/**
 * spill 低配（批次 B3 / DSH-2）单测：
 * - ≤阈值原引用透传（无外置、无副本）
 * - 超阈值：头尾预览 + 通知行（省略量 / locator / 取回指引），全文落盘幂等
 * - 预算纪律：预览总长 ≤ maxInlineChars（砍头砍尾收敛）
 * - best-effort：落盘失败回退原文
 * - readSpillFile（GG-P2-2 读侧）：locator 形状白名单 + isWithinRoot 双保险，按路径取回全文
 */
import { describe, it, expect } from 'vitest'
import { rmSync, readFileSync, existsSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spillIfLarge, writeSpillFile, readSpillFile, readSpillMeta, type SpillThresholds } from '../../src/process/spill.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

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
    const root = mkdtempTracked(join(tmpdir(), 'clwriting-spill-'))
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
    const root = mkdtempTracked(join(tmpdir(), 'clwriting-spill2-'))
    try {
      expect(writeSpillFile(root, 'aaaa'.repeat(600))).toMatch(/^工作区\/spills\//)
      expect(writeSpillFile(root, 'bbbb'.repeat(600))).toMatch(/^工作区\/spills\//)
      // 工作区 是普通文件 → mkdir 失败 → null
      const root2 = mkdtempTracked(join(tmpdir(), 'clwriting-spill3-'))
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

describe('readSpillFile', () => {
  it('writeSpillFile 的 locator 可取回全文（写读同源），不存在的文件返回 null', () => {
    const root = mkdtempTracked(join(tmpdir(), 'clwriting-spill-read-'))
    try {
      const text = '改写稿全文' + 'q'.repeat(2500)
      const locator = writeSpillFile(root, text)!
      expect(readSpillFile(root, locator)).toBe(text)
      // 形状合法但文件不存在（哈希对不上任何产物）
      expect(readSpillFile(root, '工作区/spills/0000000000000000.md')).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('locator 形状白名单：穿越 / 绝对路径 / 缺段 / 非 hex / 非 md 一律 null（不碰盘）', () => {
    const root = mkdtempTracked(join(tmpdir(), 'clwriting-spill-badloc-'))
    try {
      // 预埋可被穿越命中的真实文件，验证校验在任何读盘之前拦下
      writeFileSync(join(root, 'book.yaml'), 'book:')
      const bad = [
        '工作区/spills/../../book.yaml',
        '/etc/passwd',
        '工作区/spills/abc.md',
        '工作区/spills/zzzzzzzzzzzzzzzz.md', // 非 hex
        '工作区/spills/0123456789abcdef.txt',
        '工作区/spill/0123456789abcdef.md',
        '',
      ]
      for (const loc of bad) expect(readSpillFile(root, loc)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('spills 下越出书库的路径（isWithinRoot 兜底）：null', () => {
    const root = mkdtempTracked(join(tmpdir(), 'clwriting-spill-within-'))
    try {
      // 正则已拦 .. ；isWithinRoot 是对 join 语义的双保险——形状合法但根外场景由该层兜住
      expect(readSpillFile(root, '工作区/spills/feedfacefeedface.md')).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('L-P8（第八轮）：spills 过期清理', () => {
  it('30 天前的旧 spill 被清，新 spill 保留', () => {
    const root = mkdtempTracked(join(tmpdir(), 'clwriting-spill-gc-'))
    try {
      writeSpillFile(root, '新内容')
      const dir = join(root, '工作区', 'spills')
      // 造一个 40 天前的旧 spill（直接写文件 + 回拨 mtime）
      const old = join(dir, 'deadbeefdeadbeef.md')
      writeFileSync(old, '旧内容')
      const past = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
      utimesSync(old, past, past)
      // 再写一次触发 GC
      writeSpillFile(root, '又一次新内容')
      expect(existsSync(old)).toBe(false)
      expect(existsSync(join(dir, `${createHash('sha256').update('新内容', 'utf8').digest('hex').slice(0, 16)}.md`))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── A6（五十九轮）：rewrite spill locator 哈希并入章号+基线 sha ──────────────────
// 修复背景：spill 原纯内容寻址，两次改写产出相同正文时第二次顶替同名 sidecar meta，
// 先前确认通道凭空失效（apply_spill fail-closed 拒绝）。并入 meta 后不同基线的同文
// spill 各得独立 locator；读侧按 locator 直读文件与 sidecar，不重算哈希，天然兼容。
describe('A6（五十九轮）：writeSpillFile locator 并入 meta（章号+基线 sha）', () => {
  it('同正文不同基线 → 独立 locator 两份 meta 并存；同 meta 幂等；无 meta 保持纯内容寻址', () => {
    const root = mkdtempTracked(join(tmpdir(), 'spill-a6-'))
    try {
      const meta1 = { kind: 'rewrite' as const, chapter: 1, baseSha: 'a'.repeat(64) }
      const meta2 = { kind: 'rewrite' as const, chapter: 2, baseSha: 'b'.repeat(64) }
      const l1 = writeSpillFile(root, '同一正文', meta1)!
      const l1Again = writeSpillFile(root, '同一正文', meta1)!
      const l2 = writeSpillFile(root, '同一正文', meta2)!
      const lNoMeta = writeSpillFile(root, '同一正文')!
      expect(l1).toBe(l1Again) // 同章号+基线 → 幂等
      expect(l1).not.toBe(l2) // 不同章号/基线 → 独立 locator，sidecar 不互覆
      expect(l1).not.toBe(lNoMeta) // 无 meta（chat 上下文外置）保持纯内容寻址口径
      expect(readSpillMeta(root, l1)).toEqual(meta1)
      expect(readSpillMeta(root, l2)).toEqual(meta2)
      expect(readSpillFile(root, l1)).toBe('同一正文')
      expect(readSpillFile(root, l2)).toBe('同一正文')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
