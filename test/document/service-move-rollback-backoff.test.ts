/**
 * 重评-13（全库代码重评审 2026-09-05）回归：doMoveOrRename 删源失败回滚链
 * 「回收新位硬链接」（service.ts R33-43 范式处）收编退避删 rmWithRetry。
 *
 * 背景：删源 rmWithRetry 耗尽（win 持续占用）进回滚后，回滚删新位原为裸
 * rmSync——win 瞬时锁（EPERM/EBUSY，杀软/索引器毫秒级释放）下直败会把「可
 * 回收的回滚」劣化成新位孤儿副本滞留。收编后退避重试救回瞬时锁；退避后仍
 * 失败照旧吞错留孤儿副本（硬链接同数据，语义与裸删时代一致，仍按 WRITE_ERROR 收口）。
 *
 * 夹具：node:fs rmSync 注入（r37-piece-list-rename.test.ts 同款手法）——按目录段
 * +文件名注入持续/一次性 EPERM（resolveSafePath 走 realpath 归一，mac 上 /var →
 * /private/var，字符串全等对不上）。
 */
import { test, expect, afterEach, vi } from 'vitest'
import { rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentService } from '../../src/document/service.js'
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
  const root = mkdtempTracked(join(tmpdir(), 'reap-13-move-'))
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

test('重评-13: 移动删源失败回滚——回收新位首删撞瞬时 EPERM → 退避后回收干净，源原地未动', async () => {
  const { root, svc, docId, bodyAbs } = await makeBookWithChapter()

  // 删源（正文源路径）持续 EPERM → rmWithRetry 耗尽进回滚；回滚删新位（素材/ 下
  // 硬链接副本）首删 EPERM（瞬时锁形态，一次后放行）。按目录段区分互不误伤。
  let newListRmCalls = 0
  vi.mocked(rmSyncMocked).mockImplementation((...args) => {
    const p = args[0]
    if (typeof p === 'string' && p.includes('正文') && p.endsWith('0001-开篇.md')) throw errOf('EPERM')
    if (typeof p === 'string' && p.includes('素材') && p.endsWith('0001-开篇.md')) {
      newListRmCalls++
      if (newListRmCalls === 1) throw errOf('EPERM')
    }
    return actualFs.rmSync(...args)
  })

  const r = await svc.moveDocument({ docId, toDir: '素材' })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.code).toBe('WRITE_ERROR')

  // 回滚经退避后收净（收编前裸 rmSync 首删直败 → 新位孤儿副本滞留）
  expect(newListRmCalls).toBe(2) // 首删 EPERM + 退避重试成功——退避链确被走
  expect(existsSync(join(root, '素材', '0001-开篇.md'))).toBe(false)
  // 源原地未动、内容无损（可重试）
  expect(existsSync(bodyAbs)).toBe(true)
  expect(readFileSync(bodyAbs, 'utf-8')).toContain('正文内容。')
})

test('重评-13: 移动删源失败回滚——回收新位持续 EPERM → 重试耗尽吞错留孤儿副本，仍 WRITE_ERROR', async () => {
  const { root, svc, docId, bodyAbs } = await makeBookWithChapter()

  // 删源与回滚删新位均持续占用（非瞬时形态）
  vi.mocked(rmSyncMocked).mockImplementation((...args) => {
    const p = args[0]
    if (typeof p === 'string' && (p.includes('正文') || p.includes('素材')) && p.endsWith('0001-开篇.md')) {
      throw errOf('EPERM')
    }
    return actualFs.rmSync(...args)
  })

  const r = await svc.moveDocument({ docId, toDir: '素材' })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.code).toBe('WRITE_ERROR')
  // 回滚退避耗尽仍失败 → 照旧吞错：新位孤儿副本残留（硬链接同数据，无丢失），源原地未动
  expect(existsSync(join(root, '素材', '0001-开篇.md'))).toBe(true)
  expect(existsSync(bodyAbs)).toBe(true)
})
