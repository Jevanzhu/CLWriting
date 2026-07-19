import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeSnapshot, listSnapshots } from '../../src/document/snapshot.js'

describe('snapshot', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'snap-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writeSnapshot 建文件 + 返回 ULID id', () => {
    const id = writeSnapshot(dir, 'doc_1', '正文内容', { origin: 'manual' })
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    const f = join(dir, 'doc_1', `${id}.md`)
    expect(existsSync(f)).toBe(true)
    const text = readFileSync(f, 'utf-8')
    expect(text).toContain('正文内容')
    expect(text).toContain('来源: manual')
  })

  it('writeSnapshot 带 reason/baseRevision 写入 front matter', () => {
    const id = writeSnapshot(dir, 'doc_1', 'x', {
      origin: 'autosave',
      reason: '冲突覆盖前',
      baseRevision: 'sha256:abc',
    })
    const text = readFileSync(join(dir, 'doc_1', `${id}.md`), 'utf-8')
    expect(text).toContain('原因: 冲突覆盖前')
    expect(text).toContain('基线: sha256:abc')
  })

  it('listSnapshots 降序（新在前）', async () => {
    writeSnapshot(dir, 'doc_1', 'a', { origin: 'x' })
    await new Promise((r) => setTimeout(r, 2))
    const id2 = writeSnapshot(dir, 'doc_1', 'b', { origin: 'x' })
    const list = listSnapshots(dir, 'doc_1')
    expect(list).toHaveLength(2)
    expect(list[0]!.id).toBe(id2)
  })

  it('无快照 → 空', () => {
    expect(listSnapshots(dir, 'doc_无')).toHaveLength(0)
  })
})
