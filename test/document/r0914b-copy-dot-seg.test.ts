/**
 * r0914b（全库重评-0914 修复批 B）P2-2：doCopy 目录段 `.` 前置拒绝。
 *
 * 此前只拒 `..`；目录段「已存在则原样保留」分支对 `.` 恒命中（existsSync(join(root,
 * 'a','.')) 即 `a` 本身）→ `a/./b.md` 原文进 copyRelPath 登记而物理落位经
 * resolveSafePath 词法折叠，登记与盘上路径分裂 → docId 身份分裂（R51-D-3 同族终点）。
 * 口径对齐 normalizeMoveToDir 的 `..`/`.` 双拒。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentService } from '../../src/document/service.js'

describe('r0914b P2-2: doCopy 目录段 `.` 前置拒绝', () => {
  let bookRoot: string
  let svc: DocumentService
  beforeEach(() => {
    bookRoot = mkdtempSync(join(tmpdir(), 'r0914b-copy-dot-'))
    mkdirSync(join(bookRoot, '工作区'), { recursive: true })
    svc = new DocumentService({ bookRoot })
  })
  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  it('a/./b.md 形态 → PATH_ESCAPE「路径段非法」，不落盘', async () => {
    const created = await svc.createDocument({
      relPath: '写作/正文/0001-源.md',
      content: '---\n章号: 1\n标题: 源\n---\n正文',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const r = await svc.copyDocument({ docId: created.docId, relPath: '写作/正文/./0002-副本.md' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('PATH_ESCAPE')
    expect(r.reason).toContain('路径段非法')
    expect(existsSync(join(bookRoot, '写作/正文/0002-副本.md'))).toBe(false)
  })

  it('对照：合法 relPath 复制不受影响（防误伤回归）', async () => {
    const created = await svc.createDocument({
      relPath: '写作/正文/0001-源.md',
      content: '---\n章号: 1\n标题: 源\n---\n正文',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const r = await svc.copyDocument({ docId: created.docId, relPath: '写作/正文/0002-副本.md' })
    expect(r.ok).toBe(true)
    expect(existsSync(join(bookRoot, '写作/正文/0002-副本.md'))).toBe(true)
  })
})
