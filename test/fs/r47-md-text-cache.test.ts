/**
 * R47-5/R47-10/R47-27（四十七轮）：共享 md 文本指纹缓存模块（src/fs/md-text-cache.ts）回归。
 *
 * 范式（R47-26 同款）：vi.mock 包 readFileSync/promises.readFile 计数观测「是否重读」。
 * 覆盖：同指纹二次读零读盘、内容变更指纹失配重读、文件删除清条目返 null、
 * 读失败（权限）返 null 不抛、异步孪生与同步版共享指纹表、FIFO 上限淘汰。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { readMdTextCached, readMdTextCachedAsync, __mdTextCacheTestHooks } from '../../src/fs/md-text-cache.js'

const readMock = vi.mocked(readFileSync)
const readAsyncMock = vi.mocked(readFile)

describe('R47-27：md 文本指纹缓存（fs/md-text-cache.ts）', () => {
  let dir: string
  let fp: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'r47-mdcache-'))
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
