/**
 * MP2-4（专项重评二轮修复批）：文本级补丁写回行尾保真。
 *
 * CRLF 文件（win 记事本/autocrlf 形态）经 patchTopSection / setTopSectionKey /
 * patchFlatFm 改写、经导出 purifyBody 截断 #% 批注行时，被替换/新增的行此前一律
 * LF 渲染（未触碰行保留 \r\n）→ 写回混合行尾。修复后新渲染行按原文主导行尾
 * （含 \r\n 即 CRLF），LF 文件字节级不变（回归锚）。
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { patchTopSection, setTopSectionKey, setSectionKeyBlock } from '../../src/format/yaml.js'
import { patchFlatFm } from '../../src/format/frontmatter.js'
import { exportBook } from '../../src/export/index.js'

/** 全文 CRLF 校验：split 后每个非末尾行都带 \r 尾（末段空串 = 尾随换行，放行）。 */
function expectUniformCrlf(text: string): void {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const isLast = i === lines.length - 1
    if (isLast && lines[i] === '') continue
    expect(lines[i]!.endsWith('\r'), `第 ${i} 行缺 \\r 尾：${JSON.stringify(lines[i])}`).toBe(true)
  }
}

describe('MP2-4：patchTopSection 行尾保真', () => {
  it('CRLF 整段替换：写回全文统一 CRLF（此前新段行 LF 混排）', () => {
    const raw = 'book:\r\n  title: 甲\r\n\r\nreview:\r\n  enabled: true\r\n'
    const out = patchTopSection(raw, 'review', '  enabled: false')
    // 修复点：新段行带 \r；段尾空行占位剥成单个尾随 \r\n（与 LF 侧末元素 '' 同形态，
    // 不是空行+换行——否则比原文多出一个空行）
    expect(out).toBe('book:\r\n  title: 甲\r\n\r\nreview:\r\n  enabled: false\r\n')
    expectUniformCrlf(out)
  })

  it('CRLF 整段替换（原文无尾随换行）：末行不带终止符，不悬挂裸 \\r', () => {
    const out = patchTopSection('review:\r\n  enabled: true', 'review', '  enabled: false')
    expect(out).toBe('review:\r\n  enabled: false') // 修复点：EOF 无终止符形态保真
  })

  it('CRLF 段追加：新增段行跟随原文 CRLF', () => {
    const out = patchTopSection('book:\r\n  title: 甲\r\n', 'review', '  enabled: true')
    expect(out).toBe('book:\r\n  title: 甲\r\n\r\nreview:\r\n  enabled: true\r\n') // 修复点
    expectUniformCrlf(out)
  })

  it('LF 文件回归锚：输出与修复前字节一致', () => {
    expect(patchTopSection('book:\n  title: 甲\n\nreview:\n  enabled: true\n', 'review', '  enabled: false')).toBe(
      'book:\n  title: 甲\n\nreview:\n  enabled: false\n',
    )
    expect(patchTopSection('book:\n  title: 甲\n', 'review', '  enabled: true')).toBe(
      'book:\n  title: 甲\n\nreview:\n  enabled: true\n',
    )
  })
})

describe('MP2-4：setTopSectionKey 行尾保真', () => {
  it('CRLF 替换既有键行 / 插入缺失键行均带 \\r 尾', () => {
    expect(setTopSectionKey('book:\r\n  title: 甲\r\n', 'book', 'title', '乙')).toBe('book:\r\n  title: 乙\r\n') // 修复点
    expect(setTopSectionKey('book:\r\n  title: 甲\r\n', 'book', 'genre', '玄幻')).toBe(
      'book:\r\n  genre: 玄幻\r\n  title: 甲\r\n',
    )
  })

  it('LF 文件回归锚：输出与修复前字节一致', () => {
    expect(setTopSectionKey('book:\n  title: 甲\n', 'book', 'title', '乙')).toBe('book:\n  title: 乙\n')
    expect(setTopSectionKey('book:\n  title: 甲\n', 'book', 'genre', '玄幻')).toBe('book:\n  genre: 玄幻\n  title: 甲\n')
  })
})

describe('MP2-4：patchFlatFm 行尾保真', () => {
  it('CRLF fm 键行替换：新键行带 \\r 尾、未触碰行原样', () => {
    const r = patchFlatFm('标题: 甲\r\n章号: 1\r\n', { 标题: '乙' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe('标题: 乙\r\n章号: 1\r\n') // 修复点
    expectUniformCrlf(r.text)
  })

  it('CRLF fm 键行追加：新键行带 \\r 尾、末行不带终止符（不悬挂裸 \\r）', () => {
    const r = patchFlatFm('章号: 1\r\n', { 标题: '乙' })
    expect(r).toEqual({ ok: true, text: '章号: 1\r\n\r\n标题: 乙' }) // 修复点
  })

  it('LF fm 回归锚：输出与修复前字节一致', () => {
    const r = patchFlatFm('标题: 甲\n章号: 1\n', { 标题: '乙' })
    expect(r).toEqual({ ok: true, text: '标题: 乙\n章号: 1\n' })
    expect(patchFlatFm('章号: 1\n', { 标题: '乙' })).toEqual({ ok: true, text: '章号: 1\n\n标题: 乙' })
  })
})

describe('MP2-4：setSectionKeyBlock 行尾保真（同族连带收口）', () => {
  it('CRLF 键块替换：新键行/块行均带 \\r 尾', () => {
    const raw = 'leads:\r\n  thresholds:\r\n    deep: 3\r\n'
    const out = setSectionKeyBlock(raw, 'leads', 'thresholds', 'thresholds:', ['deep: 5'])
    expect(out).toBe('leads:\r\n  thresholds:\r\n    deep: 5\r\n') // 修复点：同族连带
    expectUniformCrlf(out)
  })

  it('LF 文件回归锚：输出与修复前字节一致', () => {
    const raw = 'leads:\n  thresholds:\n    deep: 3\n'
    expect(setSectionKeyBlock(raw, 'leads', 'thresholds', 'thresholds:', ['deep: 5'])).toBe(
      'leads:\n  thresholds:\n    deep: 5\n',
    )
  })
})

describe('MP2-4：导出 purifyBody 截断行尾保真', () => {
  it('CRLF 正文的 #% 截断行保留 \\r（不再落成 LF 混排）', () => {
    const root = mkdtempSync(join(tmpdir(), 'clw-mp2-4-export-'))
    try {
      writeFileSync(
        join(root, 'book.yaml'),
        ['spec_version: 1', 'book:', '  title: 行尾保真', '  genre: 玄幻'].join('\n'),
        'utf-8',
      )
      mkdirSync(join(root, '写作', '正文'), { recursive: true })
      // fm 用 LF（读侧确定面），正文体 CRLF——正文一句截断 #% 批注、次行保留原样
      writeFileSync(
        join(root, '写作', '正文', '1-雪.md'),
        '---\n章号: 1\n标题: 雪\n---\n正文一句。#%行中批注\r\n保留行\r\n',
        'utf-8',
      )

      const r = exportBook({ bookRoot: root, format: 'merged' })
      expect(r.ok).toBe(true)
      const merged = readFileSync(join(root, '工作区', '导出', '全本-行尾保真.md'), 'utf-8')
      expect(merged).toContain('正文一句。\r\n保留行') // 修复点：截断行带回 \r
      expect(merged).not.toContain('正文一句。\n') // 无 LF 混排形态（。后必是 \r）
      expect(merged).not.toContain('#%') // 批注仍被剥净（IR-5 语义不回退）
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
