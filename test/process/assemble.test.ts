import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables } from '../../src/cache/schema.js'
import { syncLead, syncChapter } from '../../src/cache/sync.js'
import { assembleStatus, formatStatus } from '../../src/process/assemble.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { BookConfig } from '../../src/format/types.js'

function makeSeededDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), '北境往事-'))
  const db = new DatabaseSync(join(dir, 'index.db'))
  createAllTables(db)

  // 章节（到第 152 章）
  for (let n = 150; n <= 152; n++) {
    syncChapter(db, {
      章号: n, 标题: `第${n}章`, 钩子类型: '悬念钩', 钩子强弱: '强',
      情绪定位: n === 152 ? '转折' : '铺垫', _wordCount: 3000, _path: `p${n}`,
    })
  }

  // 账本
  syncLead(db, {
    编号: '伏笔-031', 标题: '灭门真凶', 类型: '伏笔', 状态: '已收尾', 开启章: 12,
    履历: [], _path: 'p',
  })
  syncLead(db, {
    编号: '悬念-008', 标题: '神秘老者', 类型: '悬念', 状态: '进行中', 开启章: 8,
    履历: [], _path: 'p',
  })
  syncLead(db, {
    编号: '成长线-003', 标题: '林晚修为', 类型: '成长线', 状态: '进行中', 开启章: 3,
    履历: [], _path: 'p',
  })

  return { db, dir }
}

test('assembleStatus: 已写章号 + 卷号', () => {
  const { db, dir } = makeSeededDb()
  const s = assembleStatus(db, DEFAULT_CONFIG, 50)
  expect(s.currentChapter).toBe(152)
  expect(s.currentVolume).toBe(4) // ceil(152/50)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('assembleStatus: 进行中的线（不含已收尾）', () => {
  const { db, dir } = makeSeededDb()
  const s = assembleStatus(db, DEFAULT_CONFIG)
  expect(s.openLeads).toHaveLength(2) // 悬念-008 + 成长线-003（伏笔-031 已收尾）
  const ids = s.openLeads.map((l) => l.id)
  expect(ids).toContain('悬念-008')
  expect(ids).toContain('成长线-003')
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('assembleStatus: 悬太久预警（超阈值）', () => {
  const { db, dir } = makeSeededDb()
  const s = assembleStatus(db, DEFAULT_CONFIG)
  // 当前 152 章，悬念-008 开启于 8 → age 144，超默认阈值 10
  const 悬念 = s.staleLeads.find((l) => l.id === '悬念-008')
  expect(悬念).toBeDefined()
  expect(悬念!.age).toBe(144)
  expect(悬念!.threshold).toBe(10)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('assembleStatus: book.yaml thresholds 覆盖默认', () => {
  const { db, dir } = makeSeededDb()
  const cfg: BookConfig = { ...DEFAULT_CONFIG, leads: { enabled: [], thresholds: { 悬念: 200 } } }
  const s = assembleStatus(db, cfg)
  // 阈值提到 200 → 悬念-008 age 144 不再超阈
  const 悬念 = s.staleLeads.find((l) => l.id === '悬念-008')
  expect(悬念).toBeUndefined()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('assembleStatus: 近章钩子/情绪', () => {
  const { db, dir } = makeSeededDb()
  const s = assembleStatus(db, DEFAULT_CONFIG)
  expect(s.recentChapters).toHaveLength(3)
  expect(s.recentChapters[2]!.number).toBe(152) // 升序，最后是最新
  expect(s.recentChapters[2]!.emotion).toBe('转折')
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('assembleStatus: 空书（0 章）', () => {
  const dir = mkdtempSync(join(tmpdir(), '空书-'))
  const db = new DatabaseSync(join(dir, 'index.db'))
  createAllTables(db)
  const s = assembleStatus(db, DEFAULT_CONFIG)
  expect(s.currentChapter).toBe(0)
  expect(s.currentVolume).toBe(1)
  expect(s.openLeads).toHaveLength(0)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('formatStatus: 人话输出', () => {
  const { db, dir } = makeSeededDb()
  const s = assembleStatus(db, DEFAULT_CONFIG)
  const text = formatStatus(s)
  expect(text).toContain('已写到第 152 章')
  expect(text).toContain('悬太久')
  expect(text).toContain('悬念-008')
  db.close()
  rmSync(dir, { recursive: true, force: true })
})
