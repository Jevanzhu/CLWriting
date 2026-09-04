/**
 * R44-9（四十四轮）回归：version-stats 探针 TTL 节流 + MISS 计算体分批让出。
 *
 * ①探针节流：versionStatsProbe 原在 TTL 判断之前每次执行——缓存命中也重付
 * readdirSync + 逐 doc statSync（前端 3s 轮询每 poll 照付）。修复后探针结果 TTL 窗
 * 内复用：命中路径零系统调用；TTL 一到必须重新探（指纹时效语义收敛点：TTL 窗内的
 * 目录结构变化从「下次调用即时可见」变为「TTL 到期重探后可见（≤5s）」，记档见
 * api/snapshots.ts R44-9 头注）。
 * ②MISS 分批让出：scanVersionsDir 递归 lstat + 逐快照 .md 同步读判 pinned 改异步
 * 每 25 条让出（R37-3 范式）——扫描期间事件循环可响应。
 *
 * 断言用观测口（__versionStatsProbeCountForTest / SigCount / ScanCount），确定性
 * 不依赖墙钟 5s（先例 r36/r37）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getVersionStatsCached,
  __setVersionStatsTtlForTest,
  __versionStatsScanCountForTest,
  __resetVersionStatsScanCountForTest,
  __versionStatsSigCountForTest,
  __resetVersionStatsSigCountForTest,
  __versionStatsProbeCountForTest,
  __resetVersionStatsProbeCountForTest,
} from '../../src/studio/server/api/snapshots.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let roots: string[] = []

/** 建书：1 个 pinned 定稿快照 + manifest 登记 doc_1 且 finalizedRevision 非空。 */
function makeBook(docCount = 1): string {
  const root = mkdtempSync(join(tmpdir(), 'r44-vs-probe-'))
  roots.push(root)
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  for (let i = 1; i <= docCount; i++) {
    const vdir = join(root, '工作区', '.版本', `doc_${i}`)
    mkdirSync(vdir, { recursive: true })
    const pinned = i === 1
    writeFileSync(
      join(vdir, 'a.md'),
      pinned ? '---\n来源: manual\n永久: true\n---\n定稿内容\n' : '---\n来源: manual\n---\n普通内容\n',
      'utf-8',
    )
    upsertEntry(m, { id: `doc_${i}`, nodeType: 'document', path: `写作/正文/000${i}-章${i}.md`, parentId: null })
  }
  const e = m.entries.get('doc_1')!
  e.finalizedRevision = 'sha256:' + 'a'.repeat(64)
  writeManifest(manifestPath, m)
  return root
}

afterEach(() => {
  __setVersionStatsTtlForTest(null)
  __resetVersionStatsScanCountForTest()
  __resetVersionStatsSigCountForTest()
  __resetVersionStatsProbeCountForTest()
  for (const r of roots) rmSync(r, { recursive: true, force: true })
  roots = []
})

describe('R44-9 ① 探针 TTL 节流', () => {
  it('TTL 内二次请求：探针/全量签名/重算计数均不再增长（命中零系统调用）', async () => {
    const root = makeBook()
    __setVersionStatsTtlForTest(60_000)
    const r1 = await getVersionStatsCached(root)
    expect(__versionStatsProbeCountForTest()).toBe(1)
    expect(__versionStatsSigCountForTest()).toBe(1)
    expect(__versionStatsScanCountForTest()).toBe(1)
    expect(r1.snapshotCount).toBe(1)
    const r2 = await getVersionStatsCached(root)
    // R44-9 核心断言：命中不再重付 readdir+逐 doc statSync（探针计数不增长），
    // 也不触发全量签名/重算
    expect(__versionStatsProbeCountForTest()).toBe(1)
    expect(__versionStatsSigCountForTest()).toBe(1)
    expect(__versionStatsScanCountForTest()).toBe(1)
    expect(r2).toEqual(r1)
  })

  it('TTL 过期后重探：探针计数增长；TTL 窗内不可见的变化经重探重算见新值', async () => {
    const root = makeBook()
    __setVersionStatsTtlForTest(60_000)
    const before = await getVersionStatsCached(root)
    expect(before.snapshotCount).toBe(1)
    await sleep(5)
    writeFileSync(join(root, '工作区', '.版本', 'doc_1', 'b.md'), '---\n来源: manual\n---\n后续内容\n', 'utf-8')
    // TTL 窗内：探针节流命中（不重探不重算）
    const throttled = await getVersionStatsCached(root)
    expect(__versionStatsProbeCountForTest()).toBe(1)
    expect(throttled).toEqual(before)
    // TTL 过期 → 必须重新探（探针计数 +1）→ 指纹失配 → 全量签名 → 重算见新值
    __setVersionStatsTtlForTest(0)
    const after = await getVersionStatsCached(root)
    expect(__versionStatsProbeCountForTest()).toBe(2)
    expect(__versionStatsSigCountForTest()).toBe(2)
    expect(__versionStatsScanCountForTest()).toBe(2)
    expect(after.snapshotCount).toBe(2)
  })
})

describe('R44-9 ② MISS 计算体分批让出', () => {
  it('多 doc 目录扫描期间事件循环可响应：setImmediate 心跳至少插队一次', async () => {
    const root = makeBook(60) // 60 doc 目录 × 各 1 快照 .md → walk 120 条，每 25 条让出
    __setVersionStatsTtlForTest(60_000)
    let beats = 0
    const probe = (): void => {
      if (beats < 256) {
        beats++
        setImmediate(probe)
      }
    }
    const p = getVersionStatsCached(root)
    setImmediate(probe)
    const r = await p
    expect(r.snapshotCount).toBe(60)
    expect(r.pinnedCount).toBe(1)
    expect(beats).toBeGreaterThan(0) // 「至少一次」：不脆断言次数（r37-scan-async-twins 同款）
    expect(__versionStatsScanCountForTest()).toBe(1)
  })
})
