import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLayoutV3 } from '../../src/install/migrate-layout-v3.js'
import { listTrash } from '../../src/document/trash.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

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
  // resolveDraftPath：无已有章 → 第一卷/0001-开篇.md（M-4·第十一轮：草稿新建 4 位补零单源）
  expect(has('写作/正文/第一卷/0001-开篇.md')).toBe(true)
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
  // R26-88（二十六轮）：后到者防覆盖跳过不再静默——errors 留痕提示手动核对，
  // 源文件滞留原位（不覆盖不丢弃，丢稿风险交作者裁决）
  expect(r.migrated).toBe(1)
  expect(r.errors).toHaveLength(1)
  expect(r.errors[0]).toContain('防覆盖跳过')
  expect(has('大纲/首章细纲.md')).toBe(true)
  // 恰有一个源迁成、另一个滞留草稿区，且留痕条目与滞留者一致
  const left = ['首篇细纲.md', '首章细纲.md'].filter((n) => has(`写作/草稿/${n}`))
  expect(left).toHaveLength(1)
  expect(r.errors[0]).toContain(left[0]!)
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
  // C-4（二十九轮）：originalPath 记「迁移落点」（resolveDraftPath 命中的既有章路径），
  // 不再是已退役的 写作/草稿/ 旧路径
  const trash = listTrash(tmp)
  expect(trash.some((e) => e.originalPath === '写作/正文/第一卷/001-正式.md' && e.trashedPath === '工作区/.trash/草稿-1.md')).toBe(true)
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
  // 冲突稿进回收站且登记在案（C-4：originalPath 记 forRead 落点=已定稿章路径）
  expect(has('工作区/.trash/草稿-1.md')).toBe(true)
  expect(listTrash(tmp).some((e) => e.originalPath === '写作/正文/第一卷/001-开篇.md')).toBe(true)
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

// ── R27-133（二十七轮）：trash 分支清除主清单旧路径条目 ───────────
// 独立夹具（mkdtempTracked 兜底回收；不复用文件级 tmp）。

/** 读 项目/文档清单.jsonl → Map<id, path>（直测清单投影，不引 manifest 模块）。 */
function r27ManifestPaths(bookRoot: string): Map<string, string> {
  const raw = readFileSync(join(bookRoot, '项目', '文档清单.jsonl'), 'utf-8')
  const m = new Map<string, string>()
  for (const line of raw.trim().split('\n')) {
    const o = JSON.parse(line) as { id?: string; path?: string }
    if (o.id) m.set(o.id, o.path ?? '')
  }
  return m
}

test('R27-133: 冲突稿入回收站（目标已存在分支）→ 主清单旧路径条目清除，不再悬挂', () => {
  const dir = mkdtempTracked(join(tmpdir(), 'clw-migrate-v3-r27-'))
  const w = (rel: string, content = '占位'): void => {
    const segs = rel.split('/')
    mkdirSync(join(dir, ...segs.slice(0, -1)), { recursive: true })
    writeFileSync(join(dir, ...segs), content, 'utf-8')
  }
  w('写作/草稿/草稿-1.md', '---\n章号: 1\n标题: 旧稿\n---\n草稿内容')
  w('写作/正文/第一卷/001-旧稿.md', '---\n章号: 1\n标题: 旧稿\n---\n已定稿内容')
  // 草稿曾在清单登记（docD1）+ 既有章条目（docF，未定稿态——定稿态会走 V-P1-3 throw
  // 分支而非「目标已存在」分支，见下一条用例）
  w(
    '项目/文档清单.jsonl',
    [
      '{"version":1,"type":"header"}',
      '{"id":"docF","nodeType":"document","path":"写作/正文/第一卷/001-旧稿.md","parentId":null}',
      '{"id":"docD1","nodeType":"document","path":"写作/草稿/草稿-1.md","parentId":null}',
    ].join('\n') + '\n',
  )

  const r = migrateLayoutV3(dir)
  expect(r.errors).toEqual([])
  expect(r.migrated).toBe(1)
  // 旧稿入回收站（既有 W-P2-3 口径不变；C-4：originalPath 记落点 001-旧稿.md）
  expect(listTrash(dir).some((e) => e.originalPath === '写作/正文/第一卷/001-旧稿.md')).toBe(true)
  // R27-133：主清单旧路径条目整行清除（修复前悬挂 entry 指向退役目录 写作/草稿/）
  const paths = r27ManifestPaths(dir)
  expect(paths.has('docD1')).toBe(false)
  expect([...paths.values()]).not.toContain('写作/草稿/草稿-1.md')
  // 他条目原样
  expect(paths.get('docF')).toBe('写作/正文/第一卷/001-旧稿.md')
})

test('R27-133: 定稿防线 throw 分支稿入回收站 → 同样清除主清单旧路径条目', () => {
  const dir = mkdtempTracked(join(tmpdir(), 'clw-migrate-v3-r27t-'))
  const w = (rel: string, content = '占位'): void => {
    const segs = rel.split('/')
    mkdirSync(join(dir, ...segs.slice(0, -1)), { recursive: true })
    writeFileSync(join(dir, ...segs), content, 'utf-8')
  }
  // 同章号同标题 → resolveDraftPath 命中已定稿 → V-P1-3 throw → 稿进回收站
  w('写作/草稿/草稿-1.md', '---\n章号: 1\n标题: 开篇\n---\n草稿内容')
  w('写作/正文/第一卷/001-开篇.md', '---\n章号: 1\n标题: 开篇\n---\n定稿内容')
  w(
    '项目/文档清单.jsonl',
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc1","nodeType":"document","path":"写作/正文/第一卷/001-开篇.md","parentId":null,"finalizedRevision":"sha256:abc","finalizedAt":"2026-01-01T00:00:00Z"}',
      '{"id":"docD2","nodeType":"document","path":"写作/草稿/草稿-1.md","parentId":null}',
    ].join('\n') + '\n',
  )

  const r = migrateLayoutV3(dir)
  expect(r.errors.length).toBe(1)
  expect(r.errors[0]).toContain('已定稿')
  expect(listTrash(dir).some((e) => e.originalPath === '写作/正文/第一卷/001-开篇.md')).toBe(true)
  // R27-133：throw 分支同口径清条目（W-P1-5 既有断言不回归：定稿条目原样）
  const paths = r27ManifestPaths(dir)
  expect(paths.has('docD2')).toBe(false)
  expect(paths.get('doc1')).toBe('写作/正文/第一卷/001-开篇.md')
})