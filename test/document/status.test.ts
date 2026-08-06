/**
 * 去 git 自管版本系统 —— 文档级六态派生（src/document/status.ts）单测。
 * 覆盖：deriveStatus（archived/draft/idea/revision/final，指纹比对）、
 * readPublished（有/无字段/无 frontmatter）、deriveStatusFull（published 合成 + revision 优先）。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveStatus, deriveStatusFull, readPublished } from '../../src/document/status.js'
import type { ManifestEntry } from '../../src/document/manifest.js'

/** 造一个 manifest entry（定稿基线字段可配）。 */
function entry(finRev?: string): ManifestEntry {
  return {
    id: 'doc_1',
    nodeType: 'document',
    path: '写作/正文/0001-开篇.md',
    parentId: null,
    ...(finRev ? { finalizedRevision: finRev } : {}),
  }
}

test('deriveStatus: 废稿 → archived', () => {
  expect(deriveStatus('废稿/旧版.md', null, null)).toBe('archived')
})

test('deriveStatus: 工作区/待定稿 → draft；工作区卡片 → idea', () => {
  expect(deriveStatus('工作区/待定稿/0001-开篇/草稿-1.md', null, null)).toBe('draft')
  expect(deriveStatus('工作区/卡片.md', null, null)).toBe('idea')
})

test('deriveStatus: 从未定稿 → draft；定稿后改动 → revision；定稿且一致 → final', () => {
  // 无 entry（磁盘手建未登记）→ draft
  expect(deriveStatus('写作/正文/0001-开篇.md', null, 'sha256:bbb')).toBe('draft')
  // 有 entry 但无定稿基线 → draft
  expect(deriveStatus('写作/正文/0001-开篇.md', entry(), 'sha256:bbb')).toBe('draft')
  // 定稿基线 + 当前指纹不同 → revision
  expect(deriveStatus('写作/正文/0001-开篇.md', entry('sha256:aaa'), 'sha256:bbb')).toBe('revision')
  // 定稿基线 + 当前指纹一致 → final
  expect(deriveStatus('写作/正文/0001-开篇.md', entry('sha256:aaa'), 'sha256:aaa')).toBe('final')
})

test('deriveStatus: 文件不存在（currentRevision=null）→ 有基线时 final', () => {
  // 文件不存在但基线存在：文件被删场景，按 final 处理（不存在无法比对，不误报 revision）
  expect(deriveStatus('写作/正文/0001-开篇.md', entry('sha256:aaa'), null)).toBe('final')
})

test('readPublished: 已发布: true → true；无字段 → false；无 frontmatter → false', () => {
  const root = mkdtempSync(join(tmpdir(), 'w2a-status-'))
  writeFileSync(join(root, '0002-迷雾.md'), '---\n章号: 2\n已发布: true\n---\n正文', 'utf-8')
  expect(readPublished(root, '0002-迷雾.md')).toBe(true)
  writeFileSync(join(root, '0001-开篇.md'), '---\n章号: 1\n---\n正文', 'utf-8')
  expect(readPublished(root, '0001-开篇.md')).toBe(false) // 无字段
  writeFileSync(join(root, '裸文件.md'), '正文', 'utf-8')
  expect(readPublished(root, '裸文件.md')).toBe(false) // 无 frontmatter
  rmSync(root, { recursive: true, force: true })
})

test('deriveStatusFull: final + 已发布 → published；revision 优先于 published', () => {
  const root = mkdtempSync(join(tmpdir(), 'w2a-pub-'))
  writeFileSync(join(root, '0002-迷雾.md'), '---\n章号: 2\n已发布: true\n---\n正文', 'utf-8')
  // final + 已发布 → published
  expect(deriveStatusFull(root, '0002-迷雾.md', entry('sha256:aaa'), 'sha256:aaa')).toBe('published')
  // revision（指纹不同）优先于 published
  expect(deriveStatusFull(root, '0002-迷雾.md', entry('sha256:aaa'), 'sha256:bbb')).toBe('revision')
  rmSync(root, { recursive: true, force: true })
})