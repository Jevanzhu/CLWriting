/**
 * C-3（二十九轮）回归：rename / 回收站落名消毒（format/filename.ts 单一真相源）。
 *
 * 背景：createDocument 的 relPath 早已逐段过 sanitizeCreateSegment（静默消毒：Windows
 * 非法字符 / 控制字符 / 尾点尾空格 / 保留设备名 / 超长截断），但 rename 的 newName 与
 * doTrash 的回收站落名只做 basename 检查——非法名直落盘（跨平台拷贝被拒或读写名
 * 不一致）。修复后两路径与 create 同源口径静默消毒；路径分隔符仍显式拒绝。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { DocumentService } from '../../src/document/service.js'
import { listTrash } from '../../src/document/trash.js'
import { writeManifest } from '../../src/document/manifest.js'

let bookRoot: string
let svc: DocumentService

beforeEach(() => {
  bookRoot = mkdtempSync(join(tmpdir(), 'r29-sanitize-'))
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  svc = new DocumentService({ bookRoot })
})

afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

describe('C-3 / rename 消毒', () => {
  it('newName 含 Windows 非法字符 → 静默消毒落盘（与 create 同源口径）', async () => {
    const c = await svc.createDocument({ relPath: '笔记/0001-旧名.md' })
    expect(c.ok).toBe(true)
    if (!c.ok) return
    const r = await svc.renameDocument({ docId: c.docId, newName: '0002-终章?.md' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // `?` → `_`：落名与返回 path 一致且为消毒后形态
    expect(r.path).toBe('笔记/0002-终章_.md')
    expect(existsSync(join(bookRoot, '笔记', '0002-终章_.md'))).toBe(true)
    expect(existsSync(join(bookRoot, '笔记', '0002-终章?.md'))).toBe(false)
  })

  it('newName 尾点形态 → 尾点剥离（win 落盘自动剖的读写名不一致防线）', async () => {
    const c = await svc.createDocument({ relPath: '笔记/0001-旧名.md' })
    if (!c.ok) throw new Error('prereq')
    const r = await svc.renameDocument({ docId: c.docId, newName: '0003-标题..md' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.path).toBe('笔记/0003-标题.md')
    expect(existsSync(join(bookRoot, '笔记', '0003-标题.md'))).toBe(true)
  })

  it('路径分隔符仍显式拒绝（不因消毒放宽为跨目录移动）', async () => {
    const c = await svc.createDocument({ relPath: '笔记/0001-旧名.md' })
    if (!c.ok) throw new Error('prereq')
    const r = await svc.renameDocument({ docId: c.docId, newName: '子目录/0002-x.md' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('PATH_ESCAPE')
    expect(existsSync(join(bookRoot, '笔记', '0001-旧名.md'))).toBe(true)
  })
})

describe('C-3 / 回收站落名消毒', () => {
  // win 适配（阶段 21 真机回归）：夹具要在盘上真实写出含 `?` 的文件名——POSIX 合法、
  // Windows 物理不可能（夹具第一步 writeFileSync 即 ENOENT），「清单登记未消毒名且盘上
  // 同名文件存在」这一前提在 win 上不可构造。skipIf 不修语义：消毒落名逻辑由纯函数
  // 单测（format/filename）与本用例的 mac/Linux CI 腿覆盖。
  it.skipIf(process.platform === 'win32')('登记路径含非法字符 → .trash 落名消毒，TrashEntry.trashedPath 记真实落位', async () => {
    // 手工造一个未消毒名的登记文档（POSIX 盘上合法 `?`；清单可篡改数据面不保证消毒）
    const dir = join(bookRoot, '笔记')
    mkdirSync(dir, { recursive: true })
    const rawRel = '笔记/0001-怪?名.md'
    writeFileSync(join(dir, '0001-怪?名.md'), '---\n标题: x\n---\n\n内容\n', 'utf-8')
    const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
    mkdirSync(dirname(manifestPath), { recursive: true })
    writeManifest(manifestPath, {
      version: 1,
      entries: new Map([['doc_t1', { id: 'doc_t1', nodeType: 'document', path: rawRel, parentId: null }]]),
    })
    const r = await svc.trashDocument({ docId: 'doc_t1' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 落名消毒：`?` → `_`；登记与盘上落位一致（还原链不断）
    expect(r.trashedPath).toBe('工作区/.trash/doc_t1-0001-怪_名.md')
    expect(existsSync(join(bookRoot, ...r.trashedPath.split('/')))).toBe(true)
    const entry = listTrash(bookRoot).find((e) => e.id === 'doc_t1')
    expect(entry?.trashedPath).toBe('工作区/.trash/doc_t1-0001-怪_名.md')
    // 原位文件已移走
    expect(existsSync(join(dir, '0001-怪?名.md'))).toBe(false)
    // 时间戳后缀重试链与消毒名同源（回归钉：stem/ext 从消毒名拆分）
    expect(readFileSync(join(bookRoot, ...r.trashedPath.split('/')), 'utf-8')).toContain('内容')
  })
})
