import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteFile } from '../../src/fs/atomic.js'

describe('atomicWriteFile', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atomic-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('默认写入目标文件（向后兼容）', () => {
    const f = join(dir, 'a.md')
    atomicWriteFile(f, 'hello')
    expect(readFileSync(f, 'utf-8')).toBe('hello')
  })

  it('fsync=true 写入并落盘', () => {
    const f = join(dir, 'b.md')
    atomicWriteFile(f, 'world', { fsync: true })
    expect(readFileSync(f, 'utf-8')).toBe('world')
  })

  it('写入成功后无 tmp 残留', () => {
    const f = join(dir, 'c.md')
    atomicWriteFile(f, 'x', { fsync: true })
    const tmps = readdirSync(dir).filter((n) => n.endsWith('.tmp'))
    expect(tmps).toHaveLength(0)
  })

  it('覆盖既有文件', () => {
    const f = join(dir, 'd.md')
    writeFileSync(f, 'old')
    atomicWriteFile(f, 'new', { fsync: true })
    expect(readFileSync(f, 'utf-8')).toBe('new')
  })

  it('支持 Uint8Array', () => {
    const f = join(dir, 'e.md')
    atomicWriteFile(f, new Uint8Array([1, 2, 3]))
    expect(Array.from(readFileSync(f))).toEqual([1, 2, 3])
  })
})
