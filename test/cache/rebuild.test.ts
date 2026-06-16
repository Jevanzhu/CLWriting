import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rebuild } from '../../src/cache/rebuild.js'
import { createAllTables } from '../../src/cache/schema.js'
import { loadLeadFromCache } from '../../src/cache/sync.js'
import { writeLead } from '../../src/format/leads.js'
import { writeBookConfig } from '../../src/format/yaml.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { Lead, BookConfig } from '../../src/format/types.js'

/** 造一个完整的书仓库 fixture（含 book.yaml + 账本 + 章节 + 摘要） */
function makeBookFixture(): string {
  // 用中文目录名（验证中文路径全链路）
  const root = mkdtempSync(join(tmpdir(), '北境往事-'))

  // book.yaml：启用 局线 + 成长线（扩展类）
  const cfg: BookConfig = {
    ...DEFAULT_CONFIG,
    book: { title: '北境往事', genre: '玄幻' },
    leads: { enabled: ['成长线'], thresholds: { 成长线: 50 } },
  }
  writeBookConfig(join(root, 'book.yaml'), cfg)

  // 大纲/伏笔/（基础类）— 2 个条目
  const 伏笔dir = join(root, '大纲', '伏笔')
  mkdirSync(伏笔dir, { recursive: true })
  writeLead(join(伏笔dir, '伏笔-031-灭门真凶.md'), {
    编号: '伏笔-031', 标题: '灭门真凶', 类型: '伏笔', 状态: '已收尾', 开启章: 12,
    履历: [
      { 章号: 12, 动词: '埋下', 证据: '焦痕在烛火下泛着暗红' },
      { 章号: 152, 动词: '回收', 证据: '真凶是二叔' },
    ],
  })
  writeLead(join(伏笔dir, '伏笔-008-神秘令牌.md'), {
    编号: '伏笔-008', 标题: '神秘令牌', 类型: '伏笔', 状态: '进行中', 开启章: 5,
    履历: [{ 章号: 5, 动词: '埋下', 证据: '玄阶令牌' }],
  })

  // 大纲/成长线/（book.yaml 启用的扩展类）— 1 个条目
  const 成长dir = join(root, '大纲', '成长线')
  mkdirSync(成长dir, { recursive: true })
  writeLead(join(成长dir, '成长线-003-林晚修为.md'), {
    编号: '成长线-003', 标题: '林晚修为', 类型: '成长线', 状态: '进行中', 开启章: 3,
    当前境界: '筑基', 境界体系: '修真境界',
    履历: [
      { 章号: 3, 动词: '起步', 证据: '开脉炼气一层' },
      { 章号: 88, 动词: '跃迁', 证据: '突破至筑基' },
    ],
  })

  // 大纲/局线/（未启用 → 目录不存在，重建跳过）
  // 大纲/悬念/（基础类，但本次不写文件 → 空目录）
  mkdirSync(join(root, '大纲', '悬念'), { recursive: true })

  // 定稿/正文/— 1 章
  const 正文dir = join(root, '定稿', '正文')
  mkdirSync(正文dir, { recursive: true })
  writeFileSync(
    join(正文dir, '152-北境的雪.md'),
    '---\n章号: 152\n标题: 北境的雪\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 转折\n---\n\n北境下雪了，林晚踏雪而行。\n',
    'utf-8',
  )

  // 定稿/摘要/章摘要/— 1 条
  const 章摘要dir = join(root, '定稿', '摘要', '章摘要')
  mkdirSync(章摘要dir, { recursive: true })
  writeFileSync(join(章摘要dir, '152.md'), '林晚抵达北境，揭开灭门线索。', 'utf-8')

  return root
}

test('rebuild: 全量重建 + 数据一致（中文路径全链路）', () => {
  const root = makeBookFixture()
  const cachePath = join(root, '.cache', 'index.db')

  // 第一次重建
  const result = rebuild(root, cachePath)
  expect(existsSync(cachePath)).toBe(true)
  expect(result.leadCount).toBe(3) // 伏笔×2 + 成长线×1
  expect(result.chapterCount).toBe(1)
  expect(result.summaryCount).toBe(1)
  expect(result.errors).toHaveLength(0)

  // 验证账本数据逐字段一致
  const db = new DatabaseSync(cachePath)
  const lead031 = loadLeadFromCache(db, '伏笔-031')
  expect(lead031).not.toBeNull()
  expect(lead031!.状态).toBe('已收尾')
  expect(lead031!.履历).toHaveLength(2)
  expect(lead031!.履历[1]!.动词).toBe('回收')

  const growth = loadLeadFromCache(db, '成长线-003')
  expect(growth).not.toBeNull()
  expect(growth!.当前境界).toBe('筑基')

  // 验证章节
  const ch = db.prepare('SELECT * FROM chapters WHERE number=152').get() as Record<string, unknown>
  expect(ch['title']).toBe('北境的雪')
  expect(ch['hook_type']).toBe('悬念钩')
  expect(ch['word_count']).toBeGreaterThan(0)

  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('rebuild: 幂等（删 .cache 重建得同一结果）', () => {
  const root = makeBookFixture()
  const cachePath = join(root, '.cache', 'index.db')

  // 第一次重建
  const r1 = rebuild(root, cachePath)

  // 读第一次的账本数
  const db1 = new DatabaseSync(cachePath)
  const c1 = db1.prepare('SELECT count(*) AS c FROM leads').get() as { c: number }
  db1.close()

  // 删 .cache 重建
  rmSync(join(root, '.cache'), { recursive: true, force: true })
  expect(existsSync(cachePath)).toBe(false)

  const r2 = rebuild(root, cachePath)
  const db2 = new DatabaseSync(cachePath)
  const c2 = db2.prepare('SELECT count(*) AS c FROM leads').get() as { c: number }
  db2.close()

  expect(r2.leadCount).toBe(r1.leadCount)
  expect(c2.c).toBe(c1.c) // 逐字段等价

  rmSync(root, { recursive: true, force: true })
})

test('rebuild: 按 book.yaml 启用类扫描（未启用类不扫）', () => {
  const root = makeBookFixture()
  const cachePath = join(root, '.cache', 'index.db')

  // 在未启用的 局线 目录放一个条目（book.yaml 只启用了 成长线）
  const 局线dir = join(root, '大纲', '局线')
  mkdirSync(局线dir, { recursive: true })
  writeLead(join(局线dir, '局线-001-暗流.md'), {
    编号: '局线-001', 标题: '暗流', 类型: '局线', 状态: '进行中', 开启章: 10,
    履历: [{ 章号: 10, 动词: '布局', 证据: '暗流涌动' }],
  })

  const result = rebuild(root, cachePath)
  // 局线未启用 → 不应入库
  expect(result.leadCount).toBe(3)

  const db = new DatabaseSync(cachePath)
  const has = db.prepare('SELECT count(*) AS c FROM leads WHERE id=?').get('局线-001') as { c: number }
  expect(has.c).toBe(0)
  db.close()

  rmSync(root, { recursive: true, force: true })
})

test('rebuild: 容错（坏文件跳过、计入 errors、不中断）', () => {
  const root = makeBookFixture()
  const cachePath = join(root, '.cache', 'index.db')

  // 在伏笔目录加一个坏文件
  writeFileSync(join(root, '大纲', '伏笔', '伏笔-099-坏.md'), '坏的裸文件', 'utf-8')

  const result = rebuild(root, cachePath)
  expect(result.errors.length).toBeGreaterThanOrEqual(1)
  expect(result.leadCount).toBe(3) // 坏文件跳过，其余正常

  rmSync(root, { recursive: true, force: true })
})
