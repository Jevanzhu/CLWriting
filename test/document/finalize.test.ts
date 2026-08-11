/**
 * 去 git 自管版本系统 —— 定稿确认（src/document/finalize.ts）单测。
 * 覆盖：revision→final 成功路径（写 pinned 版本 + manifest 基线）、已 final 幂等（skipped）、
 * 未登记 NOT_FOUND、版本档案落盘（pinned 永久保留）。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finalizeRevision } from '../../src/document/finalize.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { deriveStatus } from '../../src/document/status.js'
import { computeRevision } from '../../src/document/revision.js'

/** 造一本干净书：一章 + 登记清单。返回 {root, docId}。 */
function makeBook(): { root: string; docId: string } {
  const root = mkdtempSync(join(tmpdir(), 'finalize-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(root, '写作', '正文', '0001-开篇.md'),
    '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n天脉异象惊动宗门。\n',
    'utf-8',
  )

  const manifestPath = join(root, '项目', '文档清单.jsonl')
  mkdirSync(join(root, '项目'), { recursive: true })
  const m = readManifest(manifestPath)
  const docId = generateDocId()
  upsertEntry(m, { id: docId, nodeType: 'document', path: '写作/正文/0001-开篇.md', parentId: null })
  writeManifest(manifestPath, m)
  return { root, docId }
}

test('revision→final：改文件后定稿 → manifest 基线更新 + 状态回 final', () => {
  const { root, docId } = makeBook()
  // 首次定稿（draft → final）
  const r1 = finalizeRevision(root, docId)
  expect(r1.ok).toBe(true)
  if (!r1.ok) return
  expect(r1.skipped).toBe(false)
  expect(r1.status).toBe('final')

  // 定稿后 manifest 有基线
  const m = readManifest(join(root, '项目', '文档清单.jsonl'))
  const e = m.entries.get(docId)!
  expect(e.finalizedRevision).toBe(computeRevision(join(root, '写作', '正文', '0001-开篇.md')))
  expect(typeof e.finalizedAt).toBe('string')

  // 定稿后改文件 → revision 态
  writeFileSync(join(root, '写作', '正文', '0001-开篇.md'), '改了内容\n', 'utf-8')
  expect(deriveStatus('写作/正文/0001-开篇.md', e, computeRevision(join(root, '写作', '正文', '0001-开篇.md')))).toBe('revision')

  // 再定稿 → final（基线更新为新指纹）
  const r2 = finalizeRevision(root, docId)
  expect(r2.ok).toBe(true)
  if (!r2.ok) return
  expect(r2.skipped).toBe(false)
  const e2 = readManifest(join(root, '项目', '文档清单.jsonl')).entries.get(docId)!
  expect(deriveStatus('写作/正文/0001-开篇.md', e2, computeRevision(join(root, '写作', '正文', '0001-开篇.md')))).toBe('final')
  rmSync(root, { recursive: true, force: true })
})

test('已 final（当前指纹 == 基线）→ skipped 幂等，不重复写版本', () => {
  const { root, docId } = makeBook()
  const r1 = finalizeRevision(root, docId)
  expect(r1.ok).toBe(true)
  if (!r1.ok) return
  const r2 = finalizeRevision(root, docId)
  expect(r2.ok).toBe(true)
  if (!r2.ok) return
  expect(r2.skipped).toBe(true)
  expect(r2.status).toBe('final')
  // skipped 不重复写版本（版本数仍为 1）
  const versionsDir = join(root, '工作区', '.版本', docId)
  expect(existsSync(versionsDir)).toBe(true)
  const files = readdirSync(versionsDir).filter((n) => n.endsWith('.md'))
  expect(files).toHaveLength(1)
  rmSync(root, { recursive: true, force: true })
})

test('定稿写 pinned 版本（永久保留，front matter 带 永久: true）', () => {
  const { root, docId } = makeBook()
  finalizeRevision(root, docId)
  const versionsDir = join(root, '工作区', '.版本', docId)
  const files = readdirSync(versionsDir).filter((n) => n.endsWith('.md'))
  expect(files).toHaveLength(1)
  const content = readFileSync(join(versionsDir, files[0]!), 'utf-8')
  expect(content).toContain('来源: finalize')
  expect(content).toContain('永久: true')
  expect(content).toContain('天脉异象惊动宗门')
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