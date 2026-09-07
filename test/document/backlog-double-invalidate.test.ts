/**
 * R59 清偿批（R57-G-1）回归：updateChapterMeta 操作链双重 invalidateTreeIndex 去重。
 *
 * 修复前：updateChapterMeta 在分支汇合处（原 :1091）先做一次
 * invalidateTreeIndex(bookRoot, true)，rename 路径委托 doMoveOrRename 后其链尾
 * （:1526 附近）对同一 bookRoot 再做一次同参整书失效——同一操作链双重失效。
 *
 * 修复后契约（本文件锁定）：
 * 1. rename 路径：结构性整书失效单源在链尾 doMoveOrRename，全程恰好 1 次；
 * 2. 不 rename 路径：rel_path 集合不变，上方 invalidateTreeIndexForContent
 *    （单键内容失效）已足够，结构性整书失效 0 次——链中提前清会把未变章的有效
 *    章级机检缓存行连坐清空（下轮聚合全章重算，纯性能损耗）。
 *
 * 手法：vi.mock document/tree 透传 spy（r53/r71 同款 pass-through 范式），只计数
 * 不改行为。
 */
import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../src/document/tree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/document/tree.js')>()
  return {
    ...actual,
    invalidateTreeIndex: vi.fn(actual.invalidateTreeIndex),
    invalidateTreeIndexForContent: vi.fn(actual.invalidateTreeIndexForContent),
  }
})

import { invalidateTreeIndex, invalidateTreeIndexForContent } from '../../src/document/tree.js'
import { DocumentService } from '../../src/document/service.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'

const invalidateMock = vi.mocked(invalidateTreeIndex)
const invalidateContentMock = vi.mocked(invalidateTreeIndexForContent)

let bookRoot = ''
let svc: DocumentService
let seq = 0

beforeEach(() => {
  invalidateMock.mockClear()
  invalidateContentMock.mockClear()
  bookRoot = mkdtempSync(join(tmpdir(), 'clw-backlog-g1-'))
  mkdirSync(join(bookRoot, '笔记'), { recursive: true })
  svc = new DocumentService({ bookRoot })
})

afterEach(() => {
  if (bookRoot) rmSync(bookRoot, { recursive: true, force: true })
})

/** 手建章文件 + 清单登记（r71-move-meta-family 同款入口形态） */
function registerChapter(name: string): string {
  writeFileSync(join(bookRoot, '笔记', name), '---\n---\n\n正文。\n', 'utf-8')
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  const m = readManifest(manifestPath)
  const docId = `backlog-g1-${seq++}`
  upsertEntry(m, { id: docId, nodeType: 'document', path: `笔记/${name}`, parentId: null })
  writeManifest(manifestPath, m)
  return docId
}

test('R57-G-1: rename 路径全程恰好 1 次结构性整书失效（单源在 doMoveOrRename 链尾）', async () => {
  const docId = registerChapter('0001-我的章节.md')

  const r = await svc.updateChapterMeta(docId, { 章号: 5 })
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.path).toBe('笔记/0005-我的章节.md')
  expect(existsSync(join(bookRoot, '笔记', '0005-我的章节.md'))).toBe(true)
  expect(existsSync(join(bookRoot, '笔记', '0001-我的章节.md'))).toBe(false)

  // 内容单键失效 1 次（R46-8 既有口径不变）
  expect(invalidateContentMock).toHaveBeenCalledTimes(1)
  // 结构性整书失效恰 1 次（修复前：链中 + 链尾 = 2 次）
  expect(invalidateMock).toHaveBeenCalledTimes(1)
  expect(invalidateMock.mock.calls[0]).toEqual([bookRoot, true])
})

test('R57-G-1: 不 rename 路径 0 次结构性整书失效（单键内容失效已足够）', async () => {
  const docId = registerChapter('0003-我的章节.md')

  // 章号 3 → newName 与现名一致 → 不走 rename 委托
  const r = await svc.updateChapterMeta(docId, { 章号: 3 })
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.path).toBe('笔记/0003-我的章节.md')
  expect(existsSync(join(bookRoot, '笔记', '0003-我的章节.md'))).toBe(true)
  // fm 章号已写回
  expect(readFileSync(join(bookRoot, '笔记', '0003-我的章节.md'), 'utf-8')).toContain('章号: 3')

  // 内容单键失效 1 次；结构性整书失效 0 次（修复前：链中 1 次）
  expect(invalidateContentMock).toHaveBeenCalledTimes(1)
  expect(invalidateMock).toHaveBeenCalledTimes(0)
})
