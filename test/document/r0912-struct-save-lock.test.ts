/**
 * R0912-2（2026-09-11 重评-0911c 修复批）：结构性操作落位段的 per-doc save 锁。
 *
 * 修复前：doTrash 落位（linkOrRenameExclusive+rmWithRetry）与 doMoveOrRename 落位
 * 全程无 `<journal>.save.lock`——他进程 executeSave 过锁内守卫后、落盘前，结构性
 * 操作把文件 rename 走并删源，他进程 atomicWriteFile/createFileExclusive 在旧路径
 * 复活已删/已移走文件（expectedRevision=null 新建语义尤其如此）。
 *
 * 锚定手法（r76-save-protocol R76-1 同款：本进程外持锁模拟跨进程持锁者）：持锁期间
 * doTrash / moveDocument / renameDocument 必须 fail-closed（WRITE_ERROR 等待超时、
 * 文件一字不动）——若落位段不在锁内会立即成功；释放后恢复可用、锁不残留。
 * 另锚 meta 调用链（已持 save 锁传 holdSaveLock:false）未因本修复引入同进程嵌套
 * 自锁（R76-1 既有形态 + rename 路径仍成功）。
 */
import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DocumentService,
  __setStructSaveLockTimeoutForTest,
} from '../../src/document/service.js'
import { acquireCrossProcessLockWithTimeout } from '../../src/fs/cross-process-lock.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'

let bookRoot = ''
beforeEach(() => {
  bookRoot = mkdtempSync(join(tmpdir(), 'clw-r0912-lock-'))
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
})
afterEach(() => {
  if (bookRoot) rmSync(bookRoot, { recursive: true, force: true })
  __setStructSaveLockTimeoutForTest(5_000)
})

function saveLockPath(docId: string): string {
  return join(bookRoot, '工作区', '.journal', `${docId}.jsonl.save.lock`)
}

/** 登记 docId → relPath（清单在册，无布线书形态规避 rebuild 无关面）。 */
function register(docId: string, rel: string): void {
  const mp = join(bookRoot, '项目', '文档清单.jsonl')
  const m = readManifest(mp)
  upsertEntry(m, { id: docId, nodeType: 'document', path: rel, parentId: null })
  writeManifest(mp, m)
}

test('R0912-2: 持 save 锁期间 doTrash fail-closed（文件未动、未进回收站）；释放后可用', async () => {
  const svc = new DocumentService({ bookRoot })
  const c = await svc.createDocument({ relPath: '设定/世界观.md', content: '---\n名称: A\n---\n正文' })
  if (!c.ok) throw new Error('prereq create')
  register(c.docId, '设定/世界观.md')
  const abs = join(bookRoot, '设定/世界观.md')

  __setStructSaveLockTimeoutForTest(150)
  const release = acquireCrossProcessLockWithTimeout(saveLockPath(c.docId), 0)
  expect(release).not.toBeNull()
  const r = await svc.trashDocument({ docId: c.docId })
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.code).toBe('WRITE_ERROR')
    expect(r.reason).toContain('删除等待超时')
  }
  expect(existsSync(abs)).toBe(true) // 文件未动（未落位）
  expect(existsSync(join(bookRoot, '工作区', '.trash'))).toBe(false) // 未进回收站
  release!()

  const r2 = await svc.trashDocument({ docId: c.docId })
  expect(r2.ok).toBe(true)
  expect(existsSync(abs)).toBe(false)
  expect(existsSync(saveLockPath(c.docId))).toBe(false) // 锁不残留
})

test('R0912-2: 持 save 锁期间 renameDocument/moveDocument fail-closed（文件未动）；释放后可用', async () => {
  const svc = new DocumentService({ bookRoot })
  const c = await svc.createDocument({ relPath: '写作/正文/0001-开篇.md', content: '---\n章号: 1\n标题: 开篇\n---\n正文' })
  if (!c.ok) throw new Error('prereq create')
  register(c.docId, '写作/正文/0001-开篇.md')
  const abs = join(bookRoot, '写作/正文/0001-开篇.md')

  __setStructSaveLockTimeoutForTest(150)
  const release = acquireCrossProcessLockWithTimeout(saveLockPath(c.docId), 0)
  expect(release).not.toBeNull()
  const r1 = await svc.renameDocument({ docId: c.docId, newName: '0001-改.md' })
  expect(r1.ok).toBe(false)
  if (!r1.ok) {
    expect(r1.code).toBe('WRITE_ERROR')
    expect(r1.reason).toContain('等待超时')
  }
  const r2 = await svc.moveDocument({ docId: c.docId, toDir: '写作/正文/卷一' })
  expect(r2.ok).toBe(false)
  if (!r2.ok) expect(r2.code).toBe('WRITE_ERROR')
  expect(existsSync(abs)).toBe(true)
  expect(existsSync(join(bookRoot, '写作/正文/0001-改.md'))).toBe(false)
  expect(existsSync(join(bookRoot, '写作/正文/卷一/0001-开篇.md'))).toBe(false)
  release!()

  const r3 = await svc.renameDocument({ docId: c.docId, newName: '0001-改.md' })
  expect(r3.ok).toBe(true)
  expect(existsSync(abs)).toBe(false)
  expect(existsSync(join(bookRoot, '写作/正文/0001-改.md'))).toBe(true)
  expect(existsSync(saveLockPath(c.docId))).toBe(false)
})

test('R0912-2: meta 链（已持 save 锁）→ rename 路径仍成功（holdSaveLock:false 无嵌套自锁）', async () => {
  // 回归锚：updateChapterMetaLocked 内部 doMoveOrRename 若仍缺省取锁（同 docId 同进程
  // 嵌套同路径锁），会等满超时 fail-closed → 改标题恒失败。传 false 后正常 rename。
  const svc = new DocumentService({ bookRoot })
  const c = await svc.createDocument({
    relPath: '写作/正文/0001-开篇.md',
    content: '---\n章号: 1\n标题: 开篇\n---\n正文',
  })
  if (!c.ok) throw new Error('prereq create')
  register(c.docId, '写作/正文/0001-开篇.md')
  // 缺省 5s 档即可：若发生嵌套自锁，用例会卡满 5s 后失败（fail-loud）
  const r = await svc.updateChapterMeta(c.docId, { 标题: '新标题' })
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.path).toBe('写作/正文/0001-新标题.md')
  expect(existsSync(join(bookRoot, '写作/正文/0001-新标题.md'))).toBe(true)
  expect(existsSync(saveLockPath(c.docId))).toBe(false)
})

test('R0912-2: 复活窗契约锚定——守卫与落位之间持锁者介入时，save 侧按锁互斥等待而非复活', async () => {
  // 修复形态的反向验证：save（executeSave）先持锁的窗口内，doTrash 必须等待而非落位——
  // 即「他进程保存中，删除不会把文件从其脚下移走」。以本进程先持锁、doTrash 超时失败
  // 锚定互斥方向（与用例 1 同一互斥对的另一侧语义）。
  const svc = new DocumentService({ bookRoot })
  const c = await svc.createDocument({ relPath: '设定/人物.md', content: '---\n名称: 张三\n---\n正文' })
  if (!c.ok) throw new Error('prereq create')
  register(c.docId, '设定/人物.md')
  __setStructSaveLockTimeoutForTest(150)
  const release = acquireCrossProcessLockWithTimeout(saveLockPath(c.docId), 0)
  expect(release).not.toBeNull()
  // 外持锁模拟「他进程 save 持锁中」：doTrash 不得落位（等锁超时）
  const t = svc.trashDocument({ docId: c.docId })
  const r = await t
  expect(r.ok).toBe(false)
  expect(existsSync(join(bookRoot, '设定/人物.md'))).toBe(true)
  release!()
})
