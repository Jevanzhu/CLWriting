/**
 * W2A T4 —— DocumentService 结构性操作（createDocument/moveDocument/renameDocument）单测。
 * 与 W1 save 测试分文件。覆盖：落盘+清单登记+docId、ALREADY_EXISTS、CAPABILITY_DENIED、
 * PATH_ESCAPE、跨卷移动章号不变、清单 path 更新、移动前 snapshot、rename、NOT_FOUND。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { DocumentService } from '../../src/document/service.js'
import { getBookTreeIndex } from '../../src/document/tree.js'

/** 造书：定稿/正文/第一卷/0001-开篇 + 项目清单登记 doc_ch01 + git init。 */
function makeBookWithChapter(): { root: string; svc: DocumentService } {
  const root = mkdtempSync(join(tmpdir(), 'w2a-svc-'))
  execSync('git init && git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  mkdirSync(join(root, '定稿', '正文', '第一卷'), { recursive: true })
  mkdirSync(join(root, '大纲', '卷纲'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, '定稿', '正文', '第一卷', '0001-开篇.md'), '---\n章号: 1\n标题: 开篇\n---\n正文', 'utf-8')
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

test('createDocument: 落盘 + 分配 doc_ 前缀 docId + 清单登记', async () => {
  const { root, svc } = makeBookWithChapter()
  getBookTreeIndex(root) // 预热缓存（验证后续 invalidate 重建）
  const r = await svc.createDocument({ relPath: '定稿/正文/第一卷/0002-迷雾.md', content: '---\n章号: 2\n---\n迷雾正文' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.docId).toMatch(/^doc_/)
  expect(existsSync(join(root, '定稿', '正文', '第一卷', '0002-迷雾.md'))).toBe(true)
  expect(readFileSync(join(root, '项目', '文档清单.jsonl'), 'utf-8')).toContain(r.docId)
  rmSync(root, { recursive: true, force: true })
})

test('createDocument: 已存在 → ALREADY_EXISTS', async () => {
  const { root, svc } = makeBookWithChapter()
  const r = await svc.createDocument({ relPath: '定稿/正文/第一卷/0001-开篇.md', content: 'x' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('ALREADY_EXISTS')
  rmSync(root, { recursive: true, force: true })
})

test('createDocument: 只读位置（定稿/摘要）→ CAPABILITY_DENIED', async () => {
  const { root, svc } = makeBookWithChapter()
  mkdirSync(join(root, '定稿', '摘要'), { recursive: true })
  const r = await svc.createDocument({ relPath: '定稿/摘要/0001.md', content: '摘要' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('CAPABILITY_DENIED')
  rmSync(root, { recursive: true, force: true })
})

test('createDocument: 路径越出 → PATH_ESCAPE', async () => {
  const { root, svc } = makeBookWithChapter()
  const r = await svc.createDocument({ relPath: '../etc/passwd', content: 'x' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('PATH_ESCAPE')
  rmSync(root, { recursive: true, force: true })
})

test('moveDocument: 跨卷移动，文件名不变（章号稳定 §11）+ 清单 path 更新 + snapshot 留底', async () => {
  const { root, svc } = makeBookWithChapter()
  mkdirSync(join(root, '定稿', '正文', '第二卷'), { recursive: true })
  const r = await svc.moveDocument({ docId: 'doc_ch01', toDir: '定稿/正文/第二卷' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.path).toBe('定稿/正文/第二卷/0001-开篇.md') // 文件名（含章号）不变
  expect(existsSync(join(root, '定稿', '正文', '第二卷', '0001-开篇.md'))).toBe(true)
  expect(existsSync(join(root, '定稿', '正文', '第一卷', '0001-开篇.md'))).toBe(false)
  const m = readFileSync(join(root, '项目', '文档清单.jsonl'), 'utf-8')
  expect(m).toContain('定稿/正文/第二卷/0001-开篇.md')
  expect(m).not.toContain('定稿/正文/第一卷/0001-开篇.md')
  // snapshot 留底
  const snapDir = join(root, '工作区', '.snapshots', 'doc_ch01')
  expect(existsSync(snapDir)).toBe(true)
  expect(readdirSync(snapDir).length).toBeGreaterThan(0)
  rmSync(root, { recursive: true, force: true })
})

test('moveDocument: docId 未登记 → NOT_FOUND', async () => {
  const { root, svc } = makeBookWithChapter()
  mkdirSync(join(root, '定稿', '正文', '第二卷'), { recursive: true })
  const r = await svc.moveDocument({ docId: 'doc_unknown', toDir: '定稿/正文/第二卷' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('NOT_FOUND')
  rmSync(root, { recursive: true, force: true })
})

test('moveDocument: 定稿/摘要（只读 note，rename/move=false）→ CAPABILITY_DENIED', async () => {
  const { root, svc } = makeBookWithChapter()
  mkdirSync(join(root, '定稿', '摘要'), { recursive: true })
  writeFileSync(join(root, '定稿', '摘要', '0001.md'), '摘要', 'utf-8')
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc_ro","nodeType":"document","path":"定稿/摘要/0001.md","parentId":null}',
    ].join('\n') + '\n',
  )
  const r = await svc.moveDocument({ docId: 'doc_ro', toDir: '素材' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('CAPABILITY_DENIED')
  rmSync(root, { recursive: true, force: true })
})

test('renameDocument: 改文件名，目录不变', async () => {
  const { root, svc } = makeBookWithChapter()
  const r = await svc.renameDocument({ docId: 'doc_ch01', newName: '0001-序章.md' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.path).toBe('定稿/正文/第一卷/0001-序章.md')
  expect(existsSync(join(root, '定稿', '正文', '第一卷', '0001-序章.md'))).toBe(true)
  expect(existsSync(join(root, '定稿', '正文', '第一卷', '0001-开篇.md'))).toBe(false)
  rmSync(root, { recursive: true, force: true })
})

test('结构性操作触发旧书建清单（W0 §4.2）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'w2a-nomanifest-'))
  execSync('git init && git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  mkdirSync(join(root, '工作区'), { recursive: true })
  const svc = new DocumentService({ bookRoot: root })
  // 旧书无清单
  expect(existsSync(join(root, '项目', '文档清单.jsonl'))).toBe(false)
  // create 触发建清单
  const r = await svc.createDocument({ relPath: '素材/灵感.md', content: '---\n---\n灵感' })
  expect(r.ok).toBe(true)
  expect(existsSync(join(root, '项目', '文档清单.jsonl'))).toBe(true) // 清单已建
  expect(readFileSync(join(root, '项目', '文档清单.jsonl'), 'utf-8')).toContain(r.ok ? r.docId : '')
  rmSync(root, { recursive: true, force: true })
})
