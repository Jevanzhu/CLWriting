/**
 * R0912-E-P3-1（2026-09-12 独立重评修复批）回归：trash 清单 readTrashManifestStrict
 * 单槽 stat(size:mtimeNs) 指纹缓存。
 *
 * - 连续两次读同文件只读盘一次（readFileSync 计数注入）；
 * - 写侧（appendTrashEntryAsync）后缓存失效重读；
 * - 他进程绕开写侧直接改写文件（mtime/size 变化）→ 失效重读，executeSave 锁内
 *   复核依赖「读到最新数据」的语义保真（service.ts 双调用点）；
 * - 缓存主本不外借：调用方 mutate 返回数组不污染缓存。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// actual 经 hoisted 容器带出——readFileSync 计数注入（version-prune 系同款 vi.mock 手法）
const actualFs = vi.hoisted(() => ({
  readFileSync: undefined as unknown as typeof import('node:fs').readFileSync,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  actualFs.readFileSync = actual.readFileSync
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

import { readFileSync as readFileSyncMocked } from 'node:fs'
import { appendTrashEntryAsync, readTrashManifestStrict, type TrashEntry } from '../../src/document/trash.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

function entryOf(id: string): TrashEntry {
  return {
    id,
    originalPath: `写作/正文/${id}.md`,
    trashedPath: `工作区/.trash/${id}-旧.md`,
    trashedAt: '2026-09-12T00:00:00.000Z',
    role: 'chapter',
    tags: ['标签-' + id],
  }
}

let root: string
let manifestPath: string

beforeEach(() => {
  root = mkdtempTracked(join(tmpdir(), 'r0912-trash-cache-'))
  manifestPath = join(root, '工作区', '.trash', '.trash-manifest.jsonl')
  mkdirSync(join(root, '工作区', '.trash'), { recursive: true })
})

afterEach(() => {
  vi.mocked(readFileSyncMocked).mockReset()
  vi.mocked(readFileSyncMocked).mockImplementation((...args) => actualFs.readFileSync(...args))
  rmSync(root, { recursive: true, force: true })
})

/** 对 trash manifest 路径的 readFileSync 调用计数（缓存效果观测量） */
function manifestReadCalls(): number {
  return vi
    .mocked(readFileSyncMocked)
    .mock.calls.filter(([p]) => String(p).endsWith('.trash-manifest.jsonl')).length
}

describe('R0912-E-P3-1: trash 清单单槽指纹缓存', () => {
  it('连续两次读同文件只读盘一次；两次结果内容一致', () => {
    writeFileSync(manifestPath, JSON.stringify(entryOf('doc_a')) + '\n', 'utf-8')
    const first = readTrashManifestStrict(root)
    expect(first).toHaveLength(1)
    const callsAfterFirst = manifestReadCalls()
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1)
    const second = readTrashManifestStrict(root)
    expect(manifestReadCalls()).toBe(callsAfterFirst) // 第二次零读盘（指纹命中）
    expect(second).toEqual(first)
  })

  it('缓存主本不外借：mutate 返回数组不污染缓存', () => {
    writeFileSync(manifestPath, JSON.stringify(entryOf('doc_a')) + '\n', 'utf-8')
    const first = readTrashManifestStrict(root)
    first.push(entryOf('doc_injected')) // RMW 调用方原位改写形态（appendTrashEntry 同款）
    const second = readTrashManifestStrict(root)
    expect(second).toHaveLength(1)
    expect(second[0]!.id).toBe('doc_a')
  })

  it('写侧 appendTrashEntryAsync 后缓存失效重读（读到新条目）', () => {
    writeFileSync(manifestPath, JSON.stringify(entryOf('doc_a')) + '\n', 'utf-8')
    expect(readTrashManifestStrict(root)).toHaveLength(1)
    const before = manifestReadCalls()
    return appendTrashEntryAsync(root, entryOf('doc_b')).then(() => {
      const after = readTrashManifestStrict(root)
      expect(after.map((e) => e.id).sort()).toEqual(['doc_a', 'doc_b'])
      expect(manifestReadCalls()).toBeGreaterThan(before) // 失效后重读了盘
    })
  })

  it('他进程绕开写侧直接改写文件（mtime/size 变化）→ 失效重读取到最新数据', () => {
    writeFileSync(manifestPath, JSON.stringify(entryOf('doc_a')) + '\n', 'utf-8')
    expect(readTrashManifestStrict(root)).toHaveLength(1)
    // 模拟他进程改写（不经本进程 writeTrashManifest，缓存只靠指纹失效兜住）
    writeFileSync(manifestPath, JSON.stringify(entryOf('doc_external')) + '\n', 'utf-8')
    const after = readTrashManifestStrict(root)
    expect(after).toHaveLength(1)
    expect(after[0]!.id).toBe('doc_external')
  })
})
