import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLayoutV2 } from '../../src/install/migrate-layout-v2.js'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'clw-migrate-v2-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** 写占位文件（自动建父目录）。 */
function write(rel: string, content = '占位'): void {
  const segs = rel.split('/')
  mkdirSync(join(tmp, ...segs.slice(0, -1)), { recursive: true })
  writeFileSync(join(tmp, ...segs), content, 'utf-8')
}

/** 判相对路径是否存在。 */
function has(rel: string): boolean {
  return existsSync(join(tmp, ...rel.split('/')))
}

// ── 长篇书库完整迁移 ──────────────────────────────

test('长篇书库：v1 目录 → v2', () => {
  write('定稿/正文/第一卷/0001-开篇.md')
  write('定稿/设定/角色/主角.md')
  write('定稿/设定/世界观.md')
  write('大纲/总纲.md')
  write('大纲/卷纲/第一卷.md')
  write('大纲/章纲/0001-开篇.md')
  write('大纲/悬念/001-谜团.md')
  write('大纲/感情线/001-初遇.md')
  write('工作区/草稿-1.md')
  write('工作区/细纲.md')
  // 运行时资产（不应被搬）
  write('工作区/.journal/doc_x.jsonl')
  write('工作区/.snapshots/doc_x/001.md')

  const r = migrateLayoutV2(tmp)
  expect(r.errors).toEqual([])

  // 正文 + 卷子目录整体搬迁
  expect(has('写作/正文/第一卷/0001-开篇.md')).toBe(true)
  // 设定提升根级
  expect(has('设定/角色/主角.md')).toBe(true)
  expect(has('设定/世界观.md')).toBe(true)
  // 线索 → 布线
  expect(has('布线/悬念/001-谜团.md')).toBe(true)
  expect(has('布线/感情线/001-初遇.md')).toBe(true)
  // 大纲纲领类不动
  expect(has('大纲/总纲.md')).toBe(true)
  expect(has('大纲/卷纲/第一卷.md')).toBe(true)
  expect(has('大纲/章纲/0001-开篇.md')).toBe(true)
  // 草稿
  expect(has('写作/草稿/草稿-1.md')).toBe(true)
  expect(has('写作/草稿/细纲.md')).toBe(true)
  // 运行时资产保留原位
  expect(has('工作区/.journal/doc_x.jsonl')).toBe(true)
  expect(has('工作区/.snapshots/doc_x/001.md')).toBe(true)
})

// ── 短篇书库：篇即正文，迁到 写作/正文 ───────────

test('短篇书库：篇/ → 写作/正文/（篇即章）', () => {
  write('篇/001-雪夜.md')
  write('清单/001-雪夜.md')
  write('文风/铁律.md')

  const r = migrateLayoutV2(tmp)
  expect(r.errors).toEqual([])
  expect(has('写作/正文/001-雪夜.md')).toBe(true)
  expect(has('大纲/章纲/001-雪夜.md')).toBe(true)
  // 文风保留原位（幕后资产）
  expect(has('文风/铁律.md')).toBe(true)
})

// ── 幂等 ──────────────────────────────────────────

test('幂等：第二次跑 migrated=0', () => {
  write('定稿/正文/0001-x.md')
  write('定稿/设定/世界观.md')
  write('大纲/悬念/001-x.md')

  const r1 = migrateLayoutV2(tmp)
  expect(r1.errors).toEqual([])
  expect(r1.migrated).toBeGreaterThan(0)

  const r2 = migrateLayoutV2(tmp)
  expect(r2.errors).toEqual([])
  expect(r2.migrated).toBe(0)
})

// ── 运行时资产不动 ────────────────────────────────

test('运行时资产保留原位，草稿搬走', () => {
  write('工作区/.trash/doc_x-旧.md')
  write('工作区/.journal/doc_x.jsonl')
  write('工作区/.snapshots/doc_x/001.md')
  write('工作区/待定稿/0001-x.md')
  write('工作区/草稿-1.md')

  const r = migrateLayoutV2(tmp)
  expect(r.errors).toEqual([])
  // 运行时资产不动
  expect(has('工作区/.trash/doc_x-旧.md')).toBe(true)
  expect(has('工作区/.journal/doc_x.jsonl')).toBe(true)
  expect(has('工作区/.snapshots/doc_x/001.md')).toBe(true)
  expect(has('工作区/待定稿/0001-x.md')).toBe(true)
  // 草稿搬走
  expect(has('写作/草稿/草稿-1.md')).toBe(true)
  expect(has('工作区/草稿-1.md')).toBe(false)
})

// ── 空书库 no-op ──────────────────────────────────

test('空书库：no-op', () => {
  const r = migrateLayoutV2(tmp)
  expect(r.migrated).toBe(0)
  expect(r.errors).toEqual([])
})
