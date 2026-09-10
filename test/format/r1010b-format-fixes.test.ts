/**
 * R1010b（全量代码重审与内存专项 2026-09-10 修复批，同族漏网收编）：
 * - P3-3 style 条目序号解析固定 3 位 → 3 位起（对齐 style-migrate (\d{3,}) 先例），
 *   千位序号文件名场景/序号不错位、同场景续号不割裂；
 * - P3-4 stringifyPieceList 补尾换行（对齐 yaml.stringifyBookConfig `join + '\n'` 惯例）；
 * - P3-5 候选箱标量「标签」归一单元素数组（对齐 style-entry / style 重评-20 先例）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { parseSampleFileName } from '../../src/format/style.js'
import { nextEntrySeq, addEntry, readEntry } from '../../src/format/style-entry.js'
import {
  stringifyPieceList,
  parsePieceListBody,
  emptyPieceList,
} from '../../src/format/piece-list-core.js'
import { readCandidate, confirmCandidate } from '../../src/format/style-candidate.js'
import type { PieceList, StyleEntry } from '../../src/format/types.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

let root = ''

beforeEach(() => {
  root = mkdtempTracked(join(tmpdir(), 'clwriting-r1010b-'))
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

// ── R1010b-DOC-P3-3：序号解析 3 位起 ──────────────

describe('R1010b-DOC-P3-3: style 序号解析 3 位起', () => {
  it('千位序号文件名：场景/序号不错位（读侧 4 位 round-trip）', () => {
    // 旧读侧 \d{3} 配贪婪 (.+) 把 战斗-1000 解析成 {场景:'战斗-1', 序号:0}
    expect(parseSampleFileName('战斗-1000.md')).toEqual({ 场景: '战斗', 序号: 1000 })
    expect(parseSampleFileName('战斗-1234.MD')).toEqual({ 场景: '战斗', 序号: 1234 })
  })

  it('既有 3 位行为不变；不足 3 位仍不匹配（null 语义保留）', () => {
    expect(parseSampleFileName('战斗-001.md')).toEqual({ 场景: '战斗', 序号: 1 })
    expect(parseSampleFileName('对话-012.md')).toEqual({ 场景: '对话', 序号: 12 })
    expect(parseSampleFileName('乱.md')).toBeNull()
    expect(parseSampleFileName('战斗-12.md')).toBeNull()
  })

  it('写侧 padStart 不截断 + 读侧续号：千位条目续号 1001 不割裂', () => {
    const kindDir = join(root, '文风', '条目', '样章')
    mkdirSync(kindDir, { recursive: true })
    writeFileSync(join(kindDir, '战斗-1000.md'), '---\n类型: 样章\n场景: 战斗\n---\n\n正文\n')
    const entriesDir = join(root, '文风', '条目')
    // 旧读侧把 战斗-1000 解析成 {场景:'战斗-1', 序号:0} → 续号从 1 起（编号割裂）
    expect(nextEntrySeq(entriesDir, '样章', '战斗')).toBe(1001)
    const e: StyleEntry = { 类型: '样章', 场景: '战斗', 来源: '作者标注', 正文: 'x' }
    const rel = addEntry(root, e)
    expect(basename(rel)).toBe('战斗-1001.md') // padStart(3,'0') 对 4 位序号不截断
    const r = readEntry(join(root, rel))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.entry.场景).toBe('战斗')
      expect(basename(r.entry._path!)).toBe('战斗-1001.md')
    }
  })
})

// ── R1010b-DOC-P3-4：stringifyPieceList 尾换行 ────

describe('R1010b-DOC-P3-4: stringifyPieceList 尾换行', () => {
  const list: PieceList = {
    反转线索表: {
      核心反转: '来客即凶手',
      铺垫点: [{ 位置: '开头', 内容: '雪夜敲门' }],
    },
    情绪曲线: [{ 段落: '开头钩子', 情绪: '惊悚', 强度: 3 }],
    伏笔回收: [{ 伏笔: '脚印', 回收位置: '结尾' }],
  }

  it('非空列表：尾换行恰一，读回 round-trip 不受影响', () => {
    const text = stringifyPieceList(list)
    expect(text.endsWith('\n')).toBe(true)
    expect(text.endsWith('\n\n')).toBe(false)
    const back = parsePieceListBody(text)
    expect(back.反转线索表.核心反转).toBe('来客即凶手')
    expect(back.反转线索表.铺垫点).toHaveLength(1)
    expect(back.情绪曲线).toHaveLength(1)
    expect(back.伏笔回收).toHaveLength(1)
  })

  it('空章纲（emptyPieceList）：三段骨架与（待补）占位保留，尾换行恰一（R26-34 语义不变）', () => {
    const text = stringifyPieceList(emptyPieceList())
    expect(text).toContain('## 反转线索表')
    expect(text).toContain('（待补）')
    expect(text).not.toContain('待定')
    expect(text.endsWith('\n')).toBe(true)
    expect(text.endsWith('\n\n')).toBe(false)
  })
})

// ── R1010b-DOC-P3-5：候选标量「标签」归一 ─────────

describe('R1010b-DOC-P3-5: 候选箱标量「标签」归一单元素数组', () => {
  it('作者手改标量（标签: AI味）→ 读回为单元素数组（此前静默丢弃）', () => {
    const fp = join(root, 'c1.md')
    writeFileSync(
      fp,
      '---\n类型: 禁词\n场景: 通用\n来源: 收割\n状态: 待确认\n创建: 2026-09-10\n标签: AI味\n---\n\n总而言之\n',
    )
    const r = readCandidate(fp)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.candidate.标签).toEqual(['AI味'])
  })

  it('数组形态原样承载；空串/缺键不造空数组', () => {
    const arr = join(root, 'c2.md')
    writeFileSync(
      arr,
      '---\n类型: 手法\n场景: 通用\n来源: 收割\n状态: 待确认\n创建: 2026-09-10\n标签: [金句, 短句]\n---\n\n正文\n',
    )
    const r1 = readCandidate(arr)
    expect(r1.ok).toBe(true)
    if (r1.ok) expect(r1.candidate.标签).toEqual(['金句', '短句'])

    const empty = join(root, 'c3.md')
    writeFileSync(
      empty,
      '---\n类型: 手法\n场景: 通用\n来源: 收割\n状态: 待确认\n创建: 2026-09-10\n标签:\n---\n\n正文\n',
    )
    const r2 = readCandidate(empty)
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.candidate.标签).toBeUndefined()

    const none = join(root, 'c4.md')
    writeFileSync(
      none,
      '---\n类型: 手法\n场景: 通用\n来源: 收割\n状态: 待确认\n创建: 2026-09-10\n---\n\n正文\n',
    )
    const r3 = readCandidate(none)
    expect(r3.ok).toBe(true)
    if (r3.ok) expect(r3.candidate.标签).toBeUndefined()
  })

  it('端到端：标量标签候选经 confirmCandidate 入库后标签存活（此前物理消失）', () => {
    const dir = join(root, '文风', '候选')
    mkdirSync(dir, { recursive: true })
    const name = '收割-01J00000000000000000000000.md'
    writeFileSync(
      join(dir, name),
      '---\n类型: 禁词\n场景: 通用\n来源: 收割\n状态: 待确认\n创建: 2026-09-10\n标签: AI味\n---\n\n总而言之\n',
    )
    const entryPath = confirmCandidate(root, `文风/候选/${name}`)
    expect(entryPath).not.toBeNull()
    const r = readEntry(join(root, entryPath!))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.entry.标签).toEqual(['AI味'])
  })
})
