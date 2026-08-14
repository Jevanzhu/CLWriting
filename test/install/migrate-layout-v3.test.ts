import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLayoutV3 } from '../../src/install/migrate-layout-v3.js'
import { listTrash } from '../../src/document/trash.js'

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
  // W-P2-3：进回收站清单（此前只挪文件不登记，回收站 UI 永不可见、不可还原）
  const trash = listTrash(tmp)
  expect(trash.some((e) => e.originalPath === '写作/草稿/草稿-1.md' && e.trashedPath === '工作区/.trash/草稿-1.md')).toBe(true)
})

// ── W-P1-5：定稿防线 throw 不得炸掉启动链路 ────────

test('W-P1-5：草稿指向已定稿章（resolveDraftPath throw）→ 迁移不崩溃，稿进回收站可还原', () => {
  // 同章号同标题 → resolveDraftPath 命中正文区已定稿文件 → V-P1-3 防线 throw
  write('写作/草稿/草稿-1.md', '---\n章号: 1\n标题: 开篇\n---\n草稿内容')
  write('写作/正文/第一卷/001-开篇.md', '---\n章号: 1\n标题: 开篇\n---\n定稿内容')
  write(
    '项目/文档清单.jsonl',
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc1","nodeType":"document","path":"写作/正文/第一卷/001-开篇.md","parentId":null,"finalizedRevision":"sha256:abc","finalizedAt":"2026-01-01T00:00:00Z"}',
    ].join('\n') + '\n',
  )

  // 修复前：throw 冒泡出 migrateLayoutV3 → startServer 崩，应用起不来且每次启动重演
  const r = migrateLayoutV3(tmp)
  expect(r.errors.length).toBe(1)
  expect(r.errors[0]).toContain('已定稿')
  // 定稿内容未被覆盖
  expect(readFileSync(join(tmp, '写作/正文/第一卷/001-开篇.md'), 'utf-8')).toContain('定稿内容')
  // 冲突稿进回收站且登记在案
  expect(has('工作区/.trash/草稿-1.md')).toBe(true)
  expect(listTrash(tmp).some((e) => e.originalPath === '写作/草稿/草稿-1.md')).toBe(true)
})

test('W-P1-5 后续启动可自愈：冲突稿已入回收站 → 二次迁移 no-op 无新错误', () => {
  write('写作/草稿/草稿-1.md', '---\n章号: 1\n标题: 开篇\n---\n草稿内容')
  write('写作/正文/第一卷/001-开篇.md', '---\n章号: 1\n标题: 开篇\n---\n定稿内容')
  write(
    '项目/文档清单.jsonl',
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc1","nodeType":"document","path":"写作/正文/第一卷/001-开篇.md","parentId":null,"finalizedRevision":"sha256:abc","finalizedAt":"2026-01-01T00:00:00Z"}',
    ].join('\n') + '\n',
  )
  const r1 = migrateLayoutV3(tmp)
  expect(r1.errors.length).toBe(1)
  const r2 = migrateLayoutV3(tmp)
  expect(r2.migrated).toBe(0)
  expect(r2.errors).toEqual([])
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