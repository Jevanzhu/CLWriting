/**
 * R0912-3（2026-09-11 重评-0911c 修复批）：保存守卫清单读容错口径收敛 strict。
 *
 * 修复前：lookupPathByDocIdAdoptAsync 命中读用容错版 readManifest——瞬态读失败
 *（EBUSY/EACCES）返空表 → 守卫把「登记在册」误判「未登记」→ save 走新建语义在
 * 旧路径静默落盘（同内容双文件/复活窗）。
 *
 * 修复后：命中读改 readManifestStrict（与 RMW 链 R27-40 口径对齐），读失败向上走
 * 既有 WRITE_ERROR 信封（fail-closed：未落盘、可重试）——本文件覆盖 save / trash /
 * move 三个守卫消费面的失败路径（r49-16 mock readFileSync 同款手法；注意 manifest
 * 有 stat 指纹缓存，mock 故障必须在任何缓存预热前启用）。
 */
import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FAIL = vi.hoisted(() => ({ manifestRead: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: ((p, ...rest) => {
      if (FAIL.manifestRead && typeof p === 'string' && p.endsWith('文档清单.jsonl')) {
        throw Object.assign(new Error('EBUSY: 瞬时占用（模拟同步盘扫描锁）'), { code: 'EBUSY' })
      }
      return (actual.readFileSync as typeof readFileSync)(p, ...rest)
    }) as typeof readFileSync,
  }
})

import { DocumentService } from '../../src/document/service.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'

const DOC_ID = 'doc_strict_guard'
const REL = '设定/世界观.md'

let bookRoot = ''
let svc: DocumentService

beforeEach(() => {
  bookRoot = mkdtempSync(join(tmpdir(), 'clw-r0912-strict-'))
  mkdirSync(join(bookRoot, '设定'), { recursive: true })
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  writeFileSync(join(bookRoot, REL), '---\n名称: A\n---\n第一版', 'utf-8')
  const mp = join(bookRoot, '项目', '文档清单.jsonl')
  const m = readManifest(mp)
  upsertEntry(m, { id: DOC_ID, nodeType: 'document', path: REL, parentId: null })
  writeManifest(mp, m)
  svc = new DocumentService({ bookRoot })
  FAIL.manifestRead = false
})

afterEach(() => {
  FAIL.manifestRead = false
  if (bookRoot) rmSync(bookRoot, { recursive: true, force: true })
})

test('R0912-3: 清单瞬态读失败 → save 返回 WRITE_ERROR，不静默落旧路径（未落盘可重试）', async () => {
  FAIL.manifestRead = true
  const r = await svc.save(DOC_ID, REL, {
    content: '---\n名称: A\n---\n第二版',
    expectedRevision: null, // 新建语义：容错空表下会误放行复活/双文件
    operationId: 'op-strict-save',
    origin: 'manual',
  })
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.code).toBe('WRITE_ERROR')
    expect(r.reason).toContain('清单查询失败')
    expect(r.reason).toContain('未执行保存')
  }
  // 守卫失效面未发生：旧路径文件未被动（仍是原内容，无第二份）
  expect(readFileSync(join(bookRoot, REL), 'utf-8')).toBe('---\n名称: A\n---\n第一版')
  // 瞬态恢复 → 保存成功（非死路）
  FAIL.manifestRead = false
  const rev = (await import('../../src/document/revision.js')).computeRevision(join(bookRoot, REL))
  const r2 = await svc.save(DOC_ID, REL, {
    content: '---\n名称: A\n---\n第二版',
    expectedRevision: rev,
    operationId: 'op-strict-save-2',
    origin: 'manual',
  })
  expect(r2.ok).toBe(true)
})

test('R0912-3: 清单瞬态读失败 → trashDocument WRITE_ERROR（文件未动，可重试）', async () => {
  FAIL.manifestRead = true
  const r = await svc.trashDocument({ docId: DOC_ID })
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.code).toBe('WRITE_ERROR')
    expect(r.reason).toContain('删除前清单查询失败')
  }
  expect(existsSync(join(bookRoot, REL))).toBe(true)
})

test('R0912-3: 清单瞬态读失败 → moveDocument WRITE_ERROR（未执行操作，可重试）', async () => {
  FAIL.manifestRead = true
  const r = await svc.moveDocument({ docId: DOC_ID, toDir: '设定/卷二' })
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.code).toBe('WRITE_ERROR')
    expect(r.reason).toContain('移动/重命名前清单查询失败')
  }
  expect(existsSync(join(bookRoot, REL))).toBe(true)
  expect(existsSync(join(bookRoot, '设定/卷二/世界观.md'))).toBe(false)
})
