/**
 * RB-IF-P2-5：readOpenLeads 的关系线目录口径。
 *
 * 关系线物理目录在 大纲/关系线（历史布局，cache/rebuild.ts 已特判），
 * 原先 readOpenLeads 只扫 布线/<类型>——启用关系线的书其进行中账本
 * 永远进不了账本推进 prompt。此处锁住两目录口径一致。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readOpenLeads } from '../../src/process/open-leads.js'
import { writeLead } from '../../src/format/leads.js'

function makeBook(enabled: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'open-leads-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 测试\nhost: cc\nleads:\n  enabled: [' +
      enabled.join(', ') +
      ']\n',
    'utf-8',
  )
  return root
}

test('RB-IF-P2-5: 启用关系线 → 大纲/关系线 的进行中账本进入推进候选', () => {
  const root = makeBook(['关系线'])
  try {
    const 关系dir = join(root, '大纲', '关系线')
    mkdirSync(关系dir, { recursive: true })
    writeLead(join(关系dir, '关系线-001-师徒债.md'), {
      编号: '关系线-001', 标题: '师徒债', 类型: '关系线', 状态: '进行中', 开启章: 1,
      欠方: '林晚', 债主: '师尊',
      履历: [{ 章号: 1, 动词: '结下', 证据: '一碗罚酒' }],
    })
    const open = readOpenLeads(root)
    expect(open).toHaveLength(1)
    expect(open[0]!.编号).toBe('关系线-001')
    expect(open[0]!.状态).toBe('进行中')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readOpenLeads: 基础类（布线/悬念）行为不回归 + 已收尾不入候选', () => {
  const root = makeBook([])
  try {
    const 悬念dir = join(root, '布线', '悬念')
    writeLead(join(悬念dir, '悬念-001-夜行者.md'), {
      编号: '悬念-001', 标题: '夜行者', 类型: '悬念', 状态: '进行中', 开启章: 1,
      履历: [{ 章号: 1, 动词: '设下', 证据: '雨夜敲门' }],
    })
    writeLead(join(悬念dir, '悬念-002-旧案.md'), {
      编号: '悬念-002', 标题: '旧案', 类型: '悬念', 状态: '已收尾', 开启章: 1,
      履历: [
        { 章号: 1, 动词: '设下', 证据: '卷宗' },
        { 章号: 5, 动词: '揭晓', 证据: '翻案' },
      ],
    })
    const open = readOpenLeads(root)
    expect(open).toHaveLength(1)
    expect(open[0]!.编号).toBe('悬念-001')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
