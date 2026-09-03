/**
 * MP2-4 → 平台规范化批一（2026-09-03）：文本级补丁写回**规范形**。
 *
 * 语义演进：MP2-4（专项重评二轮）曾确立「新渲染行按原文主导行尾」的保真契约
 * （CRLF 文件写回保持 CRLF）；平台规范化批一推翻之——书库内文本全面规范
 * **LF + 无 BOM**（消除 win/mac 跨机互拷的行尾/BOM 差异面），补丁族输出经
 * canonicalizeText 收口。本文件锚定翻转后契约：
 * - CRLF 宿主经补丁改写 → 全文归一 LF（无 \r 残留）；
 * - LF 宿主 → 字节级不变（回归锚，与保真时代重合）。
 * 读侧容忍（BOM/CRLF 照常解析）不变，见 r2w6-yaml-bom / r37-yaml-bom-keyline。
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { patchTopSection, setTopSectionKey, setSectionKeyBlock } from '../../src/format/yaml.js'
import { patchFlatFm } from '../../src/format/frontmatter.js'
import { exportBook } from '../../src/export/index.js'

/** 规范形校验：全文无 \r（canonicalizeText 后孤立 \r 与 \r\n 均不得残留）。 */
function expectNoCr(text: string): void {
  expect(text.includes('\r'), `残留 \\r：${JSON.stringify(text.slice(0, 80))}`).toBe(false)
}

describe('MP2-4→批一：patchTopSection 行尾规范形', () => {
  it('CRLF 整段替换：写回全文归一 LF（保真契约翻转）', () => {
    const raw = 'book:\r\n  title: 甲\r\n\r\nreview:\r\n  enabled: true\r\n'
    const out = patchTopSection(raw, 'review', '  enabled: false')
    expect(out).toBe('book:\n  title: 甲\n\nreview:\n  enabled: false\n')
    expectNoCr(out)
  })

  it('CRLF 整段替换（原文无尾随换行）：归一 LF、末行不带终止符', () => {
    const out = patchTopSection('review:\r\n  enabled: true', 'review', '  enabled: false')
    expect(out).toBe('review:\n  enabled: false')
    expectNoCr(out)
  })

  it('CRLF 段追加：全文归一 LF（新段行不再跟随原文 CRLF）', () => {
    const out = patchTopSection('book:\r\n  title: 甲\r\n', 'review', '  enabled: true')
    expect(out).toBe('book:\n  title: 甲\n\nreview:\n  enabled: true\n')
    expectNoCr(out)
  })

  it('LF 文件回归锚：输出与规范形时代字节一致', () => {
    expect(patchTopSection('book:\n  title: 甲\n\nreview:\n  enabled: true\n', 'review', '  enabled: false')).toBe(
      'book:\n  title: 甲\n\nreview:\n  enabled: false\n',
    )
    expect(patchTopSection('book:\n  title: 甲\n', 'review', '  enabled: true')).toBe(
      'book:\n  title: 甲\n\nreview:\n  enabled: true\n',
    )
  })
})

describe('MP2-4→批一：setTopSectionKey 行尾规范形', () => {
  it('CRLF 替换既有键行 / 插入缺失键行：全文归一 LF', () => {
    expect(setTopSectionKey('book:\r\n  title: 甲\r\n', 'book', 'title', '乙')).toBe('book:\n  title: 乙\n')
    expect(setTopSectionKey('book:\r\n  title: 甲\r\n', 'book', 'genre', '玄幻')).toBe(
      'book:\n  genre: 玄幻\n  title: 甲\n',
    )
  })

  it('LF 文件回归锚：输出字节不变', () => {
    expect(setTopSectionKey('book:\n  title: 甲\n', 'book', 'title', '乙')).toBe('book:\n  title: 乙\n')
    expect(setTopSectionKey('book:\n  title: 甲\n', 'book', 'genre', '玄幻')).toBe('book:\n  genre: 玄幻\n  title: 甲\n')
  })
})

describe('MP2-4→批一：patchFlatFm 行尾规范形', () => {
  it('CRLF fm 键行替换：全文归一 LF', () => {
    const r = patchFlatFm('标题: 甲\r\n章号: 1\r\n', { 标题: '乙' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe('标题: 乙\n章号: 1\n')
    expectNoCr(r.text)
  })

  it('CRLF fm 键行追加：归一 LF、末行不带终止符', () => {
    const r = patchFlatFm('章号: 1\r\n', { 标题: '乙' })
    expect(r).toEqual({ ok: true, text: '章号: 1\n\n标题: 乙' })
  })

  it('LF fm 回归锚：输出字节不变', () => {
    const r = patchFlatFm('标题: 甲\n章号: 1\n', { 标题: '乙' })
    expect(r).toEqual({ ok: true, text: '标题: 乙\n章号: 1\n' })
    expect(patchFlatFm('章号: 1\n', { 标题: '乙' })).toEqual({ ok: true, text: '章号: 1\n\n标题: 乙' })
  })
})

describe('MP2-4→批一：setSectionKeyBlock 行尾规范形（同族连带）', () => {
  it('CRLF 键块替换：全文归一 LF', () => {
    const raw = 'leads:\r\n  thresholds:\r\n    deep: 3\r\n'
    const out = setSectionKeyBlock(raw, 'leads', 'thresholds', 'thresholds:', ['deep: 5'])
    expect(out).toBe('leads:\n  thresholds:\n    deep: 5\n')
    expectNoCr(out)
  })

  it('LF 文件回归锚：输出字节不变', () => {
    const raw = 'leads:\n  thresholds:\n    deep: 3\n'
    expect(setSectionKeyBlock(raw, 'leads', 'thresholds', 'thresholds:', ['deep: 5'])).toBe(
      'leads:\n  thresholds:\n    deep: 5\n',
    )
  })
})

describe('MP2-4→批一：导出规范形（purifyBody 截断 + payload 收口）', () => {
  it('CRLF 正文导出全本：归一 LF 无 \\r 残留（源规范后输出自然规范）', () => {
    const root = mkdtempSync(join(tmpdir(), 'clw-mp2-4-export-'))
    try {
      writeFileSync(
        join(root, 'book.yaml'),
        ['spec_version: 1', 'book:', '  title: 行尾规范', '  genre: 玄幻'].join('\n'),
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
      const merged = readFileSync(join(root, '工作区', '导出', '全本-行尾规范.md'), 'utf-8')
      expect(merged).toContain('正文一句。\n保留行') // 翻转锚：截断行归一 LF
      expect(merged.includes('\r')).toBe(false) // 全文无 \r（规范形）
      expect(merged).not.toContain('#%') // 批注仍被剥净（IR-5 语义不回退）
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
