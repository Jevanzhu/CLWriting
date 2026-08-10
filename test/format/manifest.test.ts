import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

test('parsePieceListBody: CRLF 清单仍解析嵌套铺垫与伏笔回收', () => {
  const body = [
    '## 反转线索表',
    '- 核心反转：来客即凶手',
    '- 铺垫点（≥3，反转可回溯）：',
    '  - [开头] 雪夜敲门',
    '  - [中段] 来客手上的焦痕',
    '  - [结尾] 二叔的异常沉默',
    '',
    '## 情绪曲线',
    '- [反转] 震惊 9/10：来客即凶手',
    '',
    '## 伏笔回收',
    '- 雪地脚印 → 回收于 结尾二叔被揭穿',
    '- 半枚玉佩 -> 回收于 中段认出族徽',
    '',
  ].join('\r\n')

  const list = parsePieceListBody(body)
  expect(list.反转线索表.铺垫点).toHaveLength(3)
  expect(list.反转线索表.铺垫点[1]).toEqual({ 位置: '中段', 内容: '来客手上的焦痕' })
  expect(list.伏笔回收).toHaveLength(2)
  expect(list.伏笔回收[1]).toEqual({ 伏笔: '半枚玉佩', 回收位置: '中段认出族徽' })
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

test('readPieceList: 带 fm 头的章纲文件仍正确解析三段式（F9.5，fm 块内无 ## 段标题被自然跳过）', () => {
  const fp = join(tmp, '章纲.md')
  writeFileSync(
    fp,
    [
      '---',
      '章号: 1',
      '标题: 雨夜门铃',
      '钩子类型: 悬念钩',
      '钩子强弱: 中',
      '情绪定位: 铺垫',
      '场景: 叙事铺陈',
      '字数目标: 12000',
      '目标情绪: 惊悚',
      '核心反转: 按门铃的来客就是三年前死在七号公寓的人',
      '---',
      '',
      '## 反转线索表',
      '- 核心反转：按门铃的来客就是三年前死在七号公寓的人',
      '- 铺垫点（≥3，反转可回溯）：',
      '  - [开头钩子] 门铃响三次，门外只有一把红伞',
      '  - [发展] 旧收音机里夹着三年前的坠楼报纸',
      '',
      '## 情绪曲线',
      '- [开头钩子] 惊悚 3/10：停电夜门铃',
      '- [反转] 震惊 9/10：来客是死者',
      '',
      '## 伏笔回收',
      '- 红伞 → 回收于 结尾',
    ].join('\n'),
    'utf-8',
  )
  const r = readPieceList(fp)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.list.反转线索表.核心反转).toBe('按门铃的来客就是三年前死在七号公寓的人')
  expect(r.list.反转线索表.铺垫点).toHaveLength(2)
  expect(r.list.情绪曲线).toHaveLength(2)
  expect(r.list.伏笔回收).toHaveLength(1)
  expect(r.list.伏笔回收[0]!.伏笔).toBe('红伞')
})
