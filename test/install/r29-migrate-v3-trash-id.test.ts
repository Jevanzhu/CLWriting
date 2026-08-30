/**
 * C-4（二十九轮）回归：v3 迁移回收站条目的 id 确定性派生 + originalPath 指向迁移落点。
 *
 * 背景：trashDraft 此前 id 用随机 ULID（TrashEntry.id 语义是「原 docId」，restoreTrash
 * 按它 upsert 清单身份）——迁移时点无法恢复真实 docId，随机值使还原后身份与树扫描
 * legacyId 口径断链且迁移重试不幂等；originalPath 固定 写作/草稿/<name>（v3 已退役
 * 目录），restore 会把文件还原回写作链看不见的退役目录。
 * 修复后：id = legacyId(originalPath)（stable-id 确定性派生，与 tree 对未登记文件的
 * 运行期 ID 同构造）；originalPath = resolveDraftPath 落点（throw 分支走 forRead 只读
 * 口径兜底）。
 */
import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLayoutV3 } from '../../src/install/migrate-layout-v3.js'
import { listTrash, type TrashEntry } from '../../src/document/trash.js'
import { legacyId } from '../../src/document/stable-id.js'

const FINALIZED_REL = '写作/正文/0001-占位.md'
const FINALIZED_FM = '---\n章号: 1\n标题: 占位\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n占位章正文。\n'
const MANIFEST_FINALIZED = [
  '{"version":1,"type":"header"}',
  '{"id":"doc1","nodeType":"document","path":"写作/正文/0001-占位.md","parentId":null,"finalizedRevision":"sha256:abc","finalizedAt":"2026-01-01T00:00:00Z"}',
].join('\n') + '\n'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clw-r29-trash-id-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '写作', '草稿'), { recursive: true })
  writeFileSync(join(root, FINALIZED_REL), FINALIZED_FM, 'utf-8')
  writeFileSync(join(root, '写作', '草稿', '草稿-1.md'), '---\n标题: 冲突旧稿\n---\n旧稿正文。\n', 'utf-8')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function trashEntryOf(bookRoot: string): TrashEntry {
  const entries = listTrash(bookRoot)
  expect(entries).toHaveLength(1)
  return entries[0]!
}

test('目标冲突分支：id = legacyId(落点)，originalPath = 落点（非退役草稿目录）', () => {
  const r = migrateLayoutV3(root)
  expect(r.errors).toEqual([])
  expect(r.migrated).toBe(1)
  const e = trashEntryOf(root)
  expect(e.originalPath).toBe(FINALIZED_REL)
  expect(e.id).toBe(legacyId(FINALIZED_REL))
  expect(e.id).toMatch(/^legacy:/)
  expect(e.trashedPath).toBe('工作区/.trash/草稿-1.md')
  expect(existsSync(join(root, '工作区', '.trash', '草稿-1.md'))).toBe(true)
})

test('定稿防线 throw 分支：forRead 落点兜底，originalPath 仍指真实落点', () => {
  // 正文区章在清单定稿 → 正式口径 resolveDraftPath throw（V-P1-3）
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, '项目', '文档清单.jsonl'), MANIFEST_FINALIZED, 'utf-8')
  const r = migrateLayoutV3(root)
  expect(r.errors.length).toBe(1)
  expect(r.errors[0]).toContain('已定稿')
  const e = trashEntryOf(root)
  expect(e.originalPath).toBe(FINALIZED_REL)
  expect(e.id).toBe(legacyId(FINALIZED_REL))
  // 定稿内容未被覆盖
  expect(existsSync(join(root, FINALIZED_REL))).toBe(true)
})

test('id 确定性：两本同构书迁移产物同 id（迁移幂等 / 还原身份链同口径）', () => {
  const r1 = migrateLayoutV3(root)
  expect(r1.migrated).toBe(1)
  const id1 = trashEntryOf(root).id

  const root2 = mkdtempSync(join(tmpdir(), 'clw-r29-trash-id-2-'))
  try {
    mkdirSync(join(root2, '写作', '正文'), { recursive: true })
    mkdirSync(join(root2, '写作', '草稿'), { recursive: true })
    writeFileSync(join(root2, FINALIZED_REL), FINALIZED_FM, 'utf-8')
    writeFileSync(join(root2, '写作', '草稿', '草稿-1.md'), '---\n标题: 冲突旧稿\n---\n旧稿正文。\n', 'utf-8')
    migrateLayoutV3(root2)
    expect(trashEntryOf(root2).id).toBe(id1)
  } finally {
    rmSync(root2, { recursive: true, force: true })
  }
})
