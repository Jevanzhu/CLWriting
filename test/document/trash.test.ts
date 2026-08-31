/**
 * W2A T5 —— 回收站（DocumentService.trashDocument + trash.ts restore/purge/list）单测。
 * 覆盖：软删（移 .trash + 清单移除 + manifest 记录）、账本 CAPABILITY_DENIED、NOT_FOUND、
 * 恢复（移回 + 清单恢复）、原位占用 OCCUPIED、永久删、listTrash。
 */
import { test, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, linkSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { DocumentService } from '../../src/document/service.js'
import { listTrash, restoreTrash, purgeTrash } from '../../src/document/trash.js'

/** 造书：写作/正文/第一卷/0001 + 项目清单登记 doc_ch01。 */
function makeBookWithChapter(): { root: string; svc: DocumentService } {
  const root = mkdtempTracked(join(tmpdir(), 'w2a-trash-'))
  execSync('git init && git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  mkdirSync(join(root, '写作', '正文', '第一卷'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'), '---\n章号: 1\n---\n正文', 'utf-8')
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc_ch01","nodeType":"document","path":"写作/正文/第一卷/0001-开篇.md","parentId":null,"status":"final"}',
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
  expect(existsSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'))).toBe(false)
  expect(readFileSync(join(root, '项目', '文档清单.jsonl'), 'utf-8')).not.toContain('doc_ch01')
  const trash = listTrash(root)
  expect(trash).toHaveLength(1)
  expect(trash[0]!.id).toBe('doc_ch01')
  expect(trash[0]!.originalPath).toBe('写作/正文/第一卷/0001-开篇.md')
  expect(trash[0]!.role).toBe('chapter')
  rmSync(root, { recursive: true, force: true })
})

test('trashDocument: 账本（ledger trash=false）→ CAPABILITY_DENIED', async () => {
  const root = mkdtempTracked(join(tmpdir(), 'w2a-trash-lg-'))
  execSync('git init && git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, '布线', '悬念', '001-玉佩.md'), '---\n---\n悬念', 'utf-8')
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc_lg01","nodeType":"document","path":"布线/悬念/001-玉佩.md","parentId":null}',
    ].join('\n') + '\n',
  )
  const svc = new DocumentService({ bookRoot: root })
  const r = await svc.trashDocument({ docId: 'doc_lg01' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('CAPABILITY_DENIED')
  // 原文件未动
  expect(existsSync(join(root, '布线', '悬念', '001-玉佩.md'))).toBe(true)
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
  const r = await restoreTrash(root, 'doc_ch01')
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.path).toBe('写作/正文/第一卷/0001-开篇.md')
  expect(existsSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'))).toBe(true)
  expect(readFileSync(join(root, '项目', '文档清单.jsonl'), 'utf-8')).toContain('doc_ch01')
  expect(listTrash(root)).toHaveLength(0)
  rmSync(root, { recursive: true, force: true })
})

test('restoreTrash: 原位已被占用 → OCCUPIED（不自动改名，§17 决策④）', async () => {
  const { root, svc } = makeBookWithChapter()
  await svc.trashDocument({ docId: 'doc_ch01' })
  // 原位新建同名文件（占用）
  mkdirSync(join(root, '写作', '正文', '第一卷'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'), '新的内容', 'utf-8')
  const r = await restoreTrash(root, 'doc_ch01')
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('OCCUPIED')
  // trash 条目仍在（未恢复成功）
  expect(listTrash(root)).toHaveLength(1)
  rmSync(root, { recursive: true, force: true })
})

test('restoreTrash: 回收站无此 id → NOT_FOUND', async () => {
  const root = mkdtempTracked(join(tmpdir(), 'w2a-trash-empty-'))
  const r = await restoreTrash(root, 'doc_xxx')
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
  const r = await purgeTrash(root, 'doc_ch01')
  expect(r.ok).toBe(true)
  expect(existsSync(trashedAbs)).toBe(false)
  expect(listTrash(root)).toHaveLength(0)
  rmSync(root, { recursive: true, force: true })
})

test('listTrash: 空回收站 → []', () => {
  const root = mkdtempTracked(join(tmpdir(), 'w2a-trash-list-'))
  expect(listTrash(root)).toEqual([])
  rmSync(root, { recursive: true, force: true })
})

// ── W-P2-1：定稿基线随回收站条目往返 ────────────────

test('W-P2-1：软删已定稿章 → 回收站条目带基线；恢复后清单还原基线，定稿防线重新生效', async () => {
  const { root, svc } = makeBookWithChapter()
  // 清单补定稿基线（makeBookWithChapter 默认只写 status: final）
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  writeFileSync(
    manifestPath,
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc_ch01","nodeType":"document","path":"写作/正文/第一卷/0001-开篇.md","parentId":null,"finalizedRevision":"sha256:baseline-1","finalizedAt":"2026-01-01T00:00:00Z"}',
    ].join('\n') + '\n',
    'utf-8',
  )

  const tr = await svc.trashDocument({ docId: 'doc_ch01' })
  expect(tr.ok).toBe(true)
  // 回收站条目带定稿基线
  const entries = listTrash(root)
  expect(entries).toHaveLength(1)
  expect(entries[0]!.finalizedRevision).toBe('sha256:baseline-1')

  const rr = await restoreTrash(root, 'doc_ch01')
  expect(rr.ok).toBe(true)
  // 恢复后清单条目带回基线（修复前：upsertEntry 不带基线 → 已定稿章降级草稿态）
  const { readManifest } = await import('../../src/document/manifest.js')
  const m = readManifest(manifestPath)
  expect(m.entries.get('doc_ch01')?.finalizedRevision).toBe('sha256:baseline-1')

  // 链路级断言：定稿防线（V-P1-3 + W-P2-2）对恢复章重新生效——续写第 1 章应被拒绝
  const { resolveDraftPath } = await import('../../src/format/draft.js')
  expect(() => resolveDraftPath(root, 1)).toThrow(/已定稿/)
  rmSync(root, { recursive: true, force: true })
})

// ── R65-36（第六十五轮）：restore 重入幂等——「link 成功 → 删源」间崩溃的续跑 ────

test('R65-36: 目标位与回收站双份（link 后未删源崩溃形态）→ 再还原视为已完成：删源+清单收口，不再 OCCUPIED 卡死', async () => {
  const { root, svc } = makeBookWithChapter()
  try {
    await svc.trashDocument({ docId: 'doc_ch01' })
    // 手动造双份：模拟上次 restore 在 linkSync 成功后、rmSync 源之前崩溃
    // （link 的硬链接与 trash 源同 inode，内容天然一致）
    const trashAbs = join(root, '工作区', '.trash', 'doc_ch01-0001-开篇.md')
    const origAbs = join(root, '写作', '正文', '第一卷', '0001-开篇.md')
    linkSync(trashAbs, origAbs)
    expect(existsSync(origAbs)).toBe(true) // 双份在位
    // 修复前：此处 OCCUPIED 卡死（每次还原都撞占用，条目永不清）
    const r = await restoreTrash(root, 'doc_ch01')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 源被清、目标保留、清单恢复、条目移除
    expect(existsSync(trashAbs)).toBe(false)
    expect(existsSync(origAbs)).toBe(true)
    expect(readFileSync(origAbs, 'utf-8')).toContain('正文')
    expect(readFileSync(join(root, '项目', '文档清单.jsonl'), 'utf-8')).toContain('doc_ch01')
    expect(listTrash(root)).toHaveLength(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R65-36: 目标位是作者另建的不同内容 → 仍 OCCUPIED（内容比对不一致不误吞作者文件）', async () => {
  const { root, svc } = makeBookWithChapter()
  try {
    await svc.trashDocument({ docId: 'doc_ch01' })
    mkdirSync(join(root, '写作', '正文', '第一卷'), { recursive: true })
    writeFileSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'), '作者完全不同的新内容', 'utf-8')
    const r = await restoreTrash(root, 'doc_ch01')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('OCCUPIED')
    expect(listTrash(root)).toHaveLength(1) // 条目保留
    expect(readFileSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'), 'utf-8')).toBe('作者完全不同的新内容')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── R67-11（十五轮）：doTrash 入口 safeDocId 纵深守卫 ──────────────

test('R67-11: 恶意 docId（manifest 篡改数据面）→ PATH_ESCAPE，不进 snapshot/trash 链', async () => {
  const { root, svc } = makeBookWithChapter()
  // 清单被篡改：登记一条带穿越形态 id 的条目（safeDocId 应在入口拦下，
  // 而非依赖下游 resolveSafePath 兜底）
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    [
      '{"version":1,"type":"header"}',
      '{"id":"../../evil","nodeType":"document","path":"写作/正文/第一卷/0001-开篇.md","parentId":null}',
    ].join('\n') + '\n',
  )
  const r = await svc.trashDocument({ docId: '../../evil' })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.code).toBe('PATH_ESCAPE')
  // 原文件无损，回收站/快照无穿越产物
  expect(existsSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'))).toBe(true)
  expect(existsSync(join(root, '工作区', '.trash'))).toBe(false)
  rmSync(root, { recursive: true, force: true })
})
