/**
 * pruneVersions pinned 保留策略测试（P1-T1）：
 * 验证定稿里程碑（pinned=true）在超期/maxCount 兜底时恒保留。
 *
 * 重评-14（全库代码重评审 2026-09-05）：逐版本删除收编退避删 rmWithRetry 的回归——
 * win 杀软/索引器瞬时锁（EPERM/EBUSY）下首删直败曾让旧版本滞留/伴生文件残留。
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  writeVersion,
  pruneVersions,
  listVersions,
  readVersion,
  encodeDocDirName,
  DEFAULT_VERSION_POLICY,
} from '../../src/document/version.js'

// actual 经 hoisted 容器带出——用例内 mockImplementation 需要真实现做 pass-through
// （r42-40 / r37 系同款手法：按文件名注入一次性/持续 EPERM，其余全透传零影响）
const actualFs = vi.hoisted(() => ({
  unlinkSync: undefined as unknown as typeof import('node:fs').unlinkSync,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  actualFs.unlinkSync = actual.unlinkSync
  return { ...actual, unlinkSync: vi.fn(actual.unlinkSync) }
})

import { unlinkSync as unlinkSyncMocked } from 'node:fs'

const errOf = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`mock ${code}`), { code })

/** 取路径末段文件名——精确匹配防 `._<id>.md` 伴生名对 `<id>.md` 主名的后缀误伤 */
function baseName(p: unknown): string {
  return typeof p === 'string' ? p.replace(/\\/g, '/').split('/').pop()! : ''
}

let dir: string
const docId = 'doc_test'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clw-prune-'))
})

afterEach(() => {
  vi.mocked(unlinkSyncMocked).mockReset()
  vi.mocked(unlinkSyncMocked).mockImplementation((...args) => actualFs.unlinkSync(...args))
  rmSync(dir, { recursive: true, force: true })
})

/** 检查指定 id 的版本是否存在 */
function exists(id: string | null): boolean {
  if (!id) return false
  return listVersions(dir, docId).some((s) => s.id === id)
}

/** 检查指定 id 的版本是否 pinned */
function isPinned(id: string | null): boolean {
  if (!id) return false
  return readVersion(dir, docId, id)?.meta.pinned === true
}

describe('pruneVersions pinned 保留', () => {
  it('pinned 版本超期后仍然保留', () => {
    const pinnedId = writeVersion(dir, docId, '定稿内容', { origin: 'finalize', pinned: true })
    writeVersion(dir, docId, '草稿1', { origin: 'autosave' })
    writeVersion(dir, docId, '草稿2', { origin: 'autosave' })
    writeVersion(dir, docId, '草稿3', { origin: 'autosave' })

    expect(isPinned(pinnedId)).toBe(true)

    // 模拟 100 天后（超 maxDays:14）
    const future = Date.now() + 100 * 24 * 60 * 60 * 1000
    const removed = pruneVersions(dir, docId, DEFAULT_VERSION_POLICY, future)
    expect(removed).toBeGreaterThan(0)

    // pinned 版本必须存活
    expect(exists(pinnedId)).toBe(true)
    expect(isPinned(pinnedId)).toBe(true)
  })

  it('maxCount 兜底时 pinned 不被裁', () => {
    const pinned1 = writeVersion(dir, docId, '定稿1', { origin: 'finalize', pinned: true })
    writeVersion(dir, docId, '草稿a', { origin: 'autosave' })
    writeVersion(dir, docId, '草稿b', { origin: 'autosave' })
    writeVersion(dir, docId, '草稿c', { origin: 'autosave' })
    const pinned2 = writeVersion(dir, docId, '定稿2', { origin: 'finalize', pinned: true })
    writeVersion(dir, docId, '草稿d', { origin: 'autosave' })
    writeVersion(dir, docId, '草稿e', { origin: 'autosave' })

    expect(isPinned(pinned1)).toBe(true)
    expect(isPinned(pinned2)).toBe(true)

    // maxCount=3，但 2 个 pinned 必须保留
    const policy = { maxDays: 365, maxCount: 3, throttleMinutes: 0 }
    pruneVersions(dir, docId, policy)

    expect(exists(pinned1)).toBe(true)
    expect(exists(pinned2)).toBe(true)
  })

  it('BE-2: pinned >= maxCount 时非 pinned 版本全部清理（修复负索引保留过多）', () => {
    // pinned 4 个 > maxCount 3 → 修复前 slice(0, 3-4=-1) 保留除末尾 1 个外全部非 pinned
    // 修复后 Math.max(0, -1)=0 → 非 pinned 全清理
    const pinned1 = writeVersion(dir, docId, '定稿1', { origin: 'finalize', pinned: true })
    const pinned2 = writeVersion(dir, docId, '定稿2', { origin: 'finalize', pinned: true })
    const pinned3 = writeVersion(dir, docId, '定稿3', { origin: 'finalize', pinned: true })
    const pinned4 = writeVersion(dir, docId, '定稿4', { origin: 'finalize', pinned: true })
    const draftA = writeVersion(dir, docId, '草稿a', { origin: 'autosave' })
    const draftB = writeVersion(dir, docId, '草稿b', { origin: 'autosave' })

    const policy = { maxDays: 365, maxCount: 3, throttleMinutes: 0 }
    pruneVersions(dir, docId, policy)

    // pinned 恒在
    expect(exists(pinned1)).toBe(true)
    expect(exists(pinned2)).toBe(true)
    expect(exists(pinned3)).toBe(true)
    expect(exists(pinned4)).toBe(true)
    // 非 pinned 全清理（修复前 slice(0,-1) 会保留 draftA）
    expect(exists(draftA)).toBe(false)
    expect(exists(draftB)).toBe(false)
  })

  it('全 pinned 场景 prune 返回 0', () => {
    const a = writeVersion(dir, docId, '定稿A', { origin: 'finalize', pinned: true })
    const b = writeVersion(dir, docId, '定稿B', { origin: 'finalize', pinned: true })

    const future = Date.now() + 365 * 24 * 60 * 60 * 1000
    const removed = pruneVersions(dir, docId, DEFAULT_VERSION_POLICY, future)
    expect(removed).toBe(0)
    expect(exists(a)).toBe(true)
    expect(exists(b)).toBe(true)
  })

  it('无 pinned 时正常按超期清理', () => {
    const ids: string[] = []
    for (let i = 0; i < 10; i++) {
      const id = writeVersion(dir, docId, `草稿${i}`, { origin: 'autosave' })
      if (id) ids.push(id)
    }

    // 当前时间 → 全在 FINE_WINDOW → 全留
    pruneVersions(dir, docId, DEFAULT_VERSION_POLICY, Date.now())
    ids.forEach((id) => expect(exists(id)).toBe(true))

    // 100 天后 → 全超期 → 全删
    const future = Date.now() + 100 * 24 * 60 * 60 * 1000
    const removed = pruneVersions(dir, docId, DEFAULT_VERSION_POLICY, future)
    expect(removed).toBe(ids.length)
    expect(listVersions(dir, docId).length).toBe(0)
  })

  it('空目录 → 返回 0', () => {
    expect(pruneVersions(dir, '不存在的doc', DEFAULT_VERSION_POLICY)).toBe(0)
  })
})

// ── 重评-14（全库代码重评审 2026-09-05）：逐版本删除收编退避删 rmWithRetry ──

describe('pruneVersions 退避删（重评-14）', () => {
  it('主删撞瞬时 EPERM（win 杀软/索引器）→ 退避后删净', () => {
    const victim = writeVersion(dir, docId, '超期旧稿', { origin: 'autosave' })
    expect(victim).not.toBeNull()
    let calls = 0
    vi.mocked(unlinkSyncMocked).mockImplementation((...args) => {
      if (baseName(args[0]) === `${victim}.md`) {
        calls++
        if (calls === 1) throw errOf('EPERM') // 瞬时锁形态：一次后放行
      }
      return actualFs.unlinkSync(...args)
    })

    const future = Date.now() + 100 * 24 * 60 * 60 * 1000
    const removed = pruneVersions(dir, docId, DEFAULT_VERSION_POLICY, future)
    expect(removed).toBe(1)
    expect(calls).toBe(2) // 首删 EPERM + 退避重试成功——退避链确被走（裸删时代此处直败滞留）
    expect(exists(victim)).toBe(false)
  })

  it('退避耗尽仍删不动 → 跳过该版本不阻断其余清理（prune 幂等，下次写重扫自愈）', () => {
    const stuck = writeVersion(dir, docId, '被占用旧稿', { origin: 'autosave' })
    const free = writeVersion(dir, docId, '正常旧稿', { origin: 'autosave' })
    vi.mocked(unlinkSyncMocked).mockImplementation((...args) => {
      if (baseName(args[0]) === `${stuck}.md`) throw errOf('EPERM') // 持续占用（非瞬时）
      return actualFs.unlinkSync(...args)
    })

    const future = Date.now() + 100 * 24 * 60 * 60 * 1000
    const removed = pruneVersions(dir, docId, DEFAULT_VERSION_POLICY, future)
    expect(removed).toBe(1) // 仅 free 计入删除；stuck 耗尽跳过（catch-continue 语义不变）
    expect(exists(stuck)).toBe(true)
    expect(exists(free)).toBe(false)
  })

  it('AppleDouble 伴生删除撞瞬时 EPERM → 退避后一并清理', () => {
    const victim = writeVersion(dir, docId, '伴生清理', { origin: 'autosave' })
    // 手工放置伴生文件（macOS 拷贝形态）
    const adPath = join(dir, encodeDocDirName(docId), `._${victim}.md`)
    writeFileSync(adPath, 'resource fork', 'utf-8')
    let adCalls = 0
    vi.mocked(unlinkSyncMocked).mockImplementation((...args) => {
      if (baseName(args[0]) === `._${victim}.md`) {
        adCalls++
        if (adCalls === 1) throw errOf('EPERM')
      }
      return actualFs.unlinkSync(...args)
    })

    const future = Date.now() + 100 * 24 * 60 * 60 * 1000
    const removed = pruneVersions(dir, docId, DEFAULT_VERSION_POLICY, future)
    expect(removed).toBe(1)
    expect(adCalls).toBe(2) // 伴生首删 EPERM + 退避重试成功
    expect(existsSync(adPath)).toBe(false)
  })
})
