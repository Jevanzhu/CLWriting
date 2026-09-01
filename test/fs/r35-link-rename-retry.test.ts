/**
 * R35-27（三十五轮）回归：linkOrRenameExclusive 降级 rename 走 renameWithRetry。
 *
 * 降级分支（link EPERM/ENOSYS/EACCES → rename 落位）恰发生在 exFAT/SMB 等杀软/占用
 * 高发环境，此前裸 renameSync 无 EPERM/EBUSY 退避（主路径 atomicWriteFile R77-3 已
 * 有同名防线）。真 fs 难以确定性构造瞬时 EPERM，按 safe-path.test.ts 先例以 vi.mock
 * 包装 linkSync/renameSync 注入错误脚本；真实链路用默认接线冒烟兜底。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// actual 经 hoisted 容器带出——测试内 mockImplementation 需要真实现做 pass-through
const actualFs = vi.hoisted(() => ({
  linkSync: undefined as unknown as typeof import('node:fs').linkSync,
  renameSync: undefined as unknown as typeof import('node:fs').renameSync,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  actualFs.linkSync = actual.linkSync
  actualFs.renameSync = actual.renameSync
  return { ...actual, linkSync: vi.fn(actual.linkSync), renameSync: vi.fn(actual.renameSync) }
})

import { linkSync, renameSync } from 'node:fs'
import { linkOrRenameExclusive } from '../../src/fs/atomic.js'

const errOf = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`mock ${code}`), { code })

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clw-r35-27-'))
  vi.mocked(linkSync).mockImplementation((...args: Parameters<typeof linkSync>) => actualFs.linkSync(...args))
  vi.mocked(renameSync).mockImplementation((...args: Parameters<typeof renameSync>) => actualFs.renameSync(...args))
})
afterEach(() => {
  vi.mocked(linkSync).mockReset()
  vi.mocked(renameSync).mockReset()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('linkOrRenameExclusive 降级 rename 的 EPERM 退避（R35-27）', () => {
  it('link EPERM 降级后 rename 首撞 EPERM → 重试成功落位', () => {
    const src = join(dir, 'src.md')
    const dst = join(dir, 'dst.md')
    writeFileSync(src, '内容')
    vi.mocked(linkSync).mockImplementation(() => {
      throw errOf('EPERM') // 非 NTFS 卷形态：硬链接不可用 → 走降级
    })
    let renameCalls = 0
    vi.mocked(renameSync).mockImplementation((from, to) => {
      renameCalls++
      if (renameCalls === 1) throw errOf('EPERM') // 杀软/编辑器瞬时占用
      return actualFs.renameSync(from, to)
    })
    expect(linkOrRenameExclusive(src, dst)).toBe('created')
    expect(renameCalls).toBe(2) // 修复前裸 renameSync：1 次即抛，无重试
    expect(readFileSync(dst, 'utf-8')).toBe('内容')
  })

  it('确定性错误（ENOENT）仍立即上抛，不进退避', () => {
    const src = join(dir, 'src.md')
    const dst = join(dir, 'dst.md')
    writeFileSync(src, '内容')
    vi.mocked(linkSync).mockImplementation(() => {
      throw errOf('EPERM')
    })
    let renameCalls = 0
    vi.mocked(renameSync).mockImplementation(() => {
      renameCalls++
      throw errOf('ENOENT')
    })
    expect(() => linkOrRenameExclusive(src, dst)).toThrow('mock ENOENT')
    expect(renameCalls).toBe(1)
  })

  it('默认接线（真 link/rename）冒烟：created / exists 语义不变', () => {
    const src = join(dir, 'src.md')
    const dst = join(dir, 'dst.md')
    writeFileSync(src, 'A')
    expect(linkOrRenameExclusive(src, dst)).toBe('created')
    expect(readFileSync(dst, 'utf-8')).toBe('A')
    writeFileSync(join(dir, 'other.md'), 'B')
    expect(linkOrRenameExclusive(join(dir, 'other.md'), dst)).toBe('exists') // link 不覆盖
    expect(readFileSync(dst, 'utf-8')).toBe('A')
    expect(existsSync(src)).toBe(true) // link 落位后源仍在
  })
})
