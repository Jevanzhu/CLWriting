import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables } from '../../src/cache/schema.js'
import { syncLead, syncChapter, syncSummary } from '../../src/cache/sync.js'
import {
  readLeadHistory,
  readLeadStatus,
  readStaleLeads,
  readChapterLocation,
  readChapterSummaries,
  readVolumeSummaries,
  readGrowthHistory,
  readCurrentRealm,
} from '../../src/cli/read.js'
import type { Lead } from '../../src/format/types.js'

function makeSeededDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), '北境往事-'))
  const db = new DatabaseSync(join(dir, 'index.db'))
  createAllTables(db)

  // 伏笔（已收尾）
  syncLead(db, {
    编号: '伏笔-031', 标题: '灭门真凶', 类型: '伏笔', 状态: '已收尾', 开启章: 12,
    履历: [
      { 章号: 12, 动词: '埋下', 证据: '焦痕' },
      { 章号: 152, 动词: '回收', 证据: '二叔' },
    ], _path: 'p1',
  })
  // 悬念（进行中，悬太久）
  syncLead(db, {
    编号: '悬念-008', 标题: '神秘老者', 类型: '悬念', 状态: '进行中', 开启章: 8,
    履历: [{ 章号: 8, 动词: '设下', 证据: '老者' }], _path: 'p2',
  })
  // 成长线（当前境界）
  syncLead(db, {
    编号: '成长线-003', 标题: '林晚修为', 类型: '成长线', 状态: '进行中', 开启章: 3,
    当前境界: '筑基',
    履历: [
      { 章号: 3, 动词: '起步', 证据: '炼气' },
      { 章号: 88, 动词: '跃迁', 证据: '筑基' },
    ], _path: 'p3',
  })

  // 章节
  syncChapter(db, {
    章号: 152, 标题: '北境的雪', 钩子类型: '悬念钩', 钩子强弱: '强',
    情绪定位: '转折', _wordCount: 3200, _path: '定稿/正文/152-北境的雪.md',
  })

  // 摘要
  syncSummary(db, 'chapter', 150, 's150.md')
  syncSummary(db, 'chapter', 151, 's151.md')
  syncSummary(db, 'chapter', 152, 's152.md')
  syncSummary(db, 'volume', 1, 'v1.md')

  return { db, dir }
}

// ④ 第 4 节逐条查询测试

test('readLeadHistory: 读伏笔履历', () => {
  const { db, dir } = makeSeededDb()
  const h = readLeadHistory(db, '伏笔-031')
  expect(h).toHaveLength(2)
  expect(h[0]!.动词).toBe('埋下')
  expect(h[1]!.章号).toBe(152)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('readLeadStatus: 读感情线/悬念状态', () => {
  const { db, dir } = makeSeededDb()
  const s = readLeadStatus(db, '悬念-008')
  expect(s).not.toBeNull()
  expect(s!.status).toBe('进行中')
  expect(s!.type).toBe('悬念')
  expect(readLeadStatus(db, '不存在-999')).toBeNull()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('readStaleLeads: 悬太久候选', () => {
  const { db, dir } = makeSeededDb()
  // 当前章 160，悬念-008 开启于 8 章 → age 152，超默认阈值 30
  const stale = readStaleLeads(db, 160, { 悬念: 30 })
  const 悬念 = stale.find((s) => s.id === '悬念-008')
  expect(悬念).toBeDefined()
  expect(悬念!.age).toBe(152)
  expect(悬念!.overThreshold).toBe(true)
  // 成长线 age 157 也超
  const 成长 = stale.find((s) => s.id === '成长线-003')
  expect(成长!.overThreshold).toBe(true)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('readChapterLocation: 章定位', () => {
  const { db, dir } = makeSeededDb()
  const loc = readChapterLocation(db, 152)
  expect(loc).not.toBeNull()
  expect(loc!.path).toBe('定稿/正文/152-北境的雪.md')
  expect(loc!.wordCount).toBe(3200)
  expect(readChapterLocation(db, 999)).toBeNull()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('readChapterSummaries: 读章范围摘要', () => {
  const { db, dir } = makeSeededDb()
  const s = readChapterSummaries(db, 150, 152)
  expect(s).toHaveLength(3)
  expect(s[0]!.ref).toBe(150)
  expect(s[2]!.path).toBe('s152.md')
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('readVolumeSummaries: 读卷摘要', () => {
  const { db, dir } = makeSeededDb()
  const v = readVolumeSummaries(db)
  expect(v).toHaveLength(1)
  expect(v[0]!.ref).toBe(1)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('readGrowthHistory + readCurrentRealm: 成长线机检取数', () => {
  const { db, dir } = makeSeededDb()
  const h = readGrowthHistory(db, '成长线-003')
  expect(h).toHaveLength(2)
  expect(h[1]!.verb).toBe('跃迁')
  expect(readCurrentRealm(db, '成长线-003')).toBe('筑基')
  db.close()
  rmSync(dir, { recursive: true, force: true })
})
