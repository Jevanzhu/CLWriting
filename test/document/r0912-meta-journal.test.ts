/**
 * R0912-4（2026-09-11 重评-0911c 修复批）：meta PATCH 双路径写回补 journal
 * pending/settled 配对（保存协议统一；此前原子写兜底只保「不半截」，崩溃窗在健康面
 * 零痕迹，且与 R0912-1a 的 save 类自动消解语义脱节）。
 *
 * 锚定：
 * - updateDocMeta（不 rename 路径）：写回后 journal pending/settled 完整配对
 *   （findUnsettled 清零），文件 fm 已更新；
 * - updateChapterMeta（rename 路径）：save pending（fm 写回）与 move pending（改名）
 *   双双配对结算，无悬置；
 * - 写失败路径：pending 补 aborted（不留幽灵悬置），文件未动，返回 WRITE_ERROR
 *   （mock atomicWriteFile ENOSPC 构造）。
 */
import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ATOMIC = vi.hoisted(() => ({ failWrite: false }))
vi.mock('../../src/fs/atomic.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/fs/atomic.js')>()
  return {
    ...actual,
    atomicWriteFile: ((p, c, o) => {
      if (ATOMIC.failWrite) throw Object.assign(new Error('ENOSPC: 模拟磁盘满'), { code: 'ENOSPC' })
      return (actual.atomicWriteFile as typeof actual.atomicWriteFile)(p, c, o)
    }) as typeof actual.atomicWriteFile,
  }
})

import { DocumentService } from '../../src/document/service.js'
import { findUnsettled } from '../../src/document/journal.js'
import { encodeDocDirName } from '../../src/document/version.js'

let bookRoot = ''
let svc: DocumentService

beforeEach(() => {
  bookRoot = mkdtempSync(join(tmpdir(), 'clw-r0912-meta-'))
  mkdirSync(join(bookRoot, '设定'), { recursive: true })
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  svc = new DocumentService({ bookRoot })
  ATOMIC.failWrite = false
})

afterEach(() => {
  ATOMIC.failWrite = false
  if (bookRoot) rmSync(bookRoot, { recursive: true, force: true })
})

function journalPathOf(docId: string): string {
  return join(bookRoot, '工作区', '.journal', `${encodeDocDirName(docId)}.jsonl`)
}

test('R0912-4: updateDocMeta 写回后 journal pending/settled 配对（findUnsettled 清零）', async () => {
  const c = await svc.createDocument({ relPath: '设定/世界观.md', content: '---\n名称: A\n---\n正文' })
  if (!c.ok) throw new Error('prereq create')
  const r = await svc.updateDocMeta(c.docId, { 名称: 'A-改' })
  expect(r.ok).toBe(true)
  // fm 已更新
  expect(readFileSync(join(bookRoot, '设定/世界观.md'), 'utf-8')).toContain('A-改')
  // journal 协议面：pending 已配对 settled（崩溃窗从此有账可查，R0912-1a 可按
  // 盘上指纹 vs baseRevision 确定性收口）
  const unsettled = findUnsettled(journalPathOf(c.docId))
  expect(unsettled).toHaveLength(0)
})

test('R0912-4: updateChapterMeta rename 路径——save pending 与 move pending 双双配对结算', async () => {
  const c = await svc.createDocument({
    relPath: '写作/正文/0001-开篇.md',
    content: '---\n章号: 1\n标题: 开篇\n---\n正文',
  })
  if (!c.ok) throw new Error('prereq create')
  const r = await svc.updateChapterMeta(c.docId, { 标题: '新标题' })
  expect(r.ok).toBe(true)
  expect(existsSync(join(bookRoot, '写作/正文/0001-新标题.md'))).toBe(true)
  // fm 写回（save pending）+ 文件名 rename（move pending）均无悬置
  expect(findUnsettled(journalPathOf(c.docId))).toHaveLength(0)
})

test('R0912-4: 写回失败（ENOSPC）→ pending 补 aborted（无幽灵悬置），文件未动，WRITE_ERROR', async () => {
  const c = await svc.createDocument({ relPath: '设定/世界观.md', content: '---\n名称: A\n---\n正文' })
  if (!c.ok) throw new Error('prereq create')
  const before = readFileSync(join(bookRoot, '设定/世界观.md'), 'utf-8')
  ATOMIC.failWrite = true
  const r = await svc.updateDocMeta(c.docId, { 名称: 'A-改' })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.code).toBe('WRITE_ERROR')
  // 文件未动
  expect(readFileSync(join(bookRoot, '设定/世界观.md'), 'utf-8')).toBe(before)
  // journal：pending 已 aborted（配对完成，findUnsettled 清零——不留幽灵悬置）
  expect(findUnsettled(journalPathOf(c.docId))).toHaveLength(0)
  // journal 文件里应有 aborted 行（留痕可考）
  const jRaw = readFileSync(journalPathOf(c.docId), 'utf-8')
  expect(jRaw).toContain('"status":"aborted"')
})
