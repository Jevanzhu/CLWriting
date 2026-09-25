/**
 * R34D-4（三十四轮）回归：清单写前 `.bak` 影子。
 *
 * 缺陷面：清单「在册可读但零条可解析」被读侧当合法空集（三防线 fail-open），且坏清单
 * 的下次写会把空表物理落盘永久化——修后在 writeManifest 替换前把旧内容原子写一份
 * `文档清单.jsonl.bak`（best-effort，失败不阻断主写，已有 .bak 覆盖），外部把清单搞坏后
 * 总有上一份好内容可恢复。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { readManifest, writeManifest, upsertEntry, type Manifest } from '../../src/document/manifest.js'

describe('writeManifest .bak 影子（R34D-4）', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempTracked(join(tmpdir(), 'r34d-bak-'))
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

// ── R43-6（四十三轮）：.bak 影子写不关 fsync ─────────────────────────────

/** fsync 观测装置：记录 fd→打开路径，并在 fsync 当刻把路径快照进 fsyncPaths。
 *  路径须在调用当刻解析——fd 号会被后续 open 复用（close 后 dir 的 open 可能拿到同一号）。 */
const AT = vi.hoisted(() => ({ fdPath: new Map<number, string>(), fsyncPaths: [] as string[] }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    openSync: ((p: string, ...rest: unknown[]) => {
      const fd = (actual.openSync as (...a: unknown[]) => number)(p, ...rest)
      AT.fdPath.set(fd, String(p))
      return fd
    }) as typeof actual.openSync,
    fsyncSync: ((fd: number) => {
      AT.fsyncPaths.push(AT.fdPath.get(fd) ?? `<未知 fd ${fd}>`)
      return actual.fsyncSync(fd)
    }) as typeof actual.fsyncSync,
  }
})

describe('R43-6: .bak 影子写 fsync 口径（兜底恢复源不掉电失守）', () => {
  it('.bak 影子写实际执行 fsync（掉电后恢复源仍可信）', () => {
    const dir = mkdtempTracked(join(tmpdir(), 'r43-6-bak-fsync-'))
    try {
      const f = join(dir, '清单.jsonl')
      writeFileSync(f, '{"version":1,"type":"header"}\n', 'utf-8')
      AT.fdPath.clear()
      AT.fsyncPaths.length = 0
      const m = { version: 1, entries: new Map() }
      upsertEntry(m, {
        id: 'doc_1',
        nodeType: 'document',
        path: 'a.md',
        parentId: null,
      } as Manifest['entries'] extends Map<string, infer V> ? V : never)
      writeManifest(f, m)
      // .bak 影子写的 tmp 必须走到 fsyncSync——该调用点若重回 { fsync: false }，
      // 全程不会出现任何 .bak 路径的 fsync，本臂即红。
      expect(AT.fsyncPaths.some((p) => p.includes('.bak')), `未观测到 .bak 的 fsync；实际 fsync 路径：${AT.fsyncPaths.join(', ')}`).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
