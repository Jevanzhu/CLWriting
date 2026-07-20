/**
 * W2A T5 —— 回收站（DocumentService.trashDocument + trash.ts restore/purge/list）单测。
 * 覆盖：软删（移 .trash + 清单移除 + manifest 记录）、账本 CAPABILITY_DENIED、NOT_FOUND、
 * 恢复（移回 + 清单恢复）、原位占用 OCCUPIED、永久删、listTrash。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { DocumentService } from '../../src/document/service.js'
import { listTrash, restoreTrash, purgeTrash } from '../../src/document/trash.js'

/** 造书：定稿/正文/第一卷/0001 + 项目清单登记 doc_ch01。 */
function makeBookWithChapter(): { root: string; svc: DocumentService } {
  const root = mkdtempSync(join(tmpdir(), 'w2a-trash-'))
  execSync('git init && git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  mkdirSync(join(root, '定稿', '正文', '第一卷'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, '定稿', '正文', '第一卷', '0001-开篇.md'), '---\n章号: 1\n---\n正文', 'utf-8')
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc_ch01","nodeType":"document","path":"定稿/正文/第一卷/0001-开篇.md","parentId":null,"status":"final"}',
    ].join('\n') + '\n',
  )
  execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })
  return { root, svc: new DocumentService({ bookRoot: root }) }
}

test('trashDocument: 软删 → 移 .trash + 清单移除 + manifest 记录', async () => {
  const { root, svc } = makeBookWithChapter()
  const r = await svc.trashDocument({ docId: 'doc_ch01' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.trashedPath).toBe('工作区/.trash/doc_ch01-0001-开篇.md')
  expect(existsSync(join(root, r.trashedPath))).toBe(true)
  expect(existsSync(join(root, '定稿', '正文', '第一卷', '0001-开篇.md'))).toBe(false)
  expect(readFileSync(join(root, '项目', '文档清单.jsonl'), 'utf-8')).not.toContain('doc_ch01')
  const trash = listTrash(root)
  expect(trash).toHaveLength(1)
  expect(trash[0]!.id).toBe('doc_ch01')
  expect(trash[0]!.originalPath).toBe('定稿/正文/第一卷/0001-开篇.md')
  expect(trash[0]!.role).toBe('chapter')
  rmSync(root, { recursive: true, force: true })
})

test('trashDocument: 账本（ledger trash=false）→ CAPABILITY_DENIED', async () => {
  const root = mkdtempSync(join(tmpdir(), 'w2a-trash-lg-'))
  execSync('git init && git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  mkdirSync(join(root, '大纲', '伏笔'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, '大纲', '伏笔', '001-玉佩.md'), '---\n---\n伏笔', 'utf-8')
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc_lg01","nodeType":"document","path":"大纲/伏笔/001-玉佩.md","parentId":null}',
    ].join('\n') + '\n',
  )
  const svc = new DocumentService({ bookRoot: root })
  const r = await svc.trashDocument({ docId: 'doc_lg01' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('CAPABILITY_DENIED')
  // 原文件未动
  expect(existsSync(join(root, '大纲', '伏笔', '001-玉佩.md'))).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

test('trashDocument: 未登记 docId → NOT_FOUND', async () => {
  const { root, svc } = makeBookWithChapter()
  const r = await svc.trashDocument({ docId: 'doc_unknown' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('NOT_FOUND')
  rmSync(root, { recursive: true, force: true })
})

test('restoreTrash: 恢复 → 移回原位 + 清单恢复 + manifest 移除', async () => {
  const { root, svc } = makeBookWithChapter()
  await svc.trashDocument({ docId: 'doc_ch01' })
  const r = restoreTrash(root, 'doc_ch01')
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.path).toBe('定稿/正文/第一卷/0001-开篇.md')
  expect(existsSync(join(root, '定稿', '正文', '第一卷', '0001-开篇.md'))).toBe(true)
  expect(readFileSync(join(root, '项目', '文档清单.jsonl'), 'utf-8')).toContain('doc_ch01')
  expect(listTrash(root)).toHaveLength(0)
  rmSync(root, { recursive: true, force: true })
})

test('restoreTrash: 原位已被占用 → OCCUPIED（不自动改名，§17 决策④）', async () => {
  const { root, svc } = makeBookWithChapter()
  await svc.trashDocument({ docId: 'doc_ch01' })
  // 原位新建同名文件（占用）
  mkdirSync(join(root, '定稿', '正文', '第一卷'), { recursive: true })
  writeFileSync(join(root, '定稿', '正文', '第一卷', '0001-开篇.md'), '新的内容', 'utf-8')
  const r = restoreTrash(root, 'doc_ch01')
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('OCCUPIED')
  // trash 条目仍在（未恢复成功）
  expect(listTrash(root)).toHaveLength(1)
  rmSync(root, { recursive: true, force: true })
})

test('restoreTrash: 回收站无此 id → NOT_FOUND', () => {
  const root = mkdtempSync(join(tmpdir(), 'w2a-trash-empty-'))
  const r = restoreTrash(root, 'doc_xxx')
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('NOT_FOUND')
  rmSync(root, { recursive: true, force: true })
})

test('purgeTrash: 永久删 → 物理删文件 + manifest 移除', async () => {
  const { root, svc } = makeBookWithChapter()
  await svc.trashDocument({ docId: 'doc_ch01' })
  const trashedAbs = join(root, '工作区', '.trash', 'doc_ch01-0001-开篇.md')
  expect(existsSync(trashedAbs)).toBe(true)
  const r = purgeTrash(root, 'doc_ch01')
  expect(r.ok).toBe(true)
  expect(existsSync(trashedAbs)).toBe(false)
  expect(listTrash(root)).toHaveLength(0)
  rmSync(root, { recursive: true, force: true })
})

test('listTrash: 空回收站 → []', () => {
  const root = mkdtempSync(join(tmpdir(), 'w2a-trash-list-'))
  expect(listTrash(root)).toEqual([])
  rmSync(root, { recursive: true, force: true })
})
