/**
 * doCopy 目标目录段净化与拒绝（DocumentService.copyDocument 公开面）。
 *
 * 两段口径：
 * - 目录段净化（R2W-5）：目标中含尚不存在的目录段时过 sanitizeFileNamePart（与 move
 *   侧同款），「设定/CON./笔记.md」不再 mkdir EINVAL 裸 500；已存在的目录段身份不动。
 * - `.` 段前置拒绝（重评-0914b P2-2）：原只拒 `..`，「已存在则原样保留」分支对 `.`
 *   恒命中（existsSync(join(root,'a','.')) 即 `a` 本身）→ `a/./b.md` 原文进登记而物理
 *   落位经词法折叠，登记与盘上路径分裂致 docId 身份分裂。口径对齐 normalizeMoveToDir
 *   的 `..`/`.` 双拒。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { DocumentService } from '../../src/document/service.js'
import { legacyId } from '../../src/document/stable-id.js'

describe('doCopy 目录段净化（R2W-5）', () => {
  /** 单章书夹具：正文目录 + 一章源文件，返回 service（目标目录由用例自选） */
  function makeBookWithChapter(tag: string): { root: string; svc: DocumentService } {
    const root = mkdtempTracked(join(tmpdir(), tag))
    const bodyDir = join(root, '写作', '正文')
    mkdirSync(bodyDir, { recursive: true })
    writeFileSync(join(bodyDir, '0001-a.md'), '---\n标题: a\n---\n正文', 'utf-8')
    return { root, svc: new DocumentService({ bookRoot: root }) }
  }

  it('保留设备名目录段（CON.）→ 净化为 _CON 落位，不裸 500', async () => {
    const { root, svc } = makeBookWithChapter('clw-r2w5-copy-')
    try {
      const r = await svc.copyDocument({ docId: legacyId('写作/正文/0001-a.md'), relPath: '设定/CON./笔记.md' })
      expect(r.ok).toBe(true)
      // 落位在净化后的目录段下（sanitizeFileNamePart：尾点剥离 + 保留名避让）
      const settingDir = join(root, '设定')
      expect(existsSync(settingDir)).toBe(true)
      expect(readdirSync(settingDir)).toContain('_CON')
      expect(existsSync(join(root, '设定', '_CON', '笔记.md'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('既有目录段身份不动（净化不重写已存在的合法段）', async () => {
    const { root, svc } = makeBookWithChapter('clw-r2w5-copy2-')
    try {
      const r = await svc.copyDocument({ docId: legacyId('写作/正文/0001-a.md'), relPath: '设定/角色/笔记.md' })
      expect(r.ok).toBe(true)
      expect(existsSync(join(root, '设定', '角色', '笔记.md'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('doCopy 目录段 `.` 前置拒绝（重评-0914b P2-2）', () => {
  let bookRoot: string
  let svc: DocumentService
  beforeEach(() => {
    bookRoot = mkdtempTracked(join(tmpdir(), 'r0914b-copy-dot-'))
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
