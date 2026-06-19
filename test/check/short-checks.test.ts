import { test, expect } from 'vitest'
import {
  checkPieceFrontMatter,
  checkPieceWordCount,
  checkBodyParts,
  checkSimile,
  checkSectionCount,
  checkOpeningNoEnv,
} from '../../src/check/count.js'
import { checkPieceListForm } from '../../src/check/manifest-check.js'
import type { PieceList } from '../../src/format/types.js'

// ── checkPieceFrontMatter ────────────────────────

test('checkPieceFrontMatter: 篇号文件名一致通过', () => {
  const r = checkPieceFrontMatter({ 篇号: 1, 标题: '雪夜' }, '篇/001-雪夜/正文.md')
  expect(r.items).toHaveLength(0)
})

test('checkPieceFrontMatter: 篇号不一致报红', () => {
  const r = checkPieceFrontMatter({ 篇号: 2, 标题: '雪夜' }, '篇/001-雪夜/正文.md')
  expect(r.items).toHaveLength(1)
  expect(r.items[0]!.level).toBe('red')
})

// ── checkPieceWordCount ──────────────────────────

test('checkPieceWordCount: 区间内通过', () => {
  expect(checkPieceWordCount(12000).items).toHaveLength(0)
})

test('checkPieceWordCount: 低于下限报黄', () => {
  const r = checkPieceWordCount(3000)
  expect(r.items).toHaveLength(1)
  expect(r.items[0]!.checkId).toBe('piece-word-short')
})

// ── checkBodyParts ───────────────────────────────

test('checkBodyParts: 堆砌超阈报黄', () => {
  const body = '眼睛'.repeat(6) + '手指'.repeat(6) // 各 6 次 > 5
  const r = checkBodyParts(body)
  expect(r.items).toHaveLength(1)
  expect(r.items[0]!.message).toContain('眼睛')
  expect(r.items[0]!.message).toContain('手指')
})

test('checkBodyParts: 未超阈通过', () => {
  expect(checkBodyParts('眼睛手指心脏').items).toHaveLength(0) // 各 1 次
})

// ── checkSimile ──────────────────────────────────

test('checkSimile: 「像」超阈报黄', () => {
  const r = checkSimile('像'.repeat(11), 10)
  expect(r.items).toHaveLength(1)
  expect(r.items[0]!.message).toContain('11')
})

test('checkSimile: 未超阈通过', () => {
  expect(checkSimile('像像像', 10).items).toHaveLength(0)
})

// ── checkSectionCount ────────────────────────────

test('checkSectionCount: 按 ## 标题计数', () => {
  const body = '## 开头\nx\n## 铺垫\nx\n## 升级\nx\n## 反转\nx\n## 余韵\nx'
  expect(checkSectionCount(body, 5).items).toHaveLength(0)
})

test('checkSectionCount: 节数不符报黄', () => {
  const body = '## 开头\nx\n## 反转\nx' // 2 节
  expect(checkSectionCount(body, 5).items).toHaveLength(1)
})

test('checkSectionCount: 无标题按空行切块', () => {
  const body = '段一\n\n段二\n\n段三' // 3 段
  expect(checkSectionCount(body, 5).items).toHaveLength(1)
})

// ── checkOpeningNoEnv ────────────────────────────

test('checkOpeningNoEnv: 开头无环境通过', () => {
  expect(checkOpeningNoEnv('他推开门，血溅了一地。').items).toHaveLength(0)
})

test('checkOpeningNoEnv: 开头有环境报黄', () => {
  const r = checkOpeningNoEnv('阳光洒在街道上，一切如常。他推开门。')
  expect(r.items).toHaveLength(1)
  expect(r.items[0]!.message).toContain('阳光')
})

// ── checkPieceListForm（清单形式检）──────────────

test('checkPieceListForm: 完整清单通过', () => {
  const list: PieceList = {
    反转线索表: {
      核心反转: 'x',
      铺垫点: [
        { 位置: 'a', 内容: 'x' },
        { 位置: 'b', 内容: 'x' },
        { 位置: 'c', 内容: 'x' },
      ],
    },
    伏笔回收: [{ 伏笔: 'y', 回收位置: 'z' }],
  }
  expect(checkPieceListForm(list).items).toHaveLength(0)
})

test('checkPieceListForm: 铺垫<3 报黄', () => {
  const list: PieceList = {
    反转线索表: { 核心反转: 'x', 铺垫点: [{ 位置: 'a', 内容: 'x' }] },
    伏笔回收: [],
  }
  const r = checkPieceListForm(list)
  expect(r.items).toHaveLength(1)
  expect(r.items[0]!.checkId).toBe('manifest-setup-short')
})

test('checkPieceListForm: 未回收伏笔报黄', () => {
  const list: PieceList = {
    反转线索表: {
      核心反转: 'x',
      铺垫点: [
        { 位置: 'a', 内容: 'x' },
        { 位置: 'b', 内容: 'x' },
        { 位置: 'c', 内容: 'x' },
      ],
    },
    伏笔回收: [{ 伏笔: 'y', 回收位置: '', 未回收: true }],
  }
  const r = checkPieceListForm(list)
  expect(r.items).toHaveLength(1)
  expect(r.items[0]!.checkId).toBe('manifest-payoff-open')
})

test('checkPieceListForm: 缺核心反转报黄', () => {
  const list: PieceList = {
    反转线索表: {
      核心反转: '',
      铺垫点: [
        { 位置: 'a', 内容: 'x' },
        { 位置: 'b', 内容: 'x' },
        { 位置: 'c', 内容: 'x' },
      ],
    },
    伏笔回收: [],
  }
  const r = checkPieceListForm(list)
  expect(r.items[0]!.checkId).toBe('manifest-no-reversal')
})
