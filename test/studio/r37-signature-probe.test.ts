/**
 * R37-17（三十七轮批 D）回归：version-stats / analysis-overview 签名两级探针。
 *
 * 修复前：前端 3s 轮询每触发都全量重算盘面签名（versionStatsSignature 递归 lstat
 * walk / analysisOverviewSignature 每文件 stat）。修复后两级：第一级便宜目录指纹
 *（manifest stat + 目录 mtime（version-stats 另含 .版本 各直接子目录 mtime））未变
 * → 跳过全量签名 walk 直接复用；指纹变了才走第二级全量签名（R36-7 原口径）。
 *
 * 用 __versionStatsSigCountForTest / __analysisOverviewSigCountForTest 观测全量签名
 * 执行次数（「spy 全量计算」），__*ScanCountForTest 观测结果重算次数。
 *
 * 探针覆盖边界（与生产注释同口径，用例固化）：
 * - 应用侧写路径全是同目录 rename 原子落盘（atomicWriteFile）——rename 替换目录条目
 *   会刷目录 mtime，一级探针可见（「内容修改仍能探出」的正路径）；
 * - 外部进程「非 rename 就地直写」一级探针不可见——由 TTL 到期兜底重算（边界用例
 *   固化：直写后探针命中旧缓存，TTL=0 注入后走全量签名见新值）。
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
} from '../../src/studio/server/api/snapshots.js'
import {
  getAnalysisOverviewCached,
  __setAnalysisOverviewTtlForTest,
  __analysisOverviewScanCountForTest,
  __resetAnalysisOverviewScanCountForTest,
  __analysisOverviewSigCountForTest,
  __resetAnalysisOverviewSigCountForTest,
} from '../../src/studio/server/api/analysis.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { writeAnalysis, type Envelope } from '../../src/document/analysis.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { atomicWriteFile } from '../../src/fs/atomic.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let roots: string[] = []

function envOf(payload: unknown): Envelope {
  return { generatedAt: new Date().toISOString(), model: 'mock', sourceHash: '0'.repeat(64), payload }
}

/** 建书：manifest 登记 doc_1（定稿）+ .版本/doc_1 一个 pinned 快照。 */
function makeSnapshotBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'r37-probe-vs-'))
  roots.push(root)
  const vdir = join(root, '工作区', '.版本', 'doc_1')
  mkdirSync(vdir, { recursive: true })
  writeFileSync(join(vdir, 'a.md'), '---\n来源: manual\n永久: true\n---\n定稿内容若干字\n', 'utf-8')
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  upsertEntry(m, { id: 'doc_1', nodeType: 'document', path: '写作/正文/0001-雨夜.md', parentId: null })
  m.entries.get('doc_1')!.finalizedRevision = 'sha256:' + 'a'.repeat(64)
  writeManifest(manifestPath, m)
  return root
}

/** 建书：manifest 登记 doc_1 + score 信封（口径同 r36-analysis-overview-cache）。 */
function makeAnalysisBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'r37-probe-ao-'))
  roots.push(root)
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  const docId1 = generateDocId()
  upsertEntry(m, { id: docId1, nodeType: 'document', path: '写作/正文/0001-雨夜.md', parentId: null })
  writeManifest(manifestPath, m)
  writeAnalysis(root, docId1, 'score', envOf({ score: 8, dims: { 爽点: 8 } }))
  return root
}

afterEach(() => {
  __setVersionStatsTtlForTest(null)
  __resetVersionStatsScanCountForTest()
  __resetVersionStatsSigCountForTest()
  __setAnalysisOverviewTtlForTest(null)
  __resetAnalysisOverviewScanCountForTest()
  __resetAnalysisOverviewSigCountForTest()
  for (const r of roots) rmSync(r, { recursive: true, force: true })
  roots = []
})

describe('R37-17 version-stats 两级探针', () => {
  it('未修改期间第二次调用命中一级探针：全量签名与重算都不再执行', () => {
    const root = makeSnapshotBook()
    __setVersionStatsTtlForTest(60_000)
    const r1 = getVersionStatsCached(root)
    expect(__versionStatsSigCountForTest()).toBe(1)
    expect(__versionStatsScanCountForTest()).toBe(1)
    expect(r1.snapshotCount).toBe(1)
    const r2 = getVersionStatsCached(root)
    expect(__versionStatsSigCountForTest()).toBe(1) // 一级命中：递归签名 walk 未跑
    expect(__versionStatsScanCountForTest()).toBe(1)
    expect(r2).toEqual(r1)
  })

  it('快照内容原子重写（同目录 rename）→ 一级探针失配 → 全量签名 + 重算见新值', async () => {
    const root = makeSnapshotBook()
    __setVersionStatsTtlForTest(60_000)
    const before = getVersionStatsCached(root)
    await sleep(5)
    atomicWriteFile(join(root, '工作区', '.版本', 'doc_1', 'a.md'), '---\n来源: manual\n永久: true\n---\n更长的新定稿内容若干字若干字\n')
    const after = getVersionStatsCached(root)
    expect(__versionStatsSigCountForTest()).toBe(2) // 指纹失配 → 全量签名跑了
    expect(__versionStatsScanCountForTest()).toBe(2) // 签名变化 → 重算
    expect(after.snapshotBytes).toBeGreaterThan(before.snapshotBytes)
  })

  it('边界：非 rename 就地直写探针不可见（命中旧缓存）；TTL 到期兜底重算见新值', async () => {
    const root = makeSnapshotBook()
    __setVersionStatsTtlForTest(60_000)
    const before = getVersionStatsCached(root)
    await sleep(5)
    // 就地直写（外部进程形态：writeFileSync 覆写、不经 rename）——目录 mtime 不变
    writeFileSync(join(root, '工作区', '.版本', 'doc_1', 'a.md'), '---\n来源: manual\n永久: true\n---\n短\n', 'utf-8')
    const stale = getVersionStatsCached(root)
    expect(__versionStatsSigCountForTest()).toBe(1) // 一级探针未察觉：签名未跑
    expect(stale.snapshotBytes).toBe(before.snapshotBytes) // 命中旧缓存（边界如实固化）
    // TTL 到期 → 跳过一级 → 全量签名 → 失配 → 重算见新值（兜底闭环）
    __setVersionStatsTtlForTest(0)
    const fresh = getVersionStatsCached(root)
    expect(__versionStatsSigCountForTest()).toBe(2)
    expect(__versionStatsScanCountForTest()).toBe(2)
    expect(fresh.snapshotBytes).toBeLessThan(before.snapshotBytes)
  })
})

describe('R37-17 analysis-overview 两级探针', () => {
  it('未修改期间第二次调用命中一级探针：全量签名与重算都不再执行', () => {
    const root = makeAnalysisBook()
    __setAnalysisOverviewTtlForTest(60_000)
    const r1 = getAnalysisOverviewCached(root)
    expect(__analysisOverviewSigCountForTest()).toBe(1)
    expect(__analysisOverviewScanCountForTest()).toBe(1)
    expect(r1.scoreTrend).toHaveLength(1)
    const r2 = getAnalysisOverviewCached(root)
    expect(__analysisOverviewSigCountForTest()).toBe(1) // 一级命中：每文件 stat 签名未跑
    expect(__analysisOverviewScanCountForTest()).toBe(1)
    expect(r2).toEqual(r1)
  })

  it('信封原子重写（re-analyze，同目录 rename）→ 一级探针失配 → 全量签名 + 重算见新值', async () => {
    const root = makeAnalysisBook()
    __setAnalysisOverviewTtlForTest(60_000)
    const manifestPath = join(root, '项目', '文档清单.jsonl')
    const docId = readManifest(manifestPath).entries.keys().next().value as string
    const before = getAnalysisOverviewCached(root)
    expect(before.scoreTrend[0]!.score).toBe(8)
    await sleep(5)
    writeAnalysis(root, docId, 'score', envOf({ score: 3, dims: { 爽点: 3 } }))
    const after = getAnalysisOverviewCached(root)
    expect(__analysisOverviewSigCountForTest()).toBe(2)
    expect(__analysisOverviewScanCountForTest()).toBe(2)
    expect(after.scoreTrend[0]!.score).toBe(3)
  })

  it('边界：非 rename 就地直写探针不可见（命中旧缓存）；TTL 到期兜底重算见新值', async () => {
    const root = makeAnalysisBook()
    __setAnalysisOverviewTtlForTest(60_000)
    const manifestPath = join(root, '项目', '文档清单.jsonl')
    const docId = readManifest(manifestPath).entries.keys().next().value as string
    const before = getAnalysisOverviewCached(root)
    expect(before.scoreTrend[0]!.score).toBe(8)
    await sleep(5)
    // 就地直写（外部编辑器形态：writeFileSync 覆写信封、不经 rename）——目录 mtime 不变。
    // 落盘形状与 writeAnalysis 同构（kind 键嵌套：{ score: Envelope }）
    writeFileSync(join(root, '项目', '分析', `${docId}.json`), JSON.stringify({ score: envOf({ score: 1, dims: { 爽点: 1 } }) }, null, 2), 'utf-8')
    const stale = getAnalysisOverviewCached(root)
    expect(__analysisOverviewSigCountForTest()).toBe(1) // 一级探针未察觉：签名未跑
    expect(stale.scoreTrend[0]!.score).toBe(8) // 命中旧缓存（边界如实固化）
    // TTL 到期 → 跳过一级 → 全量签名 → 失配 → 重算见新值（兜底闭环）
    __setAnalysisOverviewTtlForTest(0)
    const fresh = getAnalysisOverviewCached(root)
    expect(__analysisOverviewSigCountForTest()).toBe(2)
    expect(__analysisOverviewScanCountForTest()).toBe(2)
    expect(fresh.scoreTrend[0]!.score).toBe(1)
  })
})
