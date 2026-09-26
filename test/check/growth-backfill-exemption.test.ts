/**
 * R35-3（三十五轮）回归：回填条目豁免机检的口径三处锁死。
 *
 * 缺陷：readGrowthHistory 不选 backfill 列（与 readLeadHistory 口径分裂），
 * checkGrowth 按 seq 序全量计入回填条目——回填 seq 必然靠后（后补录），后补的早期
 * 低阶跃迁被判成 growth-regress 假红（回退红项驱动自愈打回没问题的正文、烧预算）。
 *
 * 本文件锁三面：①checkGrowth 尾插回填不产跃迁假红（含无豁免对照组）；
 * ②readGrowthHistory backfill 列映射；③leads.ts 账本三检既有回填豁免的回归锁
 * （只加测试不改 leads.ts——修复前 grep test/ 零回填覆盖，账本侧豁免无锁）。
 */
import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables } from '../../src/cache/schema.js'
import { syncLead } from '../../src/cache/sync.js'
import { checkGrowth } from '../../src/check/growth.js'
import { checkLeadsBookItems } from '../../src/check/leads.js'
import { readGrowthHistory } from '../../src/format/read.js'
import type { RealmDoc } from '../../src/format/types.js'

const REALM_DOC: RealmDoc = { 体系: [{ 名称: '修真', 序列: ['炼气', '筑基', '金丹', '元婴'] }] }

function openDb(): { dir: string; db: DatabaseSync } {
  const dir = mkdtempTracked(join(tmpdir(), 'r35-growth-'))
  const db = new DatabaseSync(join(dir, 'index.db'))
  createAllTables(db)
  return { dir, db }
}

test('R35-3: 尾插回填条目（后补早期低阶跃迁）不产 growth-regress 假红', () => {
  const { dir, db } = openDb()
  try {
    // seq 序：筑基(10) → 金丹(20) → 回补第 5 章炼气跃迁（seq 靠后、章号靠前）
    syncLead(db, {
      编号: '成长线-035', 标题: '修为', 类型: '成长线', 状态: '进行中', 开启章: 1,
      当前境界: '金丹',
      履历: [
        { 章号: 10, 动词: '突破', 证据: '突破至筑基' },
        { 章号: 20, 动词: '突破', 证据: '突破至金丹' },
        { 章号: 5, 动词: '突破', 证据: '突破至炼气', 回填: true },
      ], _path: 'p',
    })
    const r = checkGrowth(db, REALM_DOC, ['成长线-035'], 2)
    expect(r.items.some((i) => i.checkId === 'growth-regress')).toBe(false)
    expect(r.items.some((i) => i.checkId === 'growth-span-exceed')).toBe(false)
    expect(r.items.some((i) => i.level === 'red')).toBe(false)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R35-3: 对照组——同一履历去掉回填标记照产 growth-regress（豁免确实来自回填标记）', () => {
  const { dir, db } = openDb()
  try {
    syncLead(db, {
      编号: '成长线-036', 标题: '修为', 类型: '成长线', 状态: '进行中', 开启章: 1,
      当前境界: '金丹',
      履历: [
        { 章号: 10, 动词: '突破', 证据: '突破至筑基' },
        { 章号: 20, 动词: '突破', 证据: '突破至金丹' },
        { 章号: 5, 动词: '突破', 证据: '突破至炼气' },
      ], _path: 'p',
    })
    const r = checkGrowth(db, REALM_DOC, ['成长线-036'], 2)
    const regress = r.items.find((i) => i.checkId === 'growth-regress')
    expect(regress).toBeDefined()
    expect(regress!.level).toBe('red')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R35-3: readGrowthHistory 映射 backfill 列（对齐 readLeadHistory 的回填字段口径）', () => {
  const { dir, db } = openDb()
  try {
    syncLead(db, {
      编号: '成长线-037', 标题: '修为', 类型: '成长线', 状态: '进行中', 开启章: 1,
      当前境界: '筑基',
      履历: [
        { 章号: 5, 动词: '起步', 证据: '炼气' },
        { 章号: 10, 动词: '突破', 证据: '突破至筑基' },
        { 章号: 3, 动词: '实战', 证据: '炼气小成', 回填: true },
      ], _path: 'p',
    })
    const h = readGrowthHistory(db, '成长线-037')
    expect(h).toHaveLength(3)
    expect(h[0]!.backfill).toBeUndefined()
    expect(h[1]!.backfill).toBeUndefined()
    expect(h[2]!.backfill).toBe(true)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 账本侧回填豁免回归锁（只加测试，leads.ts 零改动）─────────────

/** 造最小书根：正文目录含第 30 章（对照条目的引文在其中，可正常核验）。 */
function makeBookWithChapter30(): string {
  const root = mkdtempTracked(join(tmpdir(), 'r35-leads-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(root, '写作', '正文', '030-第30章.md'),
    '---\n章号: 30\n标题: 第30章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n雪夜灯影之下真相浮出水面。\n',
    'utf-8',
  )
  return root
}

test('R35-3: 账本三检回填豁免锁——回填条目不产 future/disorder/evidence 红项（leads.ts 既有行为）', () => {
  const root = makeBookWithChapter30()
  const dir = mkdtempTracked(join(tmpdir(), 'r35-leads-db-'))
  const db = new DatabaseSync(join(dir, 'index.db'))
  try {
    createAllTables(db)
    syncLead(db, {
      编号: '悬念-035', 标题: '密室', 类型: '悬念', 状态: '进行中', 开启章: 1,
      履历: [
        // 正常条目：章号 ≤ currentChapter、序内、引文在正文命中 → 全绿基准
        { 章号: 30, 动词: '设下', 证据: '雪夜灯影之下真相浮出水面' },
        // 回填声称未来章 → lead-chapter-future 豁免
        { 章号: 999, 动词: '揭晓', 证据: '无关证据', 回填: true },
        // 回填章号乱序（5 < 30）→ lead-chapter-disorder 豁免；引文无从命中 → evidence 豁免
        { 章号: 5, 动词: '递进', 证据: '正文里没有的句子', 回填: true },
      ], _path: 'p',
    })
    const items = checkLeadsBookItems(db, root, 30, ['悬念'])
    expect(items.some((i) => i.checkId === 'lead-chapter-future')).toBe(false)
    expect(items.some((i) => i.checkId === 'lead-chapter-disorder')).toBe(false)
    expect(items.some((i) => i.checkId === 'lead-evidence-miss')).toBe(false)
    expect(items.some((i) => i.checkId === 'lead-evidence-unverifiable')).toBe(false)
    expect(items.filter((i) => i.level === 'red')).toEqual([])
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('R35-3: 账本三检对照组——非回填的未来章声称照产 lead-chapter-future（豁免仅限回填标记）', () => {
  const root = makeBookWithChapter30()
  const dir = mkdtempTracked(join(tmpdir(), 'r35-leads-db2-'))
  const db = new DatabaseSync(join(dir, 'index.db'))
  try {
    createAllTables(db)
    syncLead(db, {
      编号: '悬念-036', 标题: '密室', 类型: '悬念', 状态: '进行中', 开启章: 1,
      履历: [{ 章号: 999, 动词: '揭晓', 证据: '无关证据' }],
      _path: 'p',
    })
    const items = checkLeadsBookItems(db, root, 30, ['悬念'])
    const future = items.find((i) => i.checkId === 'lead-chapter-future')
    expect(future).toBeDefined()
    expect(future!.level).toBe('red')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})
