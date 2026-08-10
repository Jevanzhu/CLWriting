import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLayoutV3 } from '../../src/install/migrate-layout-v3.js'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'clw-migrate-v3-'))
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

// ── 草稿搬迁 ──────────────────────────────────────

test('草稿-1.md → 正文区（resolveDraftPath 推算路径）', () => {
  write('写作/草稿/草稿-1.md', '---\n章号: 1\n标题: 开篇\n---\n正文内容')
  const r = migrateLayoutV3(tmp)
  expect(r.errors).toEqual([])
  expect(r.migrated).toBe(1)
  // resolveDraftPath：无已有章 → 第一卷/001-开篇.md
  expect(has('写作/正文/第一卷/001-开篇.md')).toBe(true)
  expect(has('写作/草稿/草稿-1.md')).toBe(false)
})

test('细纲/本章写作材料 → 工作区/', () => {
  write('写作/草稿/细纲.md', '细纲内容')
  write('写作/草稿/本章写作材料.md', '材料内容')
  const r = migrateLayoutV3(tmp)
  expect(r.errors).toEqual([])
  expect(r.migrated).toBe(2)
  expect(has('工作区/细纲.md')).toBe(true)
  expect(has('工作区/本章写作材料.md')).toBe(true)
  expect(has('写作/草稿/细纲.md')).toBe(false)
})

test('首章细纲 → 大纲/（统一文件名，同目标防覆盖）', () => {
  write('写作/草稿/首篇细纲.md')
  write('写作/草稿/首章细纲.md')
  const r = migrateLayoutV3(tmp)
  expect(r.errors).toEqual([])
  // 两个源抢同一目标 大纲/首章细纲.md → 先到者迁成，后到者防覆盖跳过
  expect(r.migrated).toBe(1)
  expect(has('大纲/首章细纲.md')).toBe(true)
  expect(has('写作/草稿/首章细纲.md')).toBe(false)
})

// ── 幂等 ──────────────────────────────────────────

test('幂等：第二次跑 migrated=0', () => {
  write('写作/草稿/草稿-1.md', '---\n章号: 1\n标题: 开篇\n---\n正文')
  const r1 = migrateLayoutV3(tmp)
  expect(r1.migrated).toBe(1)
  const r2 = migrateLayoutV3(tmp)
  expect(r2.migrated).toBe(0)
  expect(r2.errors).toEqual([])
})

// ── 防覆盖 ────────────────────────────────────────

test('目标已存在（同章号）→ 旧稿回收站，不覆盖', () => {
  write('写作/草稿/草稿-1.md', '---\n章号: 1\n标题: 旧稿\n---\n草稿内容')
  write('写作/正文/第一卷/001-正式.md', '---\n章号: 1\n标题: 正式\n---\n已定稿内容')
  const r = migrateLayoutV3(tmp)
  expect(r.errors).toEqual([])
  expect(r.migrated).toBe(1)
  // 正式内容未被覆盖
  expect(readFileSync(join(tmp, '写作/正文/第一卷/001-正式.md'), 'utf-8')).toContain('已定稿内容')
  // 旧稿进回收站
  expect(has('工作区/.trash/草稿-1.md')).toBe(true)
})

// ── 空书库 ────────────────────────────────────────

test('空书库：no-op', () => {
  const r = migrateLayoutV3(tmp)
  expect(r.migrated).toBe(0)
  expect(r.errors).toEqual([])
})

test('无草稿目录：no-op', () => {
  write('写作/正文/0001-x.md')
  write('book.yaml', 'spec_version: 1')
  const r = migrateLayoutV3(tmp)
  expect(r.migrated).toBe(0)
  expect(r.errors).toEqual([])
})