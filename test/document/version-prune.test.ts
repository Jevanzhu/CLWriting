/**
 * pruneVersions pinned 保留策略测试（P1-T1）：
 * 验证定稿里程碑（pinned=true）在超期/maxCount 兜底时恒保留。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  writeVersion,
  pruneVersions,
  listVersions,
  readVersion,
  DEFAULT_VERSION_POLICY,
} from '../../src/document/version.js'

let dir: string
const docId = 'doc_test'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clw-prune-'))
})

afterEach(() => {
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
