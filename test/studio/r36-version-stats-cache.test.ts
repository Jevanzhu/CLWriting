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
 *
 * R44-9（四十四轮）适配：versionStatsProbe 纳入 TTL 节流（缓存命中不再重付
 * readdir+逐 doc statSync）——TTL 窗内的目录结构变化从「下次调用即时失效」收敛为
 * 「TTL 到期重探后失效（≤5s）」，与就地内容改写的既有兜底窗口一致（记档见
 * api/snapshots.ts R44-9 头注）；forgetVersionStatsCache 显式失效不受节流影响。
 * getVersionStatsCached 同步转 async（MISS 计算体分批让出），调用点补 await。
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
    const r1 = await getVersionStatsCached(root)
    expect(__versionStatsScanCountForTest()).toBe(1)
    expect(r1).toEqual({ snapshotBytes: expect.any(Number), snapshotCount: 1, pinnedCount: 1, finalizedDocs: 1 })
    const r2 = await getVersionStatsCached(root)
    expect(__versionStatsScanCountForTest()).toBe(1) // 命中：未重算
    expect(r2).toEqual(r1)
  })

  it('新增快照文件（写进既有 doc 目录）：TTL 窗内探针节流命中旧值；TTL 到期重探重算见新值', async () => {
    const root = makeBook()
    __setVersionStatsTtlForTest(60_000)
    const before = await getVersionStatsCached(root)
    expect(before.snapshotCount).toBe(1)
    await sleep(5)
    writeFileSync(
      join(root, '工作区', '.版本', 'doc_1', 'b.md'),
      '---\n来源: manual\n---\n后续内容\n',
      'utf-8',
    )
    // R44-9：探针纳入 TTL 节流——窗内命中不重扫（即时失效收敛为 ≤TTL 窗，头注记档）
    const throttled = await getVersionStatsCached(root)
    expect(__versionStatsScanCountForTest()).toBe(1)
    expect(throttled).toEqual(before)
    // TTL 到期 → 必须重新探 → 指纹失配（doc_1 目录 mtime 变）→ 全量签名 → 重算
    __setVersionStatsTtlForTest(0)
    const after = await getVersionStatsCached(root)
    expect(__versionStatsScanCountForTest()).toBe(2)
    expect(after.snapshotCount).toBe(2)
    expect(after.pinnedCount).toBe(1) // 新文件非 pinned，pinned 计数不变
  })

  it('目录结构变化（新 doc 目录）：TTL 窗内节流命中；TTL 到期重探失效；forget 显式失效同效', async () => {
    const root = makeBook()
    __setVersionStatsTtlForTest(60_000)
    await getVersionStatsCached(root)
    expect(__versionStatsScanCountForTest()).toBe(1)
    await sleep(5)
    mkdirSync(join(root, '工作区', '.版本', 'doc_2'), { recursive: true })
    writeFileSync(join(root, '工作区', '.版本', 'doc_2', 'c.md'), '---\n来源: manual\n---\n丙\n', 'utf-8')
    // R44-9：TTL 窗内探针节流命中（不重扫）
    await getVersionStatsCached(root)
    expect(__versionStatsScanCountForTest()).toBe(1)
    // TTL 到期 → 重探 → 顶层 .版本 目录 mtime 变 → 重算
    __setVersionStatsTtlForTest(0)
    const fresh = await getVersionStatsCached(root)
    expect(__versionStatsScanCountForTest()).toBe(2)
    expect(fresh.snapshotCount).toBe(2)
    // forget 显式失效挂点同效（不走探针，不受节流影响）
    __setVersionStatsTtlForTest(60_000)
    forgetVersionStatsCache(root)
    await getVersionStatsCached(root)
    expect(__versionStatsScanCountForTest()).toBe(3)
  })

  it('TTL 到期重算：探针无变化也按超期重算（注入 TTL=0）', async () => {
    const root = makeBook()
    await getVersionStatsCached(root)
    expect(__versionStatsScanCountForTest()).toBe(1)
    __setVersionStatsTtlForTest(0) // 即刻过期
    await getVersionStatsCached(root)
    expect(__versionStatsScanCountForTest()).toBe(2)
    __setVersionStatsTtlForTest(60_000)
    await getVersionStatsCached(root)
    expect(__versionStatsScanCountForTest()).toBe(2) // 恢复长档后命中缓存
  })
})