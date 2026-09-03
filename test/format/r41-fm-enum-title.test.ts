/**
 * R41-14 / R41-15（四十一轮修复批）回归：章 front matter 读取侧两处收口。
 *
 * R41-14：必填枚举（钩子类型/钩子强弱/情绪定位）空串值此前 `??` 接不住——
 * requireEnum 已把空串记 _fmMissing（fm-missing 红项），值侧穿透空串又被
 * validateEnums 报越界（fm-enum 红项）→ 同字段双红矛盾。修复后空串一律落默认，
 * 红项只由 fm-missing 承载；非空非法值的 fm-enum 报告面维持。
 *
 * R41-15：块标量（`标题: |`）多行标题此前带 \n 直落 ChapterMeta.标题——导出载荷
 * 标题行被劈、前端展示/警告文案渗换行。修复后读取侧单行化（各行 trim 空格连接）。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readChapter, validateEnums } from '../../src/format/chapters.js'

function writeFm(fm: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'r41-fm-'))
  const fp = join(dir, '0001-测试.md')
  writeFileSync(fp, `---\n${fm}\n---\n正文一句。`, 'utf-8')
  return fp
}

describe('R41-14: 枚举空串落默认（fm-missing 单红，不再叠加 fm-enum）', () => {
  it('钩子类型空串 → _fmMissing 记缺 + 值落默认悬念钩，validateEnums 无越界', () => {
    const fp = writeFm(['章号: 1', '标题: 空钩', '钩子类型:', '钩子强弱: 中', '情绪定位: 铺垫'].join('\n'))
    try {
      const r = readChapter(fp)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.chapter._fmMissing).toContain('钩子类型')
      expect(r.chapter.钩子类型).toBe('悬念钩') // 修复前：空串穿透
      expect(validateEnums(r.chapter)).toEqual([]) // 修复前：['钩子类型越界：…']
    } finally {
      rmSync(fp, { recursive: true, force: true })
    }
  })

  it('三枚举全空串 → 同口径（_fmMissing×3 + 全默认，无越界）', () => {
    const fp = writeFm(['章号: 1', '标题: 全空', '钩子类型:', '钩子强弱:', '情绪定位:'].join('\n'))
    try {
      const r = readChapter(fp)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.chapter._fmMissing).toEqual(['钩子类型', '钩子强弱', '情绪定位'])
      expect(r.chapter.钩子类型).toBe('悬念钩')
      expect(r.chapter.钩子强弱).toBe('中')
      expect(r.chapter.情绪定位).toBe('铺垫')
      expect(validateEnums(r.chapter)).toEqual([])
    } finally {
      rmSync(fp, { recursive: true, force: true })
    }
  })

  it('非空非法值行为维持：fm-enum 照报（收紧只作用于空串）', () => {
    const fp = writeFm(['章号: 1', '标题: 非法值', '钩子类型: 越界钩', '钩子强弱: 中', '情绪定位: 铺垫'].join('\n'))
    try {
      const r = readChapter(fp)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.chapter._fmMissing ?? []).toEqual([]) // 写了值不算缺
      expect(validateEnums(r.chapter)).toHaveLength(1) // fm-enum 照报
    } finally {
      rmSync(fp, { recursive: true, force: true })
    }
  })
})

describe('R41-15: 块标量多行标题读取侧单行化', () => {
  it('literal `|` 多行标题 → trim 后空格连接单行（\\n 不落 ChapterMeta.标题）', () => {
    const fp = writeFm(['章号: 1', '标题: |', '  双线标题上', '  双线标题下', '钩子类型: 悬念钩', '钩子强弱: 中', '情绪定位: 铺垫'].join('\n'))
    try {
      const r = readChapter(fp)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.chapter.标题).toBe('双线标题上 双线标题下') // 修复前：含 \n
      expect(r.chapter.标题.includes('\n')).toBe(false)
    } finally {
      rmSync(fp, { recursive: true, force: true })
    }
  })

  it('folded `>` 多行标题 → parseFlat 已折单行，读取侧维持单行（无回归）', () => {
    const fp = writeFm(['章号: 1', '标题: >', '  折行标题上', '  折行标题下', '钩子类型: 悬念钩', '钩子强弱: 中', '情绪定位: 铺垫'].join('\n'))
    try {
      const r = readChapter(fp)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.chapter.标题.includes('\n')).toBe(false)
    } finally {
      rmSync(fp, { recursive: true, force: true })
    }
  })
})
