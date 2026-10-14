/**
 * 重评-13（全库代码重评审 2026-09-05）回归：doMoveOrRename 删源失败回滚链
 * 「回收新位硬链接」（service.ts R33-43 范式处）收编退避删 rmWithRetry。
 *
 * 背景：删源 rmWithRetry 耗尽（win 持续占用）进回滚后，回滚删新位原为裸
 * rmSync——win 瞬时锁（EPERM/EBUSY，杀软/索引器毫秒级释放）下直败会把「可
 * 回收的回滚」劣化成新位孤儿副本滞留。收编后退避重试救回瞬时锁；退避后仍
 * 失败照旧吞错留孤儿副本（硬链接同数据，语义与裸删时代一致，仍按 WRITE_ERROR 收口）。
 *
 * 夹具：node:fs rmSync 注入（piece-list-rename.test.ts 同款手法）——按目录段
 * +文件名注入持续/一次性 EPERM（resolveSafePath 走 realpath 归一，mac 上 /var →
 * /private/var，字符串全等对不上）。
 */
import { test, expect, describe, afterEach, vi } from 'vitest'
import { rmSync, mkdirSync, existsSync, readFileSync, chmodSync } from 'node:fs'
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

// journal.appendAborted 抛错注入（默认不武装 → 全透传原实现）：仅供本文件末尾的
// 「移动失败 + 留痕也失败」用例显式 arm，其余用例行为零差异。
const ABORT_FAIL = vi.hoisted(() => ({ arm: false }))
vi.mock('../../src/document/journal.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/document/journal.js')>()
  return {
    ...orig,
    // 只让 appendAborted 失败：pending 正常写入（拿到 opId），settled 不在该路径
    appendAborted: vi.fn((...args: Parameters<typeof orig.appendAborted>) => {
      if (ABORT_FAIL.arm) {
        throw Object.assign(new Error('EACCES: journal 磁盘满（模拟）'), { code: 'EACCES' })
      }
      return orig.appendAborted(...args)
    }),
  }
})
import { appendAborted } from '../../src/document/journal.js'

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

// ── doMoveOrRename catch 块内 appendAborted 自身可抛穿透：移动/重命名失败（rename
// EACCES 等）进 catch 后要补 journal aborted 行留痕，但 appendAborted 自己也可能失败
// （journal 目录被删/磁盘满/权限）——此前该异常直接穿透，调用方拿到裸 throw 而非
// {ok:false} 契约（moveDocument 用 Promise.resolve 包裹不捕获 throw，变成 rejected
// promise）。断言：仍返回 {ok:false}、留痕尝试发生过、源文件不动（fail-closed）。──

describe('移动失败且留痕也失败（双重故障契约）', () => {
  // Windows 无 POSIX 权限位（chmod 为 no-op/仅映射只读位），该守卫语义由 macOS/Linux CI 腿覆盖
  test.skipIf(process.platform === 'win32')('移动失败且 appendAborted 也失败 → 仍返回 {ok:false} 不穿透', async () => {
    const { root, svc, docId, bodyAbs } = await makeBookWithChapter()
    ABORT_FAIL.arm = true
    // 目标目录只读 → renameSync EACCES 进 catch（pending 已写入，opId 已拿到）
    mkdirSync(join(root, '写作', '正文', '第二卷'), { recursive: true })
    chmodSync(join(root, '写作', '正文', '第二卷'), 0o555)
    try {
      const r = await svc.moveDocument({ docId, toDir: '写作/正文/第二卷' })
      // 契约：双重故障下仍拿到 {ok:false}，而不是裸异常/rejected promise
      // （落盘走 linkSync——只读目录同样 EACCES，非 EEXIST，仍是 WRITE_ERROR）
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.code).toBe('WRITE_ERROR')
      expect(r.reason).toContain('移动/重命名失败')
      // 留痕尝试发生过（appendAborted 被调用，失败被兜底吞掉）
      expect(vi.mocked(appendAborted)).toHaveBeenCalledTimes(1)
      // fail-closed：源文件未被移动
      expect(existsSync(bodyAbs)).toBe(true)
      expect(existsSync(join(root, '写作', '正文', '第二卷', '0001-开篇.md'))).toBe(false)
    } finally {
      chmodSync(join(root, '写作', '正文', '第二卷'), 0o755)
      ABORT_FAIL.arm = false
      vi.mocked(appendAborted).mockClear()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
