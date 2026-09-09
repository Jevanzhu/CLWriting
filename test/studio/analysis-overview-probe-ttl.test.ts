/**
 * 重评2-P3-④（2026-09-09 全量重评 GLM-5.3）回归：analysis-overview 探针 TTL 节流。
 *
 * 修复前：analysisOverviewProbe 在 TTL 判断之前每次执行——缓存命中也重付
 * manifest+分析目录两个 statSync（前端 3s 轮询每 poll 照付）；R44-9① 当年只给
 * version-stats 侧加了 probeTs 节流（snapshots.ts），analysis 侧漏配（两探缓存
 * 不对称，r37-signature-probe 头注自认「分析侧未节流，行为不变」）。修复后照
 * snapshots 版搭法补齐：探针结果 TTL 窗内复用，命中路径零系统调用；TTL 一到
 * 必须重新探（指纹时效语义与 R44-9① 记档一致：TTL 窗内的 rename 类信封变化
 * 从「下次调用即时可见」变为「TTL 到期重探后可见（≤5s）」）。
 *
 * 断言用观测口（__analysisOverviewProbeCountForTest / SigCount / ScanCount），
 * 确定性不依赖墙钟 5s（先例 r44-versionstats-probe-ttl 同款）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getAnalysisOverviewCached,
  __setAnalysisOverviewTtlForTest,
  __analysisOverviewScanCountForTest,
  __resetAnalysisOverviewScanCountForTest,
  __analysisOverviewSigCountForTest,
  __resetAnalysisOverviewSigCountForTest,
  __analysisOverviewProbeCountForTest,
  __resetAnalysisOverviewProbeCountForTest,
} from '../../src/studio/server/api/analysis.js'
import { writeAnalysis, type Envelope } from '../../src/document/analysis.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let roots: string[] = []

function envOf(payload: unknown): Envelope {
  return { generatedAt: new Date().toISOString(), model: 'mock', sourceHash: '0'.repeat(64), payload }
}

/** 建书：manifest 登记 doc_1 + score 信封（口径同 r37-signature-probe makeAnalysisBook）。 */
function makeAnalysisBook(): { root: string; docId1: string } {
  const root = mkdtempSync(join(tmpdir(), 're2-ao-probe-'))
  roots.push(root)
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  const docId1 = generateDocId()
  upsertEntry(m, { id: docId1, nodeType: 'document', path: '写作/正文/0001-雨夜.md', parentId: null })
  writeManifest(manifestPath, m)
  writeAnalysis(root, docId1, 'score', envOf({ score: 8, dims: { 爽点: 8 } }))
  return { root, docId1 }
}

afterEach(() => {
  __setAnalysisOverviewTtlForTest(null)
  __resetAnalysisOverviewScanCountForTest()
  __resetAnalysisOverviewSigCountForTest()
  __resetAnalysisOverviewProbeCountForTest()
  for (const r of roots) rmSync(r, { recursive: true, force: true })
  roots = []
})

describe('重评2-P3-④ analysis-overview 探针 TTL 节流', () => {
  it('TTL 内二次请求（3s 轮询场景）：探针/全量签名/重算计数均不再增长（命中零系统调用）', async () => {
    const { root } = makeAnalysisBook()
    __setAnalysisOverviewTtlForTest(60_000)
    const r1 = await getAnalysisOverviewCached(root)
    expect(__analysisOverviewProbeCountForTest()).toBe(1)
    expect(__analysisOverviewSigCountForTest()).toBe(1)
    expect(__analysisOverviewScanCountForTest()).toBe(1)
    expect(r1.scoreTrend).toHaveLength(1)
    const r2 = await getAnalysisOverviewCached(root)
    // 重评2-P3-④ 核心断言：命中不再重付 manifest+分析目录 statSync（探针计数不增长），
    // 也不触发全量签名/重算（修复前探针每 poll 实算——两探缓存不对称）
    expect(__analysisOverviewProbeCountForTest()).toBe(1)
    expect(__analysisOverviewSigCountForTest()).toBe(1)
    expect(__analysisOverviewScanCountForTest()).toBe(1)
    expect(r2).toEqual(r1)
  })

  it('TTL 过期后重探：探针计数增长；TTL 窗内不可见的信封变化经重探重算见新值', async () => {
    const { root, docId1 } = makeAnalysisBook()
    __setAnalysisOverviewTtlForTest(60_000)
    const before = await getAnalysisOverviewCached(root)
    expect(before.scoreTrend[0]!.score).toBe(8)
    await sleep(5)
    // 信封原子重写（re-analyze 同目录 rename 落盘）——目录 mtime 已变，但 TTL 窗内
    // 探针节流命中旧指纹（即时可见收敛为 ≤TTL 窗，语义与 R44-9① version-stats 侧一致）
    writeAnalysis(root, docId1, 'score', envOf({ score: 3, dims: { 爽点: 3 } }))
    const throttled = await getAnalysisOverviewCached(root)
    expect(__analysisOverviewProbeCountForTest()).toBe(1)
    expect(throttled.scoreTrend[0]!.score).toBe(8)
    // TTL 过期 → 必须重新探（探针计数 +1）→ 指纹失配 → 全量签名 → 重算见新值
    __setAnalysisOverviewTtlForTest(0)
    const after = await getAnalysisOverviewCached(root)
    expect(__analysisOverviewProbeCountForTest()).toBe(2)
    expect(__analysisOverviewSigCountForTest()).toBe(2)
    expect(__analysisOverviewScanCountForTest()).toBe(2)
    expect(after.scoreTrend[0]!.score).toBe(3)
  })
})
