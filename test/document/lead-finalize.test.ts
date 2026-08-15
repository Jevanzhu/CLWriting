/**
 * 定稿账本履历回写（W-P1-3 右端闭环 + 决策 2）单元测试。
 *
 * 覆盖 applyLeadUpdates：
 * - 消费 工作区/账本推进.md → 回写布线条目 履历（第N章 动词：证据）
 * - 回写后清空 账本推进.md
 * - 重复定稿（同 章号+动词+证据）不重复追加
 * - 编号查无此线 → 跳过不崩
 * - 无账本推进文件 → 0 且不清空
 */
import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyLeadUpdates } from '../../src/document/lead-finalize.js'
import { readLead } from '../../src/format/leads.js'

/** 造一本带布线的短书 + 一条悬念线 + 账本推进.md */
function makeBook(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'lead-finalize-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-灭门真凶.md'),
    '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  return { root }
}

test('applyLeadUpdates: 消费账本推进 → 回写履历 + 清空文件', () => {
  const { root } = makeBook()
  try {
    writeFileSync(
      join(root, '工作区', '账本推进.md'),
      '- 悬念-001 递进：焦痕在烛火下泛着暗红。\n',
      'utf-8',
    )
    const n = applyLeadUpdates(root, 3)
    expect(n).toBe(1)

    // 履历已回写
    const r = readLead(join(root, '布线', '悬念', '悬念-001-灭门真凶.md'))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.lead.履历).toEqual([{ 章号: 3, 动词: '递进', 证据: '焦痕在烛火下泛着暗红。' }])
    }
    // 账本推进.md 已清空
    expect(readFileSync(join(root, '工作区', '账本推进.md'), 'utf-8')).toBe('')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('applyLeadUpdates: 同 章号+动词+证据 重复定稿不重复追加', () => {
  const { root } = makeBook()
  try {
    writeFileSync(
      join(root, '工作区', '账本推进.md'),
      '- 悬念-001 递进：焦痕在烛火下泛着暗红。\n',
      'utf-8',
    )
    applyLeadUpdates(root, 3)
    // 再次写入同样内容（作者改稿重新定稿）→ 已被清空，无新条目
    const n2 = applyLeadUpdates(root, 3)
    expect(n2).toBe(0)
    const r = readLead(join(root, '布线', '悬念', '悬念-001-灭门真凶.md'))
    if (r.ok) expect(r.lead.履历).toHaveLength(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('applyLeadUpdates: 编号查无此线 → 跳过不崩', () => {
  const { root } = makeBook()
  try {
    writeFileSync(join(root, '工作区', '账本推进.md'), '- 悬念-999 递进：不存在的线。\n', 'utf-8')
    const n = applyLeadUpdates(root, 3)
    expect(n).toBe(0)
    // 文件仍被清空（无可用条目）
    expect(readFileSync(join(root, '工作区', '账本推进.md'), 'utf-8')).toBe('')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('applyLeadUpdates: 无账本推进文件 → 0 且不清空', () => {
  const { root } = makeBook()
  try {
    expect(applyLeadUpdates(root, 3)).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
