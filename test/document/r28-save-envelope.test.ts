/**
 * R28（二十八轮修复批 A）：文档保存链回归。
 *
 * - R28-5：executeSave 锁内段裸穿收编——临界段原为 try { … } finally { docSaveLock() }
 *   无外层 catch，段内同步调用（lookupPathByDocId 的 legacy 收编链 withManifestLock
 *   2×5s 超时 throw / computeRevision / readFileSync）任一抛出 → SaveQueue reject →
 *   save() 变 rejected promise / API 500，违反 SaveResult 契约信封（manifest.ts RMW
 *   段注释宣称的「executeSave 内 catch → WRITE_ERROR」对锁内段不实；R27-43 只收编了
 *   取锁前段）。修后外层 catch 兜「落盘前同步段」意外抛出，save() resolve 出
 *   {ok:false, code:'WRITE_ERROR'} 信封，finally 释放锁不受影响。
 * - R28-13：updateChapterMeta 的 R26-51 覆盖前留底不再二次读盘——直喂 R27-45 单次读
 *   的 fileBytes（同源派生），断言快照内容 === 被覆盖的盘上旧内容（若仍二次读盘，
 *   两读之间被换档时会留错档；本测试锁定「留底 = 被覆盖内容」这一行为契约）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentService } from '../../src/document/service.js'
import { listVersions, readVersion, VERSIONS_DIR_NAME } from '../../src/document/version.js'
import { computeRevision } from '../../src/document/revision.js'

describe('R28 保存链契约', () => {
  let bookRoot: string
  let svc: DocumentService
  let docId: string
  let absPath: string
  let lockPath: string
  const relPath = '写作/正文/0001-开篇.md'
  const contentV1 = '---\n标题: 开篇\n章号: 1\n---\n正文'
  const contentV2 = '---\n标题: 开篇\n章号: 1\n---\n新正文'

  beforeEach(async () => {
    bookRoot = mkdtempSync(join(tmpdir(), 'r28-envelope-'))
    svc = new DocumentService({ bookRoot })
    const c = await svc.createDocument({ relPath, content: contentV1 })
    if (!c.ok) throw new Error('prereq create 失败')
    docId = c.docId
    absPath = join(bookRoot, relPath)
    lockPath = join(bookRoot, '工作区', '.journal', `${docId}.jsonl.save.lock`)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(bookRoot, { recursive: true, force: true })
  })

  // ── R28-5 ────────────────────────────────────────────────────

  it('R28-5: 锁内 lookupPathByDocId 抛出 → save() resolve 出 WRITE_ERROR 信封（不 reject），锁已释放', async () => {
    // 第 1 次调用 = 取锁前段（R27-43 已收编，须正常返回走到取锁）；第 2 次 = 锁内段
    // 复核（:333），模拟 legacy 收编链清单锁超时 throw；其后恢复真身供后续保存用。
    const target = svc as unknown as { lookupPathByDocId: (id: string) => string | null }
    const real = target.lookupPathByDocId.bind(svc)
    let calls = 0
    vi.spyOn(target, 'lookupPathByDocId').mockImplementation((id: string) => {
      calls++
      if (calls === 2) throw new Error('清单锁获取超时（模拟 withManifestLock 2×5s fail-closed）')
      return real(id)
    })
    const rev1 = computeRevision(absPath)
    // 契约信封：resolve 而非 reject——修复前此形态直接裸抛（rejected promise）
    const r = await svc.save(docId, relPath, {
      content: contentV2,
      expectedRevision: rev1,
      operationId: 'op-r28-5',
      origin: 'manual',
    })
    expect(calls).toBe(2) // 前段 1 次 + 锁内 1 次（抛点）
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('WRITE_ERROR')
      expect(r.reason).toContain('保存失败（未落盘，可重试）')
      expect(r.reason).toContain('清单锁获取超时')
    }
    // 未落盘：正文一字未动
    expect(readFileSync(absPath, 'utf-8')).toBe(contentV1)
    // 抛点在 appendPending 之前：无 journal 孤儿 pending
    expect(svc.recover()).toHaveLength(0)
    // finally 生效：锁释放干净（锁文件不在盘），后续保存照常成功
    expect(existsSync(lockPath)).toBe(false)
    const r2 = await svc.save(docId, relPath, {
      content: contentV2,
      expectedRevision: rev1,
      operationId: 'op-r28-5b',
      origin: 'manual',
    })
    expect(r2.ok).toBe(true)
    expect(readFileSync(absPath, 'utf-8')).toBe(contentV2)
    expect(existsSync(lockPath)).toBe(false)
  })

  // ── R28-13 ───────────────────────────────────────────────────

  it('R28-13: meta PATCH 覆盖前留底 === 被覆盖的盘上旧内容（R27-45 单次读同源派生）', () => {
    const oldContent = readFileSync(absPath, 'utf-8')
    expect(oldContent).toBe(contentV1)
    const r = svc.updateChapterMeta(docId, { 标题: '新标题' })
    expect(r.ok).toBe(true)
    const versionsDir = join(bookRoot, '工作区', VERSIONS_DIR_NAME)
    // updateChapterMeta 落两版：meta-overwrite 覆盖前留底 + doMoveOrRename 改名结构留底；
    // 本修复只锁定前者
    const entries = listVersions(versionsDir, docId)
    const metas = entries.map((e) => ({ e, v: readVersion(versionsDir, docId, e.id) }))
    const snapEntry = metas.find((m) => m.v?.meta.origin === 'meta-overwrite')
    expect(snapEntry).toBeDefined()
    expect(metas.filter((m) => m.v?.meta.origin === 'meta-overwrite')).toHaveLength(1) // force 留底恰好一版
    const snap = snapEntry!.v!
    expect(snap).not.toBeNull()
    expect(snap?.meta.origin).toBe('meta-overwrite')
    // 留底内容 = 被覆盖内容（直喂 fileBytes 字节档；若回退成二次读盘，两读间换档
    // 即留错档——本断言锁定同源派生契约）
    expect(snap?.content).toBe(oldContent)
  })
})
