/**
 * R42（四十二轮修复批）document 域回归：
 *
 * - R42-7：executeSave 的 Z-6 复活守卫读换 readTrashManifestStrict（fail-closed）——
 *   守卫处的回收站清单读失败（EACCES 等）不再按容错版「空表 = 静默放行」，而是保守
 *   拒绝保存（WRITE_ERROR、未落盘、可重试）。两臂：取锁前守卫（:330 段）/ 锁内复核
 *   （:407 段，读失败走外层 catch 的「未落盘，可重试」信封）。
 * - R42-10：doTrash 删源瞬时 EPERM 一次 → rmWithRetry 退避后软删成功（win 杀软/
 *   索引器瞬时锁形态，不再误触发回收站回滚）。
 * - R42-12：卷纲关联两收口——.MD 大写扩展名可关联（isMdFileName 单源）；NFD 卷目录名
 *   与 NFC 卷纲文件名（及反向）经 toNfcName 归一后互认，关联 path 落盘上真实文件名。
 *
 * 夹具：node:fs 注入（r38-migrate-tombstone.test.ts 同款手法）——readFileSync 对
 * .trash-manifest.jsonl 的条件性 EACCES / 第 N 次命中；rmSync 对指定路径的一次性 EPERM。
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const failState = vi.hoisted(() => ({
  /** true = 回收站清单 readFileSync 恒抛 EACCES（守卫读失败臂）。 */
  trashManifestReadFails: false,
  /** >0 = 回收站清单 readFileSync 第 N 次命中时抛 EACCES（锁内复核臂：第 1 次
   *  （取锁前守卫）放行、第 2 次（锁内复核）失败）。 */
  trashManifestFailOnNthRead: 0,
  /** 回收站清单读取计数（trashManifestFailOnNthRead 的分母，afterEach 复位）。 */
  trashReadCount: 0,
  /** 命中即抛 EPERM 一次（一次性瞬时锁形态，抛后放行）。 */
  rmEpisOn: null as string | null,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: (p: string, encoding?: string) => {
      if (typeof p === 'string' && p.includes('.trash-manifest.jsonl')) {
        failState.trashReadCount++
        if (failState.trashManifestReadFails || failState.trashReadCount === failState.trashManifestFailOnNthRead) {
          throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' })
        }
      }
      return encoding === undefined
        ? actual.readFileSync(p)
        : actual.readFileSync(p, encoding as 'utf-8')
    },
    rmSync: (p: string, opts?: { recursive?: boolean; force?: boolean }) => {
      if (typeof p === 'string' && failState.rmEpisOn === p) {
        failState.rmEpisOn = null // 瞬时锁形态：一次后放行
        throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${p}'`), { code: 'EPERM' })
      }
      return actual.rmSync(p, opts)
    },
  }
})

import { DocumentService } from '../../src/document/service.js'
import { readTrashManifest } from '../../src/document/trash.js'
import { computeRevision } from '../../src/document/revision.js'
import { buildTree, type TreeNode } from '../../src/document/tree.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

function tmpRoot(): string {
  return mkdtempTracked(join(tmpdir(), 'clw-r42-'))
}

afterEach(() => {
  failState.trashManifestReadFails = false
  failState.trashManifestFailOnNthRead = 0
  failState.trashReadCount = 0
  failState.rmEpisOn = null
})

/** 造书：已登记章文档（清单 + 盘上文件）+ 空回收站清单（存在即可被 strict 读命中）。 */
function seedBook(root: string): { abs: string } {
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  mkdirSync(join(root, '工作区', '.trash'), { recursive: true })
  const abs = join(root, '写作', '正文', '0001-a.md')
  writeFileSync(abs, '---\n章号: 1\n---\n\n旧内容', 'utf-8')
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    JSON.stringify({ version: 1, type: 'clwriting-manifest' }) + '\n' +
      JSON.stringify({ id: 'doc_r42', nodeType: 'document', path: '写作/正文/0001-a.md', parentId: null }) + '\n',
    'utf-8',
  )
  // 回收站清单存在但为空（合法空表）——守卫 strict 读的 existsSync 门槛通过，读失败臂
  // 由 fs 注入制造
  writeFileSync(join(root, '工作区', '.trash', '.trash-manifest.jsonl'), '', 'utf-8')
  return { abs }
}

describe('R42-7：Z-6 复活守卫读失败 → 保守拒绝（fail-closed）', () => {
  it('取锁前守卫：清单读 EACCES → WRITE_ERROR（未落盘、可重试），盘上内容原样', async () => {
    const root = tmpRoot()
    const { abs } = seedBook(root)
    failState.trashManifestReadFails = true
    const svc = new DocumentService({ bookRoot: root })
    const r = await svc.save('doc_r42', '写作/正文/0001-a.md', {
      content: '---\n章号: 1\n---\n\n新内容',
      expectedRevision: computeRevision(abs),
      operationId: 'op-r42a',
      origin: 'manual',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('WRITE_ERROR')
      expect(r.reason).toContain('回收站清单读取失败')
      expect(r.reason).toContain('可重试')
    }
    // 未落盘：内容原样
    expect(readFileSync(abs, 'utf-8')).toContain('旧内容')
  })

  it('锁内复核：第 2 次读（复核段）失败 → 外层 catch 信封 WRITE_ERROR「未落盘，可重试」', async () => {
    const root = tmpRoot()
    const { abs } = seedBook(root)
    // 第 1 次 = 取锁前守卫（放行），第 2 次 = 锁内复核（失败）
    failState.trashManifestFailOnNthRead = 2
    const svc = new DocumentService({ bookRoot: root })
    const r = await svc.save('doc_r42', '写作/正文/0001-a.md', {
      content: '---\n章号: 1\n---\n\n新内容',
      expectedRevision: computeRevision(abs),
      operationId: 'op-r42b',
      origin: 'manual',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('WRITE_ERROR')
      expect(r.reason).toContain('未落盘，可重试')
    }
    expect(readFileSync(abs, 'utf-8')).toContain('旧内容')
  })

  it('对照：读正常时同款保存成功（注入不影响主路径）', async () => {
    const root = tmpRoot()
    const { abs } = seedBook(root)
    const svc = new DocumentService({ bookRoot: root })
    const r = await svc.save('doc_r42', '写作/正文/0001-a.md', {
      content: '---\n章号: 1\n---\n\n新内容',
      expectedRevision: computeRevision(abs),
      operationId: 'op-r42c',
      origin: 'manual',
    })
    expect(r.ok).toBe(true)
    expect(readFileSync(abs, 'utf-8')).toContain('新内容')
  })
})

describe('R42-10：删源瞬时 EPERM 一次 → rmWithRetry 退避后操作成功', () => {
  it('doTrash：源文件首删 EPERM 一次 → 软删成功（不触发回收站回滚）', async () => {
    const root = tmpRoot()
    const { abs } = seedBook(root)
    failState.rmEpisOn = abs // 删源一次性瞬时锁（win 杀毒/索引器形态）
    const svc = new DocumentService({ bookRoot: root })
    const r = await svc.trashDocument({ docId: 'doc_r42' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.trashedPath).toBeDefined()
      // 源已删、回收站落位、条目在册（回滚未触发）
      expect(existsSync(abs)).toBe(false)
      const trashAbs = join(root, r.trashedPath)
      expect(existsSync(trashAbs)).toBe(true)
      expect(readFileSync(trashAbs, 'utf-8')).toContain('旧内容')
      expect(readTrashManifest(root).some((t) => t.id === 'doc_r42')).toBe(true)
    }
  })
})

// ── R42-12：卷纲关联（.MD 大小写不敏感 + NFC 归一互认）──────────────────────

function findNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const n of nodes) {
    if (n.path === path) return n
    if (n.children.length) {
      const f = findNode(n.children, path)
      if (f) return f
    }
  }
  return null
}

/** NFC 形 'café'（U+00E9）与 NFD 形 'cafe'+U+0301（CJK 常用字无分解形，用带音符
 *  拉丁名构造两侧不同形的卷名/卷纲名——mac APFS 存 NFD、win/NTFS 惯 NFC 的典型载体）。 */
const VOL_NFC = 'caf\u00e9'
const VOL_NFD = 'cafe\u0301'

describe('R42-12：卷纲关联大小写不敏感 + NFC/NFD 互认', () => {
  it('.MD 大写扩展名卷纲可关联，关联 path 落盘上真实文件名', () => {
    const root = tmpRoot()
    mkdirSync(join(root, '写作', '正文', '第一卷'), { recursive: true })
    writeFileSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'), '---\n章号: 1\n---\n正文', 'utf-8')
    mkdirSync(join(root, '大纲', '卷纲'), { recursive: true })
    writeFileSync(join(root, '大纲', '卷纲', '第一卷.MD'), '# 纲', 'utf-8')
    const vol = findNode(buildTree(root), '写作/正文/第一卷')
    expect(vol).not.toBeNull()
    expect(vol!.volumeOutlinePath).toBe('大纲/卷纲/第一卷.MD')
  })

  it('NFD 卷目录 ↔ NFC 卷纲互认（关联 path 落盘上原始文件名）', () => {
    const root = tmpRoot()
    mkdirSync(join(root, '写作', '正文', VOL_NFD), { recursive: true })
    writeFileSync(join(root, '写作', '正文', VOL_NFD, '0001-开篇.md'), '---\n章号: 1\n---\n正文', 'utf-8')
    mkdirSync(join(root, '大纲', '卷纲'), { recursive: true })
    writeFileSync(join(root, '大纲', '卷纲', `${VOL_NFC}.md`), '# 纲', 'utf-8')
    // 卷目录节点 path 取自扫盘原样名（NFD 形或 FS 归一形皆可命中）
    const nodes = buildTree(root)
    const vol = findNode(nodes, `写作/正文/${VOL_NFD}`) ?? findNode(nodes, `写作/正文/${VOL_NFC}`)
    expect(vol).not.toBeNull()
    expect(vol!.volumeOutlinePath).toBeDefined()
    // 关联文件在盘上真实存在（volName+'.md' 硬拼会指向不存在的路径）
    expect(existsSync(join(root, vol!.volumeOutlinePath!))).toBe(true)
  })

  it('NFC 卷目录 ↔ NFD 卷纲互认（反向）', () => {
    const root = tmpRoot()
    mkdirSync(join(root, '写作', '正文', VOL_NFC), { recursive: true })
    writeFileSync(join(root, '写作', '正文', VOL_NFC, '0001-开篇.md'), '---\n章号: 1\n---\n正文', 'utf-8')
    mkdirSync(join(root, '大纲', '卷纲'), { recursive: true })
    writeFileSync(join(root, '大纲', '卷纲', `${VOL_NFD}.md`), '# 纲', 'utf-8')
    const nodes = buildTree(root)
    const vol = findNode(nodes, `写作/正文/${VOL_NFC}`) ?? findNode(nodes, `写作/正文/${VOL_NFD}`)
    expect(vol).not.toBeNull()
    expect(vol!.volumeOutlinePath).toBeDefined()
    expect(existsSync(join(root, vol!.volumeOutlinePath!))).toBe(true)
  })

  it('对照：无对应卷纲 → volumeOutlinePath undefined（既有语义不变）', () => {
    const root = tmpRoot()
    mkdirSync(join(root, '写作', '正文', '第二卷'), { recursive: true })
    writeFileSync(join(root, '写作', '正文', '第二卷', '0050-惊蛰.md'), '---\n章号: 50\n---\n正文', 'utf-8')
    mkdirSync(join(root, '大纲', '卷纲'), { recursive: true })
    writeFileSync(join(root, '大纲', '卷纲', '第三卷.md'), '# 纲', 'utf-8')
    const vol = findNode(buildTree(root), '写作/正文/第二卷')
    expect(vol).not.toBeNull()
    expect(vol!.volumeOutlinePath).toBeUndefined()
  })
})
