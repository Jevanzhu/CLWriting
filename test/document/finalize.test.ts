/**
 * P1 定稿确认（src/document/finalize.ts）单测。
 * 覆盖：revision→final 成功路径（精确 commit）、已 final 幂等（skipped）、
 * 未登记 NOT_FOUND、非定稿区 NOT_DRAFT_REGION、commit 消息前缀（findChapterCommit 可反查）。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { finalizeRevision } from '../../src/document/finalize.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { findChapterCommit } from '../../src/git/exec.js'
import { deriveStatus, collectDirtyFiles } from '../../src/document/status.js'

/** 造一本干净书：git init + 一章已定稿（态 final），再登记清单。返回 {root, docId}。 */
function makeBook(): { root: string; docId: string } {
  const root = mkdtempSync(join(tmpdir(), 'finalize-'))
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email t@t.com', { cwd: root, stdio: 'pipe' })
  execSync('git config user.name t', { cwd: root, stdio: 'pipe' })
  execSync('git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  mkdirSync(join(root, '定稿', '正文'), { recursive: true })
  writeFileSync(
    join(root, '定稿', '正文', '0001-开篇.md'),
    '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n天脉异象惊动宗门。\n',
    'utf-8',
  )
  execSync('git add -A && git commit -m "ch:0001 开篇"', { cwd: root, stdio: 'pipe' })

  const manifestPath = join(root, '项目', '文档清单.jsonl')
  mkdirSync(join(root, '项目'), { recursive: true })
  const m = readManifest(manifestPath)
  const docId = generateDocId()
  upsertEntry(m, { id: docId, nodeType: 'document', path: '定稿/正文/0001-开篇.md', parentId: null })
  writeManifest(manifestPath, m)
  return { root, docId }
}

test('revision→final：脏文件被 commit → git 干净 + 状态回 final', () => {
  const { root, docId } = makeBook()
  // 改文件 → git 变脏 → revision 态
  writeFileSync(join(root, '定稿', '正文', '0001-开篇.md'), '改了内容\n', 'utf-8')
  expect(deriveStatus('定稿/正文/0001-开篇.md', collectDirtyFiles(root))).toBe('revision')

  const r = finalizeRevision(root, docId)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.skipped).toBe(false)
  expect(r.status).toBe('final')
  // commit 后 git 干净 → 派生回 final
  expect(deriveStatus('定稿/正文/0001-开篇.md', collectDirtyFiles(root))).toBe('final')
  rmSync(root, { recursive: true, force: true })
})

test('commit 消息沿用 ch: 前缀约定（findChapterCommit 可反查）', () => {
  const { root, docId } = makeBook()
  writeFileSync(join(root, '定稿', '正文', '0001-开篇.md'), '二次修改\n', 'utf-8')
  const r = finalizeRevision(root, docId)
  expect(r.ok).toBe(true)
  // ch:0001 前缀 → 能定位到定稿 commit（findChapterCommit 依赖此前缀）
  expect(findChapterCommit(root, 1)).toBeTruthy()
  rmSync(root, { recursive: true, force: true })
})

test('已 final（git 干净）→ skipped 幂等，不重复 commit', () => {
  const { root, docId } = makeBook()
  const r = finalizeRevision(root, docId)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.skipped).toBe(true)
  expect(r.status).toBe('final')
  rmSync(root, { recursive: true, force: true })
})

test('未登记 docId → NOT_FOUND', () => {
  const { root } = makeBook()
  const r = finalizeRevision(root, 'doc_unknown')
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('NOT_FOUND')
  rmSync(root, { recursive: true, force: true })
})

test('非定稿区文档（工作区草稿）→ NOT_DRAFT_REGION', () => {
  const root = mkdtempSync(join(tmpdir(), 'finalize-nodraft-'))
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email t@t.com', { cwd: root, stdio: 'pipe' })
  execSync('git config user.name t', { cwd: root, stdio: 'pipe' })
  mkdirSync(join(root, '工作区'), { recursive: true })
  writeFileSync(join(root, '工作区', '草稿-1.md'), '草稿', 'utf-8')
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  mkdirSync(join(root, '项目'), { recursive: true })
  const m = readManifest(manifestPath)
  const docId = generateDocId()
  upsertEntry(m, { id: docId, nodeType: 'document', path: '工作区/草稿-1.md', parentId: null })
  writeManifest(manifestPath, m)

  const r = finalizeRevision(root, docId)
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('NOT_DRAFT_REGION')
  rmSync(root, { recursive: true, force: true })
})