import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables, clearAllTables } from '../../src/cache/schema.js'
import {
  syncLead,
  loadLeadFromCache,
  syncChapter,
  syncSummary,
  setMeta,
  getMeta,
} from '../../src/cache/sync.js'
import type { Lead } from '../../src/format/types.js'

function makeDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), '北境往事-'))
  const db = new DatabaseSync(join(dir, 'index.db'))
  createAllTables(db)
  return { db, dir }
}

test('createAllTables: 建 5 表成功', () => {
  const { db, dir } = makeDb()
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
  ).all() as { name: string }[]
  const names = tables.map((t) => t.name)
  expect(names).toContain('leads')
  expect(names).toContain('lead_history')
  expect(names).toContain('chapters')
  expect(names).toContain('summaries')
  expect(names).toContain('meta')
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('syncLead + loadLeadFromCache: 伏笔写入回读一致', () => {
  const { db, dir } = makeDb()
  const lead: Lead = {
    编号: '伏笔-031',
    标题: '灭门真凶',
    类型: '伏笔',
    状态: '已收尾',
    开启章: 12,
    履历: [
      { 章号: 12, 动词: '埋下', 证据: '焦痕' },
      { 章号: 47, 动词: '推进', 证据: '狗不叫' },
      { 章号: 152, 动词: '回收', 证据: '二叔是真凶' },
    ],
    _path: '大纲/伏笔/伏笔-031-灭门真凶.md',
  }
  syncLead(db, lead)
  const loaded = loadLeadFromCache(db, '伏笔-031')
  expect(loaded).not.toBeNull()
  expect(loaded!.编号).toBe('伏笔-031')
  expect(loaded!.类型).toBe('伏笔')
  expect(loaded!.开启章).toBe(12)
  expect(loaded!.履历).toHaveLength(3)
  expect(loaded!.履历[1]!.动词).toBe('推进')
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('syncLead: 成长线特化字段（cur_realm）映射', () => {
  const { db, dir } = makeDb()
  const lead: Lead = {
    编号: '成长线-003',
    标题: '林晚修为',
    类型: '成长线',
    状态: '进行中',
    开启章: 3,
    当前境界: '筑基',
    履历: [{ 章号: 88, 动词: '跃迁', 证据: '渡过心魔劫' }],
    _path: '大纲/成长线/成长线-003.md',
  }
  syncLead(db, lead)
  const loaded = loadLeadFromCache(db, '成长线-003')
  expect(loaded!.当前境界).toBe('筑基')
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('syncLead: 幂等（重复写不重复履历）', () => {
  const { db, dir } = makeDb()
  const lead: Lead = {
    编号: '伏笔-001', 标题: 'a', 类型: '伏笔', 状态: '进行中', 开启章: 1,
    履历: [{ 章号: 1, 动词: '埋下', 证据: 'x' }], _path: 'p',
  }
  syncLead(db, lead)
  syncLead(db, lead) // 重复
  const count = db.prepare('SELECT count(*) AS c FROM lead_history WHERE lead_id=?').get('伏笔-001') as { c: number }
  expect(count.c).toBe(1) // 不重复
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('syncChapter + syncSummary + setMeta', () => {
  const { db, dir } = makeDb()
  syncChapter(db, {
    章号: 152, 标题: '北境的雪', 钩子类型: '悬念钩', 钩子强弱: '强',
    情绪定位: '转折', _wordCount: 3200, _path: '定稿/正文/152-北境的雪.md',
  })
  const ch = db.prepare('SELECT * FROM chapters WHERE number=152').get() as Record<string, unknown>
  expect(ch['title']).toBe('北境的雪')
  expect(ch['word_count']).toBe(3200)
  expect(ch['hook_type']).toBe('悬念钩')

  syncSummary(db, 'chapter', 152, '定稿/摘要/章摘要/152.md')
  const sm = db.prepare('SELECT path FROM summaries WHERE scope=? AND ref=?').get('chapter', 152) as { path: string }
  expect(sm.path).toBe('定稿/摘要/章摘要/152.md')

  setMeta(db, 'rebuilt_at', '2026-06-16T12:00:00Z')
  expect(getMeta(db, 'rebuilt_at')).toBe('2026-06-16T12:00:00Z')

  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('clearAllTables: 清空保留结构', () => {
  const { db, dir } = makeDb()
  setMeta(db, 'k', 'v')
  clearAllTables(db)
  expect(getMeta(db, 'k')).toBeNull()
  // 表还在
  const tables = db.prepare(`SELECT count(*) AS c FROM sqlite_master WHERE type='table'`).get() as { c: number }
  expect(tables.c).toBeGreaterThanOrEqual(5)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})
