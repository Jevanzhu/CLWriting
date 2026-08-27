/**
 * R66-19（十四轮）：writeVersion/pruneVersions 的 meta 判定走 readVersionMeta 头部读回归。
 *
 * 此前三处（节流扫描/去重扫描/prune 的 pinned 判定）用整读 readVersion 只为拿
 * origin/pinned 元信息——长书高频 autosave 留底每次触发多次全文读。修复后跨
 * origin 版本零整读、同 origin 内容比对整读一次、prune 判 pinned 零整读。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 计数 mock：只统计版本目录内文件的 readFileSync 整读（readVersionMeta 走
// openSync/readSync 头部读，不经 readFileSync——计数值即「全文整读次数」）
const READS = vi.hoisted(() => ({ dir: '', count: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: ((p, ...rest) => {
      if (typeof p === 'string' && READS.dir !== '' && p.startsWith(READS.dir)) READS.count++
      return (actual.readFileSync as typeof readFileSync)(p, ...rest)
    }) as typeof readFileSync,
  }
})

import {
  writeVersion,
  pruneVersions,
  listVersions,
  readVersion,
  DEFAULT_VERSION_POLICY,
} from '../../src/document/version.js'

let dir: string
const docId = 'doc_r66_19'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clw-r66-19-'))
  READS.dir = dir
  READS.count = 0
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  READS.dir = ''
})

describe('R66-19: version meta 判定走头部读（整读次数收敛）', () => {
  it('去重扫描：跨 origin 版本零整读，仅最新同 origin 版本整读一次做内容比对', () => {
    // 混排版本（新→旧）：ai / manual / ai，内容互不相同
    writeVersion(dir, docId, 'AI 旧内容', { origin: 'ai' })
    writeVersion(dir, docId, '手动留底内容', { origin: 'manual' })
    writeVersion(dir, docId, 'AI 新内容', { origin: 'ai' })
    expect(listVersions(dir, docId).length).toBe(3)

    READS.count = 0
    const id = writeVersion(dir, docId, '手动新内容（与留底不同）', { origin: 'manual' })
    expect(id).not.toBeNull() // 无同内容 → 落新版本（去重不误吞）
    // 2 个跨 origin 的 ai 版本不整读；最新同 origin（manual）整读 1 次做内容比对
    expect(READS.count).toBe(1)
  })

  it('去重命中：与最新同 origin 同内容 → 跳过落盘（去重语义不回退）', () => {
    writeVersion(dir, docId, '稳定内容', { origin: 'manual' })
    READS.count = 0
    const dup = writeVersion(dir, docId, '稳定内容', { origin: 'manual' })
    expect(dup).toBeNull()
    expect(listVersions(dir, docId).length).toBe(1)
  })

  it('节流扫描：origin 过滤零整读（窗口内同 origin → 节流跳过）', () => {
    writeVersion(dir, docId, '内容A', { origin: 'autosave' })
    writeVersion(dir, docId, '内容B', { origin: 'ai' }) // 干扰项：更新但不同 origin
    READS.count = 0
    const r = writeVersion(dir, docId, '内容C', { origin: 'autosave' }, { force: false })
    expect(r).toBeNull() // 窗口内已有同 origin（autosave）版本 → 节流
    expect(READS.count).toBe(0) // origin 判定全走 meta 头部读，零整读
  })

  it('pruneVersions：pinned 判定零整读；pinned 超期保留、非 pinned 超期清除', () => {
    const pinnedId = writeVersion(dir, docId, '定稿内容', { origin: 'finalize', pinned: true })
    writeVersion(dir, docId, '草稿1', { origin: 'autosave' })
    writeVersion(dir, docId, '草稿2', { origin: 'autosave' })
    READS.count = 0
    const removed = pruneVersions(dir, docId, DEFAULT_VERSION_POLICY, Date.now() + 100 * 24 * 3600 * 1000)
    expect(removed).toBe(2) // 两个非 pinned 超期删除
    expect(READS.count).toBe(0) // pinned 判定走 meta 头读，零整读
    expect(readVersion(dir, docId, pinnedId!)?.meta.pinned).toBe(true)
    expect(listVersions(dir, docId).length).toBe(1)
  })
})
