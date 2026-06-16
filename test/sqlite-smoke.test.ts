import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 母本第 9 节 M0 出口：建库→读写→删库重建，坐实 node:sqlite RC 在 ≥24 实际可用。
// 临时目录前缀含中文，顺带验证中文落盘（Windows 中文一等公民的最小覆盖）。
test('node:sqlite 建库→读写→删库重建（含中文落盘）', () => {
  const dir = mkdtempSync(join(tmpdir(), '北境的雪-'))
  const dbPath = join(dir, 'index.db')

  // 建库 + 写（含中文值）
  const db1 = new DatabaseSync(dbPath)
  db1.exec('CREATE TABLE leads (id INTEGER PRIMARY KEY, name TEXT)')
  db1.prepare('INSERT INTO leads (name) VALUES (?)').run('伏笔-031')
  const row = db1.prepare('SELECT name FROM leads WHERE id = 1').get() as { name: string }
  expect(row.name).toBe('伏笔-031')
  db1.close()
  expect(existsSync(dbPath)).toBe(true)

  // 删库
  rmSync(dbPath)
  expect(existsSync(dbPath)).toBe(false)

  // 重建：删了能从零建回（M1 重建器的最小前身）
  const db2 = new DatabaseSync(dbPath)
  db2.exec('CREATE TABLE leads (id INTEGER PRIMARY KEY, name TEXT)')
  const count = db2.prepare('SELECT count(*) AS c FROM leads').get() as { c: number }
  expect(count.c).toBe(0)
  db2.close()

  rmSync(dir, { recursive: true, force: true })
})
