import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeRevision } from '../../src/document/revision.js'

describe('computeRevision', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rev-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('返回 sha256: 前缀的 64 位 hex', () => {
    const f = join(dir, 'a.md')
    writeFileSync(f, 'hello')
    expect(computeRevision(f)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('相同内容 → 相同 revision', () => {
    const a = join(dir, 'a.md')
    const b = join(dir, 'b.md')
    writeFileSync(a, 'same')
    writeFileSync(b, 'same')
    expect(computeRevision(a)).toBe(computeRevision(b))
  })

  it('不同内容 → 不同 revision', () => {
    const f = join(dir, 'a.md')
    writeFileSync(f, 'x')
    const r1 = computeRevision(f)
    writeFileSync(f, 'y')
    const r2 = computeRevision(f)
    expect(r1).not.toBe(r2)
  })

  it('匹配已知 SHA-256 向量', () => {
    const f = join(dir, 'vec.md')
    writeFileSync(f, 'hello')
    // echo -n hello | sha256sum
    expect(computeRevision(f)).toBe('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })
})
