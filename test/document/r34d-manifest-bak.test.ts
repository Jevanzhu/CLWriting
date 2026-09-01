/**
 * R34D-4（三十四轮）回归：清单写前 `.bak` 影子。
 *
 * 缺陷面：清单「在册可读但零条可解析」被读侧当合法空集（三防线 fail-open），且坏清单
 * 的下次写会把空表物理落盘永久化——修后在 writeManifest 替换前把旧内容原子写一份
 * `文档清单.jsonl.bak`（best-effort，失败不阻断主写，已有 .bak 覆盖），外部把清单搞坏后
 * 总有上一份好内容可恢复。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readManifest, writeManifest, upsertEntry, type Manifest } from '../../src/document/manifest.js'

describe('writeManifest .bak 影子（R34D-4）', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'r34d-bak-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function makeEntry(id: string, path: string): Manifest['entries'] extends Map<string, infer V> ? V : never {
    return { id, nodeType: 'document', path, parentId: null }
  }

  it('首次写（无旧文件）→ 不产 .bak，主文件正常', () => {
    const f = join(dir, '清单.jsonl')
    const m = { version: 1, entries: new Map() }
    upsertEntry(m, makeEntry('doc_1', 'a.md'))
    writeManifest(f, m)
    expect(existsSync(`${f}.bak`)).toBe(false)
    expect(readManifest(f).entries.get('doc_1')?.path).toBe('a.md')
  })

  it('覆盖写 → .bak 保存被替换的旧内容（字节级，坏行也留底）', () => {
    const f = join(dir, '清单.jsonl')
    // 旧内容含非法行（模拟外部搞坏的清单被覆盖前留底最全口径）
    const oldRaw = '{"version":1,"type":"header"}\n半截坏行无换行'
    writeFileSync(f, oldRaw, 'utf-8')
    const m = { version: 1, entries: new Map() }
    upsertEntry(m, makeEntry('doc_2', 'b.md'))
    writeManifest(f, m)
    // 主写成功
    expect(readManifest(f).entries.get('doc_2')?.path).toBe('b.md')
    // .bak = 被替换前的旧内容（字节一致）
    expect(existsSync(`${f}.bak`)).toBe(true)
    expect(readFileSync(`${f}.bak`, 'utf-8')).toBe(oldRaw)
  })

  it('已有 .bak → 下次写覆盖之（恒为上一份，不堆积）', () => {
    const f = join(dir, '清单.jsonl')
    const m1 = { version: 1, entries: new Map() }
    upsertEntry(m1, makeEntry('doc_1', 'a.md'))
    writeManifest(f, m1) // 第一代
    const m2 = { version: 1, entries: new Map() }
    upsertEntry(m2, makeEntry('doc_2', 'b.md'))
    writeManifest(f, m2) // 第二代：.bak 应为第一代内容
    const bak = readFileSync(`${f}.bak`, 'utf-8')
    expect(bak).toContain('doc_1')
    expect(bak).not.toContain('doc_2')
    // 再写第三代：.bak 变第二代
    const m3 = { version: 1, entries: new Map() }
    upsertEntry(m3, makeEntry('doc_3', 'c.md'))
    writeManifest(f, m3)
    const bak2 = readFileSync(`${f}.bak`, 'utf-8')
    expect(bak2).toContain('doc_2')
    expect(bak2).not.toContain('doc_3')
  })

  it('.bak 写失败（占位为目录）→ 不阻断主写（best-effort）', () => {
    const f = join(dir, '清单.jsonl')
    writeFileSync(f, '{"version":1,"type":"header"}\n', 'utf-8')
    mkdirSync(`${f}.bak`) // .bak 占位为目录 → 影子写必败
    const m = { version: 1, entries: new Map() }
    upsertEntry(m, makeEntry('doc_9', 'i.md'))
    expect(() => writeManifest(f, m)).not.toThrow()
    expect(readManifest(f).entries.get('doc_9')?.path).toBe('i.md')
  })
})
