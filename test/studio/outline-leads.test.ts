/**
 * outline 左端（W-P1-3）：细纲 推进: fm 生产。
 *
 * - parseOutlineLeads：从 AI 产出解析最后一行 推进: → 白名单过滤编号
 * - 端点：长篇 + 布线时 细纲.md fm 含 推进: [...]（mock 产出无 推进 行 → 显式 []）
 */
import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseOutlineLeads } from '../../src/studio/server/api/outline.js'
import { readOutlineLeads } from '../../src/check/outline-leads.js'

function makeWiringBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'outline-leads-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n',
    'utf-8',
  )
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-灭门真凶.md'),
    '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  writeFileSync(
    join(root, '布线', '悬念', '悬念-002-黑手.md'),
    '---\n编号: 悬念-002\n标题: 黑手\n类型: 悬念\n状态: 已收尾\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  return root
}

test('parseOutlineLeads: 解析最后一行 推进:，白名单过滤（臆造/已收尾剔除）', () => {
  const root = makeWiringBook()
  try {
    const text = [
      '# 本章细纲',
      '场景：叙事铺陈',
      '推进: 悬念-001, 悬念-999',
      '正文里也提到推进：但这不是声明行',
    ].join('\n')
    // 最后匹配的 推进: 行是「正文里也提到推进：...」——它含冒号但不是行首，正则 ^ 不匹配
    const out = parseOutlineLeads(text, root)
    expect(out).toEqual(['悬念-001'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('parseOutlineLeads: 无声明行 → 空数组', () => {
  const root = makeWiringBook()
  try {
    expect(parseOutlineLeads('## 细纲\n无推进', root)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('parseOutlineLeads: 已收尾编号不在白名单 → 剔除', () => {
  const root = makeWiringBook()
  try {
    const out = parseOutlineLeads('推进: 悬念-002, 悬念-001', root)
    expect(out).toEqual(['悬念-001'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('闭环：parseOutlineLeads 产出可直接写 fm → readOutlineLeads 读回', () => {
  const root = makeWiringBook()
  try {
    const ids = parseOutlineLeads('推进: 悬念-001', root)
    expect(ids).toEqual(['悬念-001'])
    // 模拟端点写 fm（与 outline.ts 同格式：推进: [id1, id2]）
    writeFileSync(
      join(root, '工作区', '细纲.md'),
      '---\n章号: 1\n推进: [' + ids.join(', ') + ']\n---\n\n本章细纲。\n',
      'utf-8',
    )
    expect(readOutlineLeads(root, 1)).toEqual(['悬念-001'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
