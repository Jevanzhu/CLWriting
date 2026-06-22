import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parsePieceListBody,
  stringifyPieceList,
  readPieceList,
  writePieceList,
  emptyPieceList,
} from '../../src/format/manifest.js'
import type { PieceList } from '../../src/format/types.js'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'clwriting-manifest-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

// ── parsePieceListBody ───────────────────────────

test('parsePieceListBody: 完整三段解析', () => {
  const body = `## 反转线索表
- 核心反转：来客即凶手
- 铺垫点（≥3，反转可回溯）：
  - [开头] 雪夜敲门
  - [中段] 来客手上的焦痕
  - [结尾] 二叔的异常沉默

## 情绪曲线
- [开头钩子] 惊悚 3/10：雪夜敲门
- [铺垫] 疑惧 5/10：焦痕出现
- [升级] 紧张 7/10：二叔沉默
- [反转] 震惊 9/10：来客即凶手
- [余韵] 后怕 6/10：门外无人

## 伏笔回收
- 雪地脚印 → 回收于 结尾二叔被揭穿
- 半枚玉佩 → 回收于 中段认出族徽
`
  const list = parsePieceListBody(body)
  expect(list.反转线索表.核心反转).toBe('来客即凶手')
  expect(list.反转线索表.铺垫点).toHaveLength(3)
  expect(list.反转线索表.铺垫点[0]).toEqual({ 位置: '开头', 内容: '雪夜敲门' })
  expect(list.情绪曲线).toHaveLength(5)
  expect(list.情绪曲线?.[3]).toEqual({ 段落: '反转', 情绪: '震惊', 强度: 9, 说明: '来客即凶手' })
  expect(list.伏笔回收).toHaveLength(2)
  expect(list.伏笔回收[0]).toEqual({ 伏笔: '雪地脚印', 回收位置: '结尾二叔被揭穿' })
})

test('parsePieceListBody: 未回收标记', () => {
  const body = `## 伏笔回收
- 雪地脚印 → 回收于 结尾
- 半枚玉佩（未回收）
`
  const list = parsePieceListBody(body)
  expect(list.伏笔回收).toHaveLength(2)
  expect(list.伏笔回收[1]!.未回收).toBe(true)
  expect(list.伏笔回收[1]!.伏笔).toBe('半枚玉佩')
})

test('parsePieceListBody: 缺段容错不崩', () => {
  const list = parsePieceListBody('## 反转线索表\n- 核心反转：x\n')
  expect(list.反转线索表.核心反转).toBe('x')
  expect(list.伏笔回收).toHaveLength(0)
})

test('parsePieceListBody: 空正文 → 空清单', () => {
  const list = parsePieceListBody('')
  expect(list.反转线索表.核心反转).toBe('')
  expect(list.反转线索表.铺垫点).toHaveLength(0)
  expect(list.伏笔回收).toHaveLength(0)
})

// ── stringify 往返 ───────────────────────────────

test('stringifyPieceList + parsePieceListBody 往返', () => {
  const list: PieceList = {
    反转线索表: {
      核心反转: '来客即凶手',
      铺垫点: [
        { 位置: '开头', 内容: '雪夜敲门' },
        { 位置: '中段', 内容: '焦痕' },
        { 位置: '结尾', 内容: '沉默' },
      ],
    },
    情绪曲线: [
      { 段落: '开头钩子', 情绪: '惊悚', 强度: 3, 说明: '敲门' },
      { 段落: '铺垫', 情绪: '疑惧', 强度: 5 },
      { 段落: '升级', 情绪: '紧张', 强度: 7 },
      { 段落: '反转', 情绪: '震惊', 强度: 9, 说明: '真相揭开' },
      { 段落: '余韵', 情绪: '后怕', 强度: 6 },
    ],
    伏笔回收: [
      { 伏笔: '脚印', 回收位置: '结尾' },
      { 伏笔: '玉佩', 回收位置: '', 未回收: true },
    ],
  }
  const text = stringifyPieceList(list)
  const reparsed = parsePieceListBody(text)
  expect(reparsed.反转线索表.核心反转).toBe('来客即凶手')
  expect(reparsed.反转线索表.铺垫点).toHaveLength(3)
  expect(reparsed.情绪曲线).toHaveLength(5)
  expect(reparsed.情绪曲线?.[0]!.情绪).toBe('惊悚')
  expect(reparsed.伏笔回收).toHaveLength(2)
  expect(reparsed.伏笔回收[1]!.未回收).toBe(true)
})

// ── emptyPieceList + read/write 文件 ─────────────

test('emptyPieceList: 空占位不臆造反转线索', () => {
  const empty = emptyPieceList()
  expect(empty.反转线索表.核心反转).toBe('')
  expect(empty.反转线索表.铺垫点).toHaveLength(0)
  expect(empty.情绪曲线).toHaveLength(0)
  expect(empty.伏笔回收).toHaveLength(0)
})

test('readPieceList: 文件不存在 → 容错错误', () => {
  const r = readPieceList(join(tmp, '清单.md'))
  expect(r.ok).toBe(false)
})

test('writePieceList + readPieceList: 空清单往返', () => {
  const fp = join(tmp, '清单.md')
  writePieceList(fp, emptyPieceList())
  const r = readPieceList(fp)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.list.反转线索表.铺垫点).toHaveLength(0)
})
