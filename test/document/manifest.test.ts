import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readManifest, writeManifest, upsertEntry, removeEntry } from '../../src/document/manifest.js'

describe('manifest', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'manifest-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('读不存在的清单 → 空清单 version 1', () => {
    const m = readManifest(join(dir, '无.jsonl'))
    expect(m.version).toBe(1)
    expect(m.entries.size).toBe(0)
  })

  it('写 + 读 往返一致', () => {
    const f = join(dir, '清单.jsonl')
    const entries = new Map([
      ['doc_1', { id: 'doc_1', nodeType: 'document' as const, path: 'a.md', parentId: null, status: 'draft', tags: ['x'] }],
    ])
    writeManifest(f, { version: 1, entries })
    const r = readManifest(f)
    expect(r.version).toBe(1)
    expect(r.entries.get('doc_1')?.path).toBe('a.md')
    expect(r.entries.get('doc_1')?.status).toBe('draft')
    expect(r.entries.get('doc_1')?.tags).toEqual(['x'])
  })

  it('幂等合并：同 id 后写覆盖', () => {
    const entries = new Map()
    const m = { version: 1, entries }
    upsertEntry(m, { id: 'doc_1', nodeType: 'document', path: 'old.md', parentId: null })
    upsertEntry(m, { id: 'doc_1', nodeType: 'document', path: 'new.md', parentId: null })
    expect(m.entries.size).toBe(1)
    expect(m.entries.get('doc_1')?.path).toBe('new.md')
  })

  it('removeEntry 按 id 删除', () => {
    const m = { version: 1, entries: new Map() }
    upsertEntry(m, { id: 'doc_1', nodeType: 'document', path: 'a.md', parentId: null })
    expect(removeEntry(m, 'doc_1')).toBe(true)
    expect(removeEntry(m, 'doc_1')).toBe(false)
  })

  it('非法行跳过降级，只留合法条目', () => {
    const f = join(dir, '清单.jsonl')
    writeFileSync(
      f,
      [
        '{"version":1,"type":"header"}',
        '非法行',
        '{"id":"doc_1","nodeType":"document","path":"a.md","parentId":null}',
        '{bad json',
        '{"id":"doc_2","nodeType":"unknown","path":"b.md"}', // nodeType 非法
      ].join('\n'),
    )
    const m = readManifest(f)
    expect(m.version).toBe(1)
    expect(m.entries.size).toBe(1)
    expect(m.entries.get('doc_1')?.path).toBe('a.md')
  })

  it('章行省略 order（编号派生顺序）', () => {
    const f = join(dir, '清单.jsonl')
    writeFileSync(
      f,
      '{"id":"doc_1","nodeType":"document","path":"定稿/正文/0001-开篇.md","parentId":null,"status":"final"}\n',
    )
    const m = readManifest(f)
    expect(m.entries.get('doc_1')?.order).toBeUndefined()
  })

  it('自由区文档保留 order', () => {
    const f = join(dir, '清单.jsonl')
    writeFileSync(f, '{"id":"doc_1","nodeType":"document","path":"素材/x.md","parentId":null,"order":5}\n')
    const m = readManifest(f)
    expect(m.entries.get('doc_1')?.order).toBe(5)
  })

  it('folder 条目无 status', () => {
    const f = join(dir, '清单.jsonl')
    writeFileSync(f, '{"id":"folder_1","nodeType":"folder","path":"大纲","parentId":null,"order":20}\n')
    const m = readManifest(f)
    const e = m.entries.get('folder_1')
    expect(e?.nodeType).toBe('folder')
    expect(e?.order).toBe(20)
    expect(e?.status).toBeUndefined()
  })
})
