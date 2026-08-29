/**
 * T2-5 回归：atomicWriteFile 默认 fsync=true（数据安全优先）。
 *
 * - 缺省调用：fsyncSync 被调（临时文件内容 + 父目录元数据）
 * - 显式 fsync:false：快速路径，不 fsync
 * - 显式 fsync:true：与缺省一致
 */
import { rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempTracked } from '../helpers/temp-dir.js'

// ESM 内置模块的导出不可 spy（namespace 不可配置）——工厂内换 vi.fn 包装透传
const h = vi.hoisted(() => ({ fsyncMock: null as unknown as ReturnType<typeof vi.fn> }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  h.fsyncMock = vi.fn(actual.fsyncSync)
  return { ...actual, fsyncSync: h.fsyncMock }
})

const { atomicWriteFile } = await import('../../src/fs/atomic.js')

let dir = ''
afterEach(() => {
  h.fsyncMock.mockClear()
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = ''
  }
})

describe('T2-5 atomicWriteFile 默认 fsync', () => {
  it('缺省（不传 opts）→ fsync 生效（内容 + 目录）', () => {
    dir = mkdtempTracked(join(tmpdir(), 'clwriting-atomic-'))
    const p = join(dir, 'a.json')
    atomicWriteFile(p, '{"a":1}')
    expect(readFileSync(p, 'utf-8')).toBe('{"a":1}')
    // 文件内容 fsync ≥1 次；目录 fsync（POSIX）再 ≥1 次
    expect(h.fsyncMock).toHaveBeenCalled()
    expect(h.fsyncMock.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('显式 fsync:true → 与缺省一致', () => {
    dir = mkdtempTracked(join(tmpdir(), 'clwriting-atomic-'))
    atomicWriteFile(join(dir, 'b.json'), 'x', { fsync: true })
    expect(h.fsyncMock).toHaveBeenCalled()
  })

  it('显式 fsync:false → 不 fsync（高频低价值写快速路径）', () => {
    dir = mkdtempTracked(join(tmpdir(), 'clwriting-atomic-'))
    const p = join(dir, 'c.json')
    atomicWriteFile(p, 'y', { fsync: false })
    expect(readFileSync(p, 'utf-8')).toBe('y')
    expect(h.fsyncMock).not.toHaveBeenCalled()
  })
})
