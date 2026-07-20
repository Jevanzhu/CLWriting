/**
 * W2A T2 —— 文档级八态派生（src/document/status.ts）单测。
 * 覆盖：collectDirtyFiles（干净/脏/非 git 仓库降级）、deriveStatus（archived/draft/idea/revision/final）、
 * readPublished（有/无字段/无 frontmatter）、deriveStatusFull（published 合成 + revision 优先）。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { collectDirtyFiles, deriveStatus, deriveStatusFull, readPublished } from '../../src/document/status.js'

/** 造一本干净长篇书：git init + commit 一章定稿（ch: 前缀，态 4 干净）。 */
function makeCleanBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'w2a-status-'))
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email t@t.com', { cwd: root, stdio: 'pipe' })
  execSync('git config user.name t', { cwd: root, stdio: 'pipe' })
  execSync('git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  mkdirSync(join(root, '定稿', '正文'), { recursive: true })
  writeFileSync(join(root, '定稿', '正文', '0001-开篇.md'), '---\n章号: 1\n标题: 开篇\n---\n正文', 'utf-8')
  execSync('git add -A && git commit -m "ch:0001 开篇"', { cwd: root, stdio: 'pipe' })
  return root
}

test('collectDirtyFiles: 干净工作树 → 空集', () => {
  const root = makeCleanBook()
  expect(collectDirtyFiles(root).size).toBe(0)
  rmSync(root, { recursive: true, force: true })
})

test('collectDirtyFiles: 改文件后 → 集合含该相对 path', () => {
  const root = makeCleanBook()
  writeFileSync(join(root, '定稿', '正文', '0001-开篇.md'), '改了', 'utf-8')
  const dirty = collectDirtyFiles(root)
  expect(dirty.has('定稿/正文/0001-开篇.md')).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

test('collectDirtyFiles: 非 git 目录 → 空集降级（不崩）', () => {
  const root = mkdtempSync(join(tmpdir(), 'w2a-nogit-'))
  expect(collectDirtyFiles(root).size).toBe(0)
  rmSync(root, { recursive: true, force: true })
})

test('deriveStatus: 废稿 → archived', () => {
  expect(deriveStatus('废稿/旧版.md', new Set())).toBe('archived')
})

test('deriveStatus: 工作区草稿/待定稿 → draft；仅细纲 → idea', () => {
  const empty = new Set<string>()
  expect(deriveStatus('工作区/草稿-1.md', empty)).toBe('draft')
  expect(deriveStatus('工作区/待定稿/0001-开篇/草稿-1.md', empty)).toBe('draft')
  expect(deriveStatus('工作区/细纲.md', empty)).toBe('idea')
  expect(deriveStatus('工作区/卡片.md', empty)).toBe('idea')
})

test('deriveStatus: 定稿区 git 脏 → revision；干净 → final', () => {
  expect(deriveStatus('定稿/正文/0001-开篇.md', new Set(['定稿/正文/0001-开篇.md']))).toBe('revision')
  expect(deriveStatus('定稿/正文/0001-开篇.md', new Set())).toBe('final')
})

test('readPublished: 已发布: true → true；无字段 → false；无 frontmatter → false', () => {
  const root = makeCleanBook()
  // 新建带已发布 + commit（干净）
  writeFileSync(join(root, '定稿', '正文', '0002-迷雾.md'), '---\n章号: 2\n标题: 迷雾\n已发布: true\n---\n正文', 'utf-8')
  expect(readPublished(root, '定稿/正文/0002-迷雾.md')).toBe(true)
  expect(readPublished(root, '定稿/正文/0001-开篇.md')).toBe(false) // 无字段
  rmSync(root, { recursive: true, force: true })
})

test('deriveStatusFull: final + 已发布 → published；revision 优先于 published', () => {
  const root = makeCleanBook()
  // 0002 已发布 + commit 干净 → published
  writeFileSync(join(root, '定稿', '正文', '0002-迷雾.md'), '---\n章号: 2\n已发布: true\n---\n正文', 'utf-8')
  execSync('git add -A && git commit -m "ch:0002 迷雾"', { cwd: root, stdio: 'pipe' })
  expect(deriveStatusFull(root, '定稿/正文/0002-迷雾.md', new Set())).toBe('published')
  // 0002 改脏（即使已发布）→ revision
  writeFileSync(join(root, '定稿', '正文', '0002-迷雾.md'), '---\n章号: 2\n已发布: true\n---\n改脏了', 'utf-8')
  expect(deriveStatusFull(root, '定稿/正文/0002-迷雾.md', collectDirtyFiles(root))).toBe('revision')
  rmSync(root, { recursive: true, force: true })
})
