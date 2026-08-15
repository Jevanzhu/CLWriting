/**
 * AA-P1-1：version 指纹缓存跨 prune 不透失效回归测试。
 *
 * 场景核心：指纹缓存命中 = ① 内容指纹相等 ② 缓存指向的版本 id 仍在盘。
 * 若「内容恰等于已被 prune / 外部删除的版本」的强制留底（移动/改名/restore 覆盖前）
 * 被缓存静默吞掉 → 无版本可回滚，违背 W0-1 留底纪律。本测试验证两重防线：
 *   1. pruneVersions 删除版本时同步失效缓存（invalidateVersionCache）；
 *   2. 命中时校验缓存指向的 id 仍在盘（外部删除 / 陈旧缓存兜底）。
 * 另验证「版本仍在盘」的正常去重仍生效（不回退 P3-14 优化）。
 */
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs'
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
const docId = 'doc_cache'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clw-cache-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function exists(id: string | null): boolean {
  if (!id) return false
  return listVersions(dir, docId).some((s) => s.id === id)
}

/** 未来时间触发超期清理（全部版本删除） */
const FUTURE = () => Date.now() + 100 * 24 * 60 * 60 * 1000

describe('AA-P1-1：version 指纹缓存跨 prune 失效', () => {
  it('prune 删除版本 → 缓存同步失效 → 重写同内容必须落新版本', () => {
    // ① 写 A → 生成版本 id1，缓存指向 id1
    const id1 = writeVersion(dir, docId, '内容A', { origin: 'manual' })
    expect(id1).not.toBeNull()
    expect(exists(id1)).toBe(true)

    // ② prune（未来时间）删掉 id1（非 pinned）
    const removed = pruneVersions(dir, docId, DEFAULT_VERSION_POLICY, FUTURE())
    expect(removed).toBeGreaterThan(0)
    expect(exists(id1)).toBe(false)
    // A 的缓存已随 prune 失效（invalidateVersionCache）

    // ③ 重写内容 A（恰等于已被删版本）→ 必须落新版本，不得 return null
    const id2 = writeVersion(dir, docId, '内容A', { origin: 'manual' })
    expect(id2).not.toBeNull()
    expect(id2).not.toBe(id1)
    expect(exists(id2)).toBe(true)
    expect(readVersion(dir, docId, id2!)?.content).toBe('内容A')
  })

  it('外部删除版本（缓存陈旧）→ 命中时校验 id 仍在盘 → 强制留底照常落盘', () => {
    const id1 = writeVersion(dir, docId, '内容A', { origin: 'manual' })
    expect(id1).not.toBeNull()
    // 人为删除版本文件（模拟外部清理/手工挪动目录），缓存仍指向 id1（未经 prune 通道）
    unlinkSync(join(dir, docId, `${id1}.md`))
    expect(exists(id1)).toBe(false)

    // 缓存命中但 id 不在盘 → 必须失效缓存、读盘比对（版本已无）→ 落新版本
    const id2 = writeVersion(dir, docId, '内容A', { origin: 'manual' })
    expect(id2).not.toBeNull()
    expect(id2).not.toBe(id1)
  })

  it('「版本仍在盘」的常规去重仍生效（不回退 P3-14 优化）', () => {
    const id1 = writeVersion(dir, docId, '内容A', { origin: 'manual' })
    expect(id1).not.toBeNull()
    // 同 origin 同内容 → 去重（缓存命中 + id 在盘）→ null
    expect(writeVersion(dir, docId, '内容A', { origin: 'manual' })).toBeNull()
    expect(listVersions(dir, docId)).toHaveLength(1)
    // 不同内容 → 落新版本
    const id2 = writeVersion(dir, docId, '内容B', { origin: 'manual' })
    expect(id2).not.toBeNull()
    expect(exists(id2)).toBe(true)
  })

  it('force 路径同验：prune 销 A 后 force 留底必落盘（不因缓存空吞）', () => {
    const id1 = writeVersion(dir, docId, '内容A', { origin: 'manual' })
    expect(id1).not.toBeNull()
    pruneVersions(dir, docId, DEFAULT_VERSION_POLICY, FUTURE())
    expect(exists(id1)).toBe(false)
    // 移动/删除/restore 前的「必须留底」= force 写（force 是 options 第 5 参，非 meta）
    const id2 = writeVersion(dir, docId, '内容A', { origin: 'delete' }, { force: true })
    expect(id2).not.toBeNull()
    expect(id2).not.toBe(id1)
  })
})