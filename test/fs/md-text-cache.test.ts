/**
 * R47-5/R47-10/R47-27（四十七轮）：共享 md 文本指纹缓存模块（src/fs/md-text-cache.ts）回归。
 *
 * 范式（R47-26 同款）：vi.mock 包 readFileSync/promises.readFile 计数观测「是否重读」。
 * 覆盖：同指纹二次读零读盘、内容变更指纹失配重读、文件删除清条目返 null、
 * 读失败（权限）返 null 不抛、异步孪生与同步版共享指纹表、FIFO 上限淘汰。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, writeFileSync, utimesSync, chmodSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 粗粒度卷替身（见下方「低精度 mtime 卷」组注）——登记路径的 bigint stat 按帧返回。 */
const { coarseStatFrames } = vi.hoisted(() => ({ coarseStatFrames: new Map<string, { size: bigint; mtimeNs: bigint }>() }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    statSync: (p: string, opts?: { bigint?: boolean }) => {
      if (opts?.bigint && typeof p === 'string') {
        const frame = coarseStatFrames.get(p)
        if (frame) return frame as never
      }
      return actual.statSync(p, opts as never)
    },
  }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    stat: (p: string, opts?: { bigint?: boolean }) => {
      if (opts?.bigint && typeof p === 'string') {
        const frame = coarseStatFrames.get(p)
        if (frame) return Promise.resolve(frame as never)
      }
      return actual.stat(p, opts as never)
    },
  }
})

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { readMdTextCached, readMdTextCachedAsync, __mdTextCacheTestHooks } from '../../src/fs/md-text-cache.js'

const readMock = vi.mocked(readFileSync)
const readAsyncMock = vi.mocked(readFile)

describe('R47-27：md 文本指纹缓存（fs/md-text-cache.ts）', () => {
  let dir: string
  let fp: string
  beforeEach(() => {
    dir = mkdtempTracked(join(tmpdir(), 'r47-mdcache-'))
    fp = join(dir, '001-章.md')
    writeFileSync(fp, '---\n章号: 1\n---\n\n正文内容甲')
    __mdTextCacheTestHooks.clear()
    readMock.mockClear()
    readAsyncMock.mockClear()
  })
  afterEach(() => {
    try {
      chmodSync(fp, 0o644)
    } catch {
      /* 已删 */
    }
    rmSync(dir, { recursive: true, force: true })
    __mdTextCacheTestHooks.setMaxEntriesForTest(null)
    vi.restoreAllMocks()
  })

  it('R47-5：同指纹二次读零读盘（readFileSync 只触发一次）', () => {
    expect(readMdTextCached(fp)).toBe('---\n章号: 1\n---\n\n正文内容甲')
    expect(readMock.mock.calls.length).toBe(1)
    expect(readMdTextCached(fp)).toBe('---\n章号: 1\n---\n\n正文内容甲')
    expect(readMock.mock.calls.length).toBe(1)
  })

  it('内容变更（重写 + mtime 推进）→ 指纹失配重读新内容', () => {
    expect(readMdTextCached(fp)).toContain('正文内容甲')
    writeFileSync(fp, '---\n章号: 1\n---\n\n正文内容乙（变更后的更长正文，size 亦变）')
    const t = new Date()
    utimesSync(fp, new Date(t.getTime() + 5000), new Date(t.getTime() + 5000))
    expect(readMdTextCached(fp)).toContain('正文内容乙')
    expect(readMock.mock.calls.length).toBe(2)
  })

  it('文件删除 → 清条目返 null（TOCTOU 降级）', () => {
    expect(readMdTextCached(fp)).toContain('正文内容甲')
    rmSync(fp)
    expect(readMdTextCached(fp)).toBeNull()
  })

  // R56-P2-5：win 上 chmodSync 仅操作只读位、不产生读拒绝（读照常成功）——
  // 「权限失败 → null」验收面物理不可能成立（J3 批「chmod 13 文件」skipIf(win)
  // 同族）；权限失败路径由 posix CI 腿守护。
  it.skipIf(process.platform === 'win32')('读失败（权限，无缓存可用）→ 返 null 不抛', () => {
    chmodSync(fp, 0o000)
    try {
      expect(readMdTextCached(fp)).toBeNull()
    } finally {
      chmodSync(fp, 0o644)
    }
  })

  it('R47-5：异步孪生与同步版共享指纹表——同步先扫后异步命中零读盘；异步首读落缓存供同步复用', async () => {
    expect(readMdTextCached(fp)).toContain('正文内容甲')
    expect(await readMdTextCachedAsync(fp)).toBe('---\n章号: 1\n---\n\n正文内容甲')
    expect(readAsyncMock.mock.calls.length).toBe(0)
    const fp2 = join(dir, '002-章.md')
    writeFileSync(fp2, '异步首读')
    __mdTextCacheTestHooks.clear()
    readMock.mockClear()
    expect(await readMdTextCachedAsync(fp2)).toBe('异步首读')
    expect(readAsyncMock.mock.calls.length).toBe(1)
    expect(readMdTextCached(fp2)).toBe('异步首读')
    expect(readMock.mock.calls.length).toBe(0)
  })

  it('R47-27：FIFO 上限淘汰（超限丢最旧，被逐条目重读仍正确）', () => {
    __mdTextCacheTestHooks.setMaxEntriesForTest(2)
    const fp2 = join(dir, '002-章.md')
    const fp3 = join(dir, '003-章.md')
    writeFileSync(fp2, 'b')
    writeFileSync(fp3, 'c')
    expect(readMdTextCached(fp)).toContain('正文内容甲')
    expect(readMdTextCached(fp2)).toBe('b')
    expect(__mdTextCacheTestHooks.size()).toBe(2)
    expect(readMdTextCached(fp3)).toBe('c') // 淘汰最旧 fp
    expect(__mdTextCacheTestHooks.size()).toBe(2)
    expect(readMdTextCached(fp)).toContain('正文内容甲') // fp 被淘汰后重扫仍正确
    expect(readMock.mock.calls.length).toBe(4) // fp/fp2/fp3 首读 + fp 重读
  })
})

// ── 低精度 mtime 卷（FAT/exFAT/SMB）：文本指纹缓存降级 ──────────────
// 粗粒度卷的 mtime 粒度粗于毫秒 → 同尺寸改写可落在同一刻度内，(mtimeNs,size) 判据
// 失真。降级判据 = isCoarseMtimeNs（整毫秒对齐），该卷不读不写缓存、每次真读
// （见 readMdTextCached 头注）。本机卷为 ns 级精度，粗粒度形态由 stat 打桩构造。

describe('低精度 mtime 卷：md 文本缓存降级不返回陈旧文本', () => {
  let dir: string
  let fp: string
  beforeEach(() => {
    dir = mkdtempTracked(join(tmpdir(), 'mdcache-coarse-'))
    fp = join(dir, '001-章.md')
    __mdTextCacheTestHooks.clear()
    readMock.mockClear()
    readAsyncMock.mockClear()
    coarseStatFrames.clear()
  })
  afterEach(() => {
    coarseStatFrames.clear()
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('同尺寸改写落在同一粗粒度刻度 → 同步读返回新文本（不命中陈旧缓存）', () => {
    writeFileSync(fp, '---\n章号: 1\n---\n\n正文内容甲')
    const size = statSync(fp, { bigint: true }).size
    // 整毫秒对齐 = 低精度卷形态；两次读喂同一帧（粗粒度窗口内 stat 逐位相同）
    coarseStatFrames.set(fp, { size, mtimeNs: 1_700_000_002_000_000_000n })
    expect(readMdTextCached(fp)).toContain('正文内容甲')

    // 等长改写（甲 → 乙）：粗粒度卷上 size 与 mtimeNs 都不变
    writeFileSync(fp, '---\n章号: 1\n---\n\n正文内容乙')
    // 修复前：指纹全同 → 命中旧文本「甲」（去 fm 正文/机检行静默陈旧）；修复后重读「乙」
    expect(readMdTextCached(fp)).toContain('正文内容乙')
    expect(readMock.mock.calls.length).toBe(2) // 该卷不落缓存，两次都真读
  })

  it('异步孪生同口径：低精度卷两次真读（readFile 各一次），不落缓存', async () => {
    writeFileSync(fp, '---\n章号: 1\n---\n\n正文内容甲')
    const size = statSync(fp, { bigint: true }).size
    coarseStatFrames.set(fp, { size, mtimeNs: 1_700_000_002_000_000_000n })
    expect(await readMdTextCachedAsync(fp)).toContain('正文内容甲')
    expect(await readMdTextCachedAsync(fp)).toContain('正文内容甲')
    expect(readAsyncMock.mock.calls.length).toBe(2)
    expect(__mdTextCacheTestHooks.size()).toBe(0) // 降级即零驻留
  })

  it('精修卷（非整毫秒对齐）不降级：同指纹二次读零读盘（降级面只对粗粒度卷生效）', () => {
    writeFileSync(fp, '---\n章号: 1\n---\n\n正文内容甲')
    const size = statSync(fp, { bigint: true }).size
    // 亚毫秒余数 = ns 级精度卷形态；帧不变即判「盘上未变」
    coarseStatFrames.set(fp, { size, mtimeNs: 1_700_000_002_000_000_123n })
    expect(readMdTextCached(fp)).toContain('正文内容甲')
    expect(readMdTextCached(fp)).toContain('正文内容甲')
    expect(readMock.mock.calls.length).toBe(1) // 命中缓存，零重读
    expect(__mdTextCacheTestHooks.size()).toBe(1)
  })
})
