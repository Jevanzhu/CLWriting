/**
 * R37-14（三十七轮）回归：doTrash 删源失败回滚回收站侧。
 *
 * 背景：软删链「先登记后移文件」（GG-P2-6）——appendTrashEntryAsync 写条目 +
 * linkOrRenameExclusive 落位 .trash 后，rmSync 删源失败（win EBUSY/EPERM 瞬时占用）
 * 原先直接上抛，回收站已落位的副本与条目不清理，留下「回收站有条目但源文件还在」的
 * 双份状态（restore 撞源位 OCCUPIED、purge 把仍在原位的文件按不可逆语义清掉）。
 *
 * 修复后行为（本文件锁定，对齐 doMoveOrRename R33-43 删源失败回收新位范式）：
 * 1. 正常软删：源删、.trash 落位、条目在案（基线回归）；
 * 2. 删源失败（mock rmSync 注入 EPERM，r35-27 同款先例）：回收站副本删除 + 条目
 *    移除 + WRITE_ERROR 上抛，源文件原地未动、清单条目保留（可重试）。
 */
import { test, expect, afterEach, vi } from 'vitest'
import { rmSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentService } from '../../src/document/service.js'
import { listTrash } from '../../src/document/trash.js'
import { readManifest } from '../../src/document/manifest.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

// actual 经 hoisted 容器带出——用例内 mockImplementation 需要真实现做 pass-through
const actualFs = vi.hoisted(() => ({
  rmSync: undefined as unknown as typeof import('node:fs').rmSync,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  actualFs.rmSync = actual.rmSync
  return { ...actual, rmSync: vi.fn(actual.rmSync) }
})

import { rmSync as rmSyncMocked } from 'node:fs'

const errOf = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`mock ${code}`), { code })

const roots: string[] = []
afterEach(() => {
  vi.mocked(rmSyncMocked).mockReset()
  vi.mocked(rmSyncMocked).mockImplementation((...args) => actualFs.rmSync(...args))
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** 造书 + 一章正文（经 createDocument 落清单） */
async function makeBookWithChapter(): Promise<{ root: string; svc: DocumentService; docId: string; bodyAbs: string }> {
  const root = mkdtempTracked(join(tmpdir(), 'r37-trash-'))
  roots.push(root)
  mkdirSync(join(root, '工作区'), { recursive: true })
  const svc = new DocumentService({ bookRoot: root })
  const c = await svc.createDocument({
    relPath: '写作/正文/0001-开篇.md',
    content: '---\n章号: 1\n标题: 开篇\n---\n\n正文内容。',
  })
  if (!c.ok) throw new Error('prereq create 失败')
  const bodyAbs = join(root, '写作', '正文', '0001-开篇.md')
  if (!existsSync(bodyAbs)) throw new Error('prereq 正文缺失')
  return { root, svc, docId: c.docId, bodyAbs }
}

test('R37-14: 正常软删——源删、.trash 落位、条目在案（基线回归）', async () => {
  const { root, svc, docId, bodyAbs } = await makeBookWithChapter()

  const r = await svc.trashDocument({ docId })
  expect(r.ok).toBe(true)

  expect(existsSync(bodyAbs)).toBe(false) // 源已删
  const trashDir = join(root, '工作区', '.trash')
  expect(readdirSync(trashDir).filter((f) => f.endsWith('.md'))).toHaveLength(1) // 副本落位
  expect(listTrash(root).some((t) => t.id === docId)).toBe(true) // 条目在案
})

test('R37-14: 删源失败（rmSync EPERM）→ 回收站回滚 + WRITE_ERROR，源与清单原地未动', async () => {
  const { root, svc, docId, bodyAbs } = await makeBookWithChapter()

  // 仅对正文源路径注入 EPERM（win 文件被占用形态）；其余 rmSync（含回滚删回收站副本）照常。
  // 按目录段+文件名匹配——resolveSafePath 走 realpath 归一（mac 上 /var → /private/var），
  // 全等对不上；回收站副本文件名带 docId 前缀，不含该正文文件名，不误伤。
  vi.mocked(rmSyncMocked).mockImplementation((...args) => {
    const p = args[0]
    if (typeof p === 'string' && p.includes('正文') && p.endsWith('0001-开篇.md')) throw errOf('EPERM')
    return actualFs.rmSync(...args)
  })

  const r = await svc.trashDocument({ docId })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.code).toBe('WRITE_ERROR') // 原错误上抛收口，可重试

  // 源文件原地未动、内容无损
  expect(existsSync(bodyAbs)).toBe(true)
  expect(readFileSync(bodyAbs, 'utf-8')).toContain('正文内容。')
  // 回收站侧回滚干净：无 .trash 副本残留、无条目残留（修复前双份状态污染 restore/purge）
  const trashDir = join(root, '工作区', '.trash')
  const leftovers = existsSync(trashDir) ? readdirSync(trashDir).filter((f) => f.endsWith('.md')) : []
  expect(leftovers).toHaveLength(0)
  expect(listTrash(root).some((t) => t.id === docId)).toBe(false)
  // 清单条目保留（manifest 删除在删源之后，未执行）——文件未删则登记不除名，状态一致
  expect(readManifest(join(root, '项目', '文档清单.jsonl')).entries.has(docId)).toBe(true)
})
