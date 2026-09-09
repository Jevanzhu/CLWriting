/**
 * R36-7（三十六轮）回归：analysis-overview 全书聚合 mtime 探针 + 5s TTL 缓存。
 *
 * 端点原每请求全量同步读（manifest 整读 + 分析目录全部信封 JSON 读 + parse），工作台
 * 进页/轮询/刷新反复触发；R36-7 对齐 search.ts R35-7（mtime 探针 + TTL）加缓存壳：
 * 命中即跳过内容读（只做元数据级 stat）。失效语义（方案偏离记档见 api/analysis.ts）：
 * - 每文件 mtime/size 探针即时失效——直写盘重写既有信封/新增信封/删信封/换 manifest
 *   下次调用立即重算（低-5/R66-27 等「直写盘后立即 GET 断言新鲜度」的既有测试不退化）；
 * - TTL 5s 兜底探针不可见的变化（mtime 粒度粗/同拍同尺寸重写/计算期间外部写）；
 * - forgetAnalysisOverviewCache 为写侧显式失效挂点（GET 层包装之外直接可测）。
 *
 * 断言用「全量重算计数」观测口（__analysisOverviewScanCountForTest），确定性不依赖
 * 墙钟 5s。
 *
 * R44-10（四十四轮）适配：getAnalysisOverviewCached 同步转 async（MISS 计算体
 * 分批让出），调用点补 await；两级探针与失效语义不变。
 *
 * 重评2-P3-④（2026-09-09 全量重评 GLM-5.3）适配：analysisOverviewProbe 纳入
 * TTL 节流（补齐 snapshots.ts R44-9① 只落一侧的不对称）——TTL 窗内的信封变化
 * 从「下次调用即时失效」收敛为「TTL 到期重探后失效（≤5s）」，与就地内容改写的
 * 既有兜底窗口一致（记档见 api/analysis.ts 重评2-P3-④ 注）；forgetAnalysisOverviewCache
 * 显式失效不受节流影响。下方「直写盘重写/新增信封/style 落盘」三用例按节流语义更新。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getAnalysisOverviewCached,
  forgetAnalysisOverviewCache,
  __setAnalysisOverviewTtlForTest,
  __analysisOverviewScanCountForTest,
  __resetAnalysisOverviewScanCountForTest,
} from '../../src/studio/server/api/analysis.js'
import { writeAnalysis, type Envelope } from '../../src/document/analysis.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function env(payload: unknown): Envelope {
  return { generatedAt: new Date().toISOString(), model: 'mock', sourceHash: '0'.repeat(64), payload }
}

let roots: string[] = []

/** 建书：manifest 登记 2 章（0001/0002 正文章）+ 每章 score 分析信封。 */
function makeBook(): { root: string; docId1: string; docId2: string } {
  const root = mkdtempSync(join(tmpdir(), 'r36-ov-cache-'))
  roots.push(root)
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  const docId1 = generateDocId()
  const docId2 = generateDocId()
  upsertEntry(m, { id: docId1, nodeType: 'document', path: '写作/正文/0001-雨夜.md', parentId: null })
  upsertEntry(m, { id: docId2, nodeType: 'document', path: '写作/正文/0002-晨光.md', parentId: null })
  writeManifest(manifestPath, m)
  writeAnalysis(root, docId1, 'score', env({ score: 8, dims: { 爽点: 8 } }))
  writeAnalysis(root, docId2, 'score', env({ score: 6, dims: { 爽点: 6 } }))
  return { root, docId1, docId2 }
}

afterEach(() => {
  __setAnalysisOverviewTtlForTest(null)
  __resetAnalysisOverviewScanCountForTest()
  for (const r of roots) rmSync(r, { recursive: true, force: true })
  roots = []
})

describe('R36-7 analysis-overview 缓存', () => {
  it('连续两次请求：第二次缓存命中不重算（scan 计数不变），结果一致', async () => {
    const { root } = makeBook()
    __setAnalysisOverviewTtlForTest(60_000) // 长档：慢机下不自然过期
    const r1 = await getAnalysisOverviewCached(root)
    expect(__analysisOverviewScanCountForTest()).toBe(1)
    expect(r1.scoreTrend).toHaveLength(2)
    const r2 = await getAnalysisOverviewCached(root)
    expect(__analysisOverviewScanCountForTest()).toBe(1) // 无写入：命中，未重算
    expect(r2).toEqual(r1)
  })

  it('直写盘重写既有信封：TTL 窗内探针节流命中旧值；TTL 到期重探重算见新值（不依赖写侧挂点）', async () => {
    const { root, docId1 } = makeBook()
    __setAnalysisOverviewTtlForTest(60_000)
    const before = await getAnalysisOverviewCached(root)
    expect(before.scoreTrend.find((t) => t.章号 === 1)?.score).toBe(8)
    // 直写盘（不走 analyze POST 失效挂点）重写章 1 score——模拟低-5 测试同类直写面
    await sleep(5) // 让 mtime 跨过同毫秒档，重探时探针必然失配
    writeAnalysis(root, docId1, 'score', env({ score: 3, dims: { 爽点: 3 } }))
    // 重评2-P3-④：探针纳入 TTL 节流——窗内命中不重算（即时失效收敛为 ≤TTL 窗，头注记档）
    const throttled = await getAnalysisOverviewCached(root)
    expect(__analysisOverviewScanCountForTest()).toBe(1)
    expect(throttled.scoreTrend.find((t) => t.章号 === 1)?.score).toBe(8)
    // TTL 到期 → 必须重新探 → 指纹失配 → 重算见新值
    __setAnalysisOverviewTtlForTest(0)
    const after = await getAnalysisOverviewCached(root)
    expect(__analysisOverviewScanCountForTest()).toBe(2) // 探针失配 → 重算
    expect(after.scoreTrend.find((t) => t.章号 === 1)?.score).toBe(3)
  })

  it('新增信封（新章分析落盘）：TTL 窗内节流命中；TTL 到期重探失效，趋势增多；forget 显式失效同效', async () => {
    const { root, docId1 } = makeBook()
    __setAnalysisOverviewTtlForTest(60_000)
    const before = await getAnalysisOverviewCached(root)
    expect(before.hooksTrend).toHaveLength(0)
    await sleep(5)
    writeAnalysis(root, docId1, 'hooks', env({ hooks: ['危机钩'], density: '中' }))
    // 重评2-P3-④：TTL 窗内探针节流命中（不重算）
    const throttled = await getAnalysisOverviewCached(root)
    expect(__analysisOverviewScanCountForTest()).toBe(1)
    expect(throttled.hooksTrend).toHaveLength(0)
    // TTL 到期 → 重探 → 分析目录 mtime 变 → 重算
    __setAnalysisOverviewTtlForTest(0)
    const after = await getAnalysisOverviewCached(root)
    expect(__analysisOverviewScanCountForTest()).toBe(2)
    expect(after.hooksTrend).toHaveLength(1)
    // forget 显式失效挂点同效（不走探针，不受节流影响）
    forgetAnalysisOverviewCache(root)
    await getAnalysisOverviewCached(root)
    expect(__analysisOverviewScanCountForTest()).toBe(3)
  })

  it('TTL 到期重算：探针无变化也按超期重算（注入 TTL=0）', async () => {
    const { root } = makeBook()
    await getAnalysisOverviewCached(root)
    expect(__analysisOverviewScanCountForTest()).toBe(1)
    __setAnalysisOverviewTtlForTest(0) // 即刻过期
    await getAnalysisOverviewCached(root)
    expect(__analysisOverviewScanCountForTest()).toBe(2)
    // 恢复默认后再次命中缓存（TTL 重新计）
    __setAnalysisOverviewTtlForTest(60_000)
    await getAnalysisOverviewCached(root)
    expect(__analysisOverviewScanCountForTest()).toBe(2)
  })

  it('style 全书信封参与读面：TTL 窗内节流命中旧值；TTL 到期重探重算可见', async () => {
    const { root } = makeBook()
    const { writeBookAnalysisAsync } = await import('../../src/document/analysis.js')
    __setAnalysisOverviewTtlForTest(60_000)
    const before = await getAnalysisOverviewCached(root)
    expect(before.style).toBeNull()
    await sleep(5)
    await writeBookAnalysisAsync(root, 'style', env({ 口癖: ['嗯'] }))
    // 重评2-P3-④：TTL 窗内探针节流命中（__book__.json 虽属探针读面，重探才可见）
    const throttled = await getAnalysisOverviewCached(root)
    expect(__analysisOverviewScanCountForTest()).toBe(1)
    expect(throttled.style).toBeNull()
    // TTL 到期 → 重探 → 分析目录 mtime 变 → 重算见新值
    __setAnalysisOverviewTtlForTest(0)
    const after = await getAnalysisOverviewCached(root)
    expect(__analysisOverviewScanCountForTest()).toBe(2)
    expect((after.style as { 口癖?: string[] })?.口癖).toEqual(['嗯'])
  })
})

// ── R43-13（四十三轮）：16+ 位数字文件名的失真章号不入趋势数据 ────────────

describe('R43-13: 失真章号（非安全整数）不入 allChapters / 三类趋势', () => {
  it('17 位数字名章不入 allChapters 与 score 趋势；正常章照常入列', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r43-ana-guard-'))
    roots.push(root)
    const manifestPath = join(root, '项目', '文档清单.jsonl')
    const m = readManifest(manifestPath)
    const docIdOk = generateDocId()
    const docIdBad = generateDocId()
    upsertEntry(m, { id: docIdOk, nodeType: 'document', path: '写作/正文/0005-正常章.md', parentId: null })
    // 17 个 9：parseInt → 1e17（超 2^53 失真浮点，非安全整数）
    upsertEntry(m, { id: docIdBad, nodeType: 'document', path: `写作/正文/${'9'.repeat(17)}-超长数字名.md`, parentId: null })
    writeManifest(manifestPath, m)
    writeAnalysis(root, docIdOk, 'score', env({ score: 8, dims: { 爽点: 8 } }))
    writeAnalysis(root, docIdBad, 'score', env({ score: 6, dims: { 爽点: 6 } }))
    const ov = await getAnalysisOverviewCached(root)
    // 失真章号按无章号处理：不进逐章映射，也不进趋势（对齐 words.ts R64-20 口径）
    expect(ov.allChapters.map((c) => c.章号)).toEqual([5])
    expect(ov.scoreTrend.map((t) => t.章号)).toEqual([5])
  })
})