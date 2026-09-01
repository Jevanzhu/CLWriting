/**
 * R35-21（三十五轮）回归：deriveLeakKeywords 键位冒号双认 `:`/`：`。
 *
 * 缺陷：leak_keywords 两处正则只认半角冒号——手写全角冒号的账本 fm 条目（单行数组
 * 与逐行列表两形态）整条静默漏收，info-leak 机检假绿（R31-2/R34D-10 冒号双认家族
 * 漏改点）。
 */
import { test, expect } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveLeakKeywords } from '../../src/check/leak-derive.js'

function writeWiringDoc(root: string, name: string, fm: string): void {
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  writeFileSync(join(root, '布线', '悬念', name), `---\n编号: 悬念-001\n标题: 密室之主\n类型: 悬念\n状态: 进行中\n开启章: 1\n${fm}\n---\n\n正文无关。\n`, 'utf-8')
}

test('R35-21: 全角冒号单行数组条目入词表（修复前静默漏收 → 假绿）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'r35-leak-'))
  try {
    writeWiringDoc(root, '悬念-001-密室之主.md', 'leak_keywords：[玄铁令, 密室机关]')
    expect(deriveLeakKeywords(root)).toEqual(['玄铁令', '密室机关'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R35-21: 全角冒号逐行列表条目入词表', () => {
  const root = mkdtempTracked(join(tmpdir(), 'r35-leak-'))
  try {
    writeWiringDoc(root, '悬念-001-密室之主.md', 'leak_keywords：\n  - 玉佩\n  - 旧案')
    expect(deriveLeakKeywords(root)).toEqual(['玉佩', '旧案'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R35-21: 半角冒号既有口径不回归（单行数组 + 逐行列表照收）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'r35-leak-'))
  try {
    writeWiringDoc(root, '悬念-001-密室之主.md', 'leak_keywords: [半角词]')
    writeWiringDoc(root, '悬念-002-另线.md', 'leak_keywords:\n  - 列表词')
    const kws = deriveLeakKeywords(root)
    expect(kws).toContain('半角词')
    expect(kws).toContain('列表词')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
