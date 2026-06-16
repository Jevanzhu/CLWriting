import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readLead,
  writeLead,
  parseHistory,
  stringifyHistory,
  readLeadDir,
  parseLeadFileName,
} from '../../src/format/leads.js'
import type { Lead } from '../../src/format/types.js'

// ── 履历解析（③ 第 4 节）────────────────────────

test('parseHistory: 解析履历列表', () => {
  const body = `
## 履历

- 第012章 埋下：林家祠堂暗格被一笔带过，"那道焦痕在烛火下泛着暗红"。
- 第047章 推进：管家提到"老爷出事那夜，后门的狗没叫"。
- 第152章 回收：揭穿真凶是二叔。
`
  const entries = parseHistory(body)
  expect(entries).toHaveLength(3)
  expect(entries[0]!.章号).toBe(12)
  expect(entries[0]!.动词).toBe('埋下')
  expect(entries[0]!.证据).toContain('焦痕')
  expect(entries[2]!.动词).toBe('回收')
})

test('parseHistory: 回填标记（③ 第 4 节）', () => {
  const body = `## 履历

- 第050章 埋下：早期线索（回填·卷摘要级）`
  const entries = parseHistory(body)
  expect(entries[0]!.回填).toBe(true)
  expect(entries[0]!.证据).toBe('早期线索')
})

test('stringifyHistory + parseHistory 往返', () => {
  const entries = [
    { 章号: 12, 动词: '埋下', 证据: '焦痕' },
    { 章号: 88, 动词: '跃迁', 证据: '渡过心魔劫', 回填: true },
  ]
  const text = stringifyHistory(entries)
  const reparsed = parseHistory(text)
  expect(reparsed).toHaveLength(2)
  expect(reparsed[0]!.章号).toBe(12)
  expect(reparsed[1]!.回填).toBe(true)
})

// ── 完整账本读写往返（容错核心）──────────────────

function makeTmpBook(): string {
  return mkdtempSync(join(tmpdir(), '北境往事-'))
}

test('readLead + writeLead: 伏笔往返不丢字段', () => {
  const dir = makeTmpBook()
  const fp = join(dir, '伏笔-031-灭门真凶.md')
  const lead: Lead = {
    编号: '伏笔-031',
    标题: '灭门真凶',
    类型: '伏笔',
    状态: '已收尾',
    开启章: 12,
    履历: [
      { 章号: 12, 动词: '埋下', 证据: '焦痕在烛火下泛着暗红' },
      { 章号: 152, 动词: '回收', 证据: '真凶是二叔' },
    ],
  }
  writeLead(fp, lead)
  const r = readLead(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.lead.编号).toBe('伏笔-031')
    expect(r.lead.状态).toBe('已收尾')
    expect(r.lead.开启章).toBe(12)
    expect(r.lead.履历).toHaveLength(2)
    expect(r.lead.履历[1]!.动词).toBe('回收')
  }
  rmSync(dir, { recursive: true, force: true })
})

test('readLead: 未知字段容错保留', () => {
  const dir = makeTmpBook()
  const fp = join(dir, '伏笔-031.md')
  // 手工写一个含未知字段的文件
  const { writeFileSync } = require('node:fs')
  writeFileSync(fp, [
    '---',
    '编号: 伏笔-031',
    '标题: 灭门真凶',
    '类型: 伏笔',
    '状态: 进行中',
    '开启章: 12',
    '自定义备注: 作者手写的备注',
    '---',
    '',
    '## 履历',
    '',
    '- 第012章 埋下：焦痕',
  ].join('\n'), 'utf-8')

  const r = readLead(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.lead._raw?.['自定义备注']).toBe('作者手写的备注')
  }
  rmSync(dir, { recursive: true, force: true })
})

test('readLead: 成长线特化字段（⑥ 境界体系）', () => {
  const dir = makeTmpBook()
  const fp = join(dir, '成长线-003-林晚修为.md')
  const lead: Lead = {
    编号: '成长线-003',
    标题: '林晚修为',
    类型: '成长线',
    状态: '进行中',
    开启章: 3,
    境界体系: '修真境界',
    当前境界: '筑基',
    履历: [
      { 章号: 3, 动词: '起步', 证据: '开脉踏入炼气一层' },
      { 章号: 88, 动词: '跃迁', 证据: '突破至筑基' },
    ],
  }
  writeLead(fp, lead)
  const r = readLead(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.lead.境界体系).toBe('修真境界')
    expect(r.lead.当前境界).toBe('筑基')
  }
  rmSync(dir, { recursive: true, force: true })
})

test('readLead: 坏文件返回错误不崩', () => {
  const dir = makeTmpBook()
  const fp = join(dir, '坏文件.md')
  const { writeFileSync } = require('node:fs')
  writeFileSync(fp, '没有 front matter 的裸文件', 'utf-8')
  const r = readLead(fp)
  expect(r.ok).toBe(false)
  rmSync(dir, { recursive: true, force: true })
})

// ── 目录扫描（重建器用）────────────────────────

test('readLeadDir: 扫描目录、容错跳过坏文件', () => {
  const dir = makeTmpBook()
  const 伏笔dir = join(dir, '伏笔')
  mkdirSync(伏笔dir)

  // 写两个好的、一个坏的
  writeLead(join(伏笔dir, '伏笔-001-a.md'), {
    编号: '伏笔-001', 标题: 'a', 类型: '伏笔', 状态: '进行中', 开启章: 1, 履历: [],
  })
  writeLead(join(伏笔dir, '伏笔-002-b.md'), {
    编号: '伏笔-002', 标题: 'b', 类型: '伏笔', 状态: '进行中', 开启章: 5, 履历: [],
  })
  const { writeFileSync } = require('node:fs')
  writeFileSync(join(伏笔dir, '伏笔-099-坏.md'), '坏的', 'utf-8')

  const { leads, errors } = readLeadDir(伏笔dir)
  expect(leads).toHaveLength(2)
  expect(errors).toHaveLength(1)
  rmSync(dir, { recursive: true, force: true })
})

test('readLeadDir: 目录不存在返回空（未启用类）', () => {
  const { leads, errors } = readLeadDir(join(tmpdir(), '不存在的目录-' + Date.now()))
  expect(leads).toHaveLength(0)
  expect(errors).toHaveLength(0)
})

// ── 文件名解析 ─────────────────────────────────

test('parseLeadFileName', () => {
  expect(parseLeadFileName('伏笔-031-灭门真凶.md')).toEqual({ 编号: '伏笔-031', 标题: '灭门真凶' })
  expect(parseLeadFileName('成长线-003-林晚修为.md')).toEqual({ 编号: '成长线-003', 标题: '林晚修为' })
  expect(parseLeadFileName('乱七八糟.md')).toBeNull()
})
