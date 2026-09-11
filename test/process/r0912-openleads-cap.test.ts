/**
 * R0912-6（2026-09-11 修复批）回归：近况段进行中线索 cap。
 *
 * 背景：assembleStatus 的 openLeads 取全部「进行中」无 cap，而近况段是 essential
 * （prepare 刚需不砍）——超长篇数百线时近况段无限膨胀。修复在膨胀源头封住：
 * 快照只保留最近 50 条（按 opened_at 升序现有排序取尾部 = 最近开启的线），超限数
 * 随快照透出（openLeadsOmitted），formatStatus 追加提示行「（另有 N 条进行中线索
 * 未列入）」；未超限不携带该字段、无提示行（消费方零感知）。prepare 侧不动。
 */
import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { rmSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables } from '../../src/cache/schema.js'
import { syncLead } from '../../src/cache/sync.js'
import { assembleStatus, formatStatus } from '../../src/process/assemble.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'

function makeDbWithLeads(count: number): { db: DatabaseSync; dir: string } {
  const dir = mkdtempTracked(join(tmpdir(), 'r0912-openleads-'))
  const db = new DatabaseSync(join(dir, 'index.db'))
  createAllTables(db)
  for (let i = 1; i <= count; i++) {
    syncLead(db, {
      编号: `悬念-${String(i).padStart(3, '0')}`,
      标题: `第${i}条线`,
      类型: '悬念',
      状态: '进行中',
      开启章: i,
      履历: [],
      _path: 'p',
    })
  }
  return { db, dir }
}

test('R0912-6: 进行中线 60 条 → 快照只留最近 50 条 + openLeadsOmitted=10 + 文本提示行', () => {
  const { db, dir } = makeDbWithLeads(60)
  try {
    const s = assembleStatus(db, DEFAULT_CONFIG, 50)
    expect(s.openLeads).toHaveLength(50)
    expect(s.openLeadsOmitted).toBe(10)
    // 保留的是最近开启的 50 条（opened_at 升序取尾部）：最早 10 条被省略，保序不变
    expect(s.openLeads[0]!.id).toBe('悬念-011')
    expect(s.openLeads[0]!.openedAt).toBe(11)
    expect(s.openLeads[49]!.id).toBe('悬念-060')
    const text = formatStatus(s)
    expect(text).toContain('（另有 10 条进行中线索未列入）')
    expect(text).toContain('【进行中的线】50 条')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R0912-6: 未超上限 → 不携带 openLeadsOmitted、无提示行（消费方零感知）', () => {
  const { db, dir } = makeDbWithLeads(3)
  try {
    const s = assembleStatus(db, DEFAULT_CONFIG, 50)
    expect(s.openLeads).toHaveLength(3)
    expect(s.openLeadsOmitted).toBeUndefined()
    const text = formatStatus(s)
    expect(text).toContain('【进行中的线】3 条')
    expect(text).not.toContain('未列入')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R0912-6: 恰好 50 条 → 全量保留、无省略（边界不触发 cap）', () => {
  const { db, dir } = makeDbWithLeads(50)
  try {
    const s = assembleStatus(db, DEFAULT_CONFIG, 50)
    expect(s.openLeads).toHaveLength(50)
    expect(s.openLeadsOmitted).toBeUndefined()
    expect(formatStatus(s)).not.toContain('未列入')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
