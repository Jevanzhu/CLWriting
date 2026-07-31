/**
 * 文风条目库读写单测（文风系统重整 S1）。
 * readEntry/writeEntry 往返、类型兜底、极性推导、序号递增、addEntry 入库。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readEntry,
  writeEntry,
  readEntries,
  nextEntrySeq,
  addEntry,
  entryPolarity,
  SOURCE_RANK,
  ENTRIES_DIR,
} from '../../src/format/style-entry.js'
import type { StyleEntry } from '../../src/format/types.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clwriting-style-entry-'))
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('readEntry / writeEntry 往返', () => {
  it('全字段写读一致（说明/出处/标签/未知字段保留）', () => {
    const dir = join(root, ENTRIES_DIR, '样章')
    mkdirSync(dir, { recursive: true })
    const fp = join(dir, '战斗-001.md')
    const e: StyleEntry = {
      类型: '样章',
      场景: '战斗',
      来源: '改稿行为',
      说明: '短句叠加，不给情绪总结',
      出处: '《测试书》第 42 章',
      标签: ['金句', '锚点'],
      正文: '他把烟摁灭。「说吧。」',
      _raw: { 自定义: '保留我' },
    }
    writeEntry(fp, e)
    const r = readEntry(fp)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.entry.类型).toBe('样章')
    expect(r.entry.场景).toBe('战斗')
    expect(r.entry.来源).toBe('改稿行为')
    expect(r.entry.说明).toBe('短句叠加，不给情绪总结')
    expect(r.entry.出处).toBe('《测试书》第 42 章')
    expect(r.entry.标签).toEqual(['金句', '锚点'])
    expect(r.entry.正文).toBe('他把烟摁灭。「说吧。」')
    expect(r.entry._raw?.['自定义']).toBe('保留我')
  })

  it('证据是运行期字段，不落盘', () => {
    const dir = join(root, ENTRIES_DIR, '样章')
    mkdirSync(dir, { recursive: true })
    const fp = join(dir, '对话-001.md')
    writeEntry(fp, {
      类型: '样章',
      场景: '对话',
      来源: '改稿行为',
      正文: '作者版正文',
      证据: { 章号: 42, AI版: '他深吸一口气', 作者版: '作者版正文' },
    })
    expect(readFileSync(fp, 'utf-8')).not.toContain('深吸一口气')
    const r = readEntry(fp)
    expect(r.ok && r.entry.证据 === undefined).toBe(true)
  })

  it('fm 缺类型：fallbackKind 兜底；两者皆无 → 错误', () => {
    const fp = join(root, 'x.md')
    writeFileSync(fp, '---\n场景: 通用\n---\n\n某禁词\n', 'utf-8')
    const withFallback = readEntry(fp, '禁词')
    expect(withFallback.ok && withFallback.entry.类型 === '禁词').toBe(true)
    const without = readEntry(fp)
    expect(without.ok).toBe(false)
  })

  it('来源非法/缺失 → 缺省作者标注；场景缺失 → 错误', () => {
    const fp = join(root, 'y.md')
    writeFileSync(fp, '---\n类型: 手法\n场景: 通用\n来源: 不存在的\n---\n\n对话不用提示语\n', 'utf-8')
    const r = readEntry(fp)
    expect(r.ok && r.entry.来源 === '作者标注').toBe(true)
    const fp2 = join(root, 'z.md')
    writeFileSync(fp2, '---\n类型: 手法\n---\n\n正文\n', 'utf-8')
    expect(readEntry(fp2).ok).toBe(false)
  })
})

describe('极性与来源强度', () => {
  it('样章/手法=正，反例/禁词=负', () => {
    expect(entryPolarity('样章')).toBe('正')
    expect(entryPolarity('手法')).toBe('正')
    expect(entryPolarity('反例')).toBe('负')
    expect(entryPolarity('禁词')).toBe('负')
  })

  it('来源强度：行为 > 认可 > 声明', () => {
    expect(SOURCE_RANK['改稿行为']).toBeLessThan(SOURCE_RANK['作者标注'])
    expect(SOURCE_RANK['作者标注']).toBeLessThan(SOURCE_RANK['收割'])
    expect(SOURCE_RANK['收割']).toBeLessThan(SOURCE_RANK['题材范文'])
    expect(SOURCE_RANK['题材范文']).toBeLessThan(SOURCE_RANK['导入'])
  })
})

describe('readEntries / nextEntrySeq / addEntry', () => {
  it('目录不存在 → 空（老书未迁移形态）', () => {
    const r = readEntries(join(root, ENTRIES_DIR))
    expect(r.entries).toHaveLength(0)
    expect(r.errors).toHaveLength(0)
  })

  it('按类型过滤 + 全库读取；坏文件进 errors 不崩', () => {
    addEntry(root, { 类型: '样章', 场景: '战斗', 来源: '作者标注', 正文: 'A' })
    addEntry(root, { 类型: '禁词', 场景: '通用', 来源: '导入', 正文: '深吸一口气' })
    writeFileSync(join(root, ENTRIES_DIR, '禁词', 'broken.md'), '---\n类型: 禁词\n---\n\n无场景\n', 'utf-8')
    const all = readEntries(join(root, ENTRIES_DIR))
    expect(all.entries).toHaveLength(2)
    expect(all.errors).toHaveLength(1)
    const banned = readEntries(join(root, ENTRIES_DIR), '禁词')
    expect(banned.entries).toHaveLength(1)
    expect(banned.entries[0]!.正文).toBe('深吸一口气')
  })

  it('序号同场景递增、异场景独立；addEntry 返回相对路径', () => {
    const p1 = addEntry(root, { 类型: '样章', 场景: '战斗', 来源: '作者标注', 正文: 'A' })
    const p2 = addEntry(root, { 类型: '样章', 场景: '战斗', 来源: '作者标注', 正文: 'B' })
    const p3 = addEntry(root, { 类型: '样章', 场景: '对话', 来源: '作者标注', 正文: 'C' })
    expect(p1).toBe('文风/条目/样章/战斗-001.md')
    expect(p2).toBe('文风/条目/样章/战斗-002.md')
    expect(p3).toBe('文风/条目/样章/对话-001.md')
    expect(existsSync(join(root, p2))).toBe(true)
    expect(nextEntrySeq(join(root, ENTRIES_DIR), '样章', '战斗')).toBe(3)
  })
})
