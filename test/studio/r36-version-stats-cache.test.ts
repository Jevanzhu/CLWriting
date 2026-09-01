/**
 * R36-7（三十六轮）回归：version-stats 全书快照统计 mtime 探针 + 5s TTL 缓存。
 *
 * 端点原每请求全量同步读（.版本 递归遍历 + 逐文件 fm 读 + parse + manifest 整读），
 * 进页/轮询/刷新反复触发；R36-7 对齐 search.ts R35-7（mtime 探针 + TTL）加缓存壳：
 * 命中即跳过逐文件 fm 读与 manifest 整读（只做递归元数据 stat）。失效语义（方案偏离
 * 记档见 api/snapshots.ts）：
 * - 递归 mtime/size 探针即时失效——新增/删除/重写快照、manifest 基线变化下次调用
 *   立即重算（既有 R-15 直写盘后立即 GET 断言新鲜度的测试不退化）；
 * - TTL 5s 兜底探针不可见的变化；
 * - forgetVersionStatsCache 为写侧显式失效挂点（prune/restore 落盘后调用）。
 *
 * 断言用「全量重算计数」观测口（__versionStatsScanCountForTest），确定性不依赖墙钟 5s。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getVersionStatsCached,
  forgetVersionStatsCache,
  __setVersionStatsTtlForTest,
  __versionStatsScanCountForTest,
  __resetVersionStatsScanCountForTest,
} from '../../src/studio/server/api/snapshots.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let roots: string[] = []

/** 建书：1 个 pinned 定稿快照 + manifest 登记 doc_1 且 finalizedRevision 非空。 */
function makeBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'r36-vs-cache-'))
  roots.push(root)
  const vdir = join(root, '工作区', '.版本', 'doc_1')
  mkdirSync(vdir, { recursive: true })
  writeFileSync(join(vdir, 'a.md'), '---\n来源: manual\n永久: true\n---\n定稿内容\n', 'utf-8')
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  upsertEntry(m, { id: 'doc_1', nodeType: 'document', path: '写作/正文/0001-雨夜.md', parentId: null })
  const e = m.entries.get('doc_1')!
  e.finalizedRevision = 'sha256:' + 'a'.repeat(64)
  writeManifest(manifestPath, m)
  return root
}

afterEach(() => {
  __setVersionStatsTtlForTest(null)
  __resetVersionStatsScanCountForTest()
  for (const r of roots) rmSync(r, { recursive: true, force: true })
  roots = []
})

describe('R36-7 version-stats 缓存', () => {
  it('连续两次请求：第二次缓存命中不重算（scan 计数不变），结果一致', async () => {
    const root = makeBook()
    __setVersionStatsTtlForTest(60_000)
    const r1 = getVersionStatsCached(root)
    expect(__versionStatsScanCountForTest()).toBe(1)
    expect(r1).toEqual({ snapshotBytes: expect.any(Number), snapshotCount: 1, pinnedCount: 1, finalizedDocs: 1 })
    const r2 = getVersionStatsCached(root)
    expect(__versionStatsScanCountForTest()).toBe(1) // 命中：未重算
    expect(r2).toEqual(r1)
  })

  it('新增快照文件（写进既有 doc 目录）→ 递归探针即时失效重算，count 增大', async () => {
    const root = makeBook()
    __setVersionStatsTtlForTest(60_000)
    const before = getVersionStatsCached(root)
    expect(before.snapshotCount).toBe(1)
    await sleep(5)
    writeFileSync(
      join(root, '工作区', '.版本', 'doc_1', 'b.md'),
      '---\n来源: manual\n---\n后续内容\n',
      'utf-8',
    )
    const after = getVersionStatsCached(root)
    expect(__versionStatsScanCountForTest()).toBe(2) // 探针失配 → 重算
    expect(after.snapshotCount).toBe(2)
    expect(after.pinnedCount).toBe(1) // 新文件非 pinned，pinned 计数不变
  })

  it('目录结构变化（新 doc 目录）→ 探针即时失效；forget 同效', async () => {
    const root = makeBook()
    __setVersionStatsTtlForTest(60_000)
    getVersionStatsCached(root)
    expect(__versionStatsScanCountForTest()).toBe(1)
    await sleep(5)
    mkdirSync(join(root, '工作区', '.版本', 'doc_2'), { recursive: true })
    writeFileSync(join(root, '工作区', '.版本', 'doc_2', 'c.md'), '---\n来源: manual\n---\n丙\n', 'utf-8')
    getVersionStatsCached(root)
    expect(__versionStatsScanCountForTest()).toBe(2)
    // forget 显式失效挂点同效
    forgetVersionStatsCache(root)
    getVersionStatsCached(root)
    expect(__versionStatsScanCountForTest()).toBe(3)
  })

  it('TTL 到期重算：探针无变化也按超期重算（注入 TTL=0）', async () => {
    const root = makeBook()
    getVersionStatsCached(root)
    expect(__versionStatsScanCountForTest()).toBe(1)
    __setVersionStatsTtlForTest(0) // 即刻过期
    getVersionStatsCached(root)
    expect(__versionStatsScanCountForTest()).toBe(2)
    __setVersionStatsTtlForTest(60_000)
    getVersionStatsCached(root)
    expect(__versionStatsScanCountForTest()).toBe(2) // 恢复长档后命中缓存
  })
})