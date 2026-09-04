/**
 * R44-10（四十四轮）回归：analysis-overview MISS 计算体异步分批让出。
 *
 * 两级探针已把常态压 O(1)，但指纹变化（保存/分析落盘后首查）即触发 MISS——原
 * computeAnalysisOverview 同步 readManifest 整读 + 逐 doc readAnalysisKinds 同步整读，
 * 2000 章级大书单 tick 冻结事件循环。R44-10 计算体异步化 + 每 SCAN_YIELD_EVERY（25）
 * doc setImmediate 让出（对齐 overview/progress 既有纪律，R39-15 同款），handler
 * 相应 async。
 *
 * 断言手法照抄仓内同类 yield 测试（r37-scan-async-twins）：setImmediate 心跳探针
 * 「至少插队一次」+ globalThis.setImmediate spy 计让出下界（graceful-shutdown
 * setTimeout spy 同款先例）。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getAnalysisOverviewCached,
  __setAnalysisOverviewTtlForTest,
  __analysisOverviewScanCountForTest,
  __resetAnalysisOverviewScanCountForTest,
} from '../../src/studio/server/api/analysis.js'
import { writeAnalysis, type Envelope } from '../../src/document/analysis.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'

let roots: string[] = []

/** 建书：manifest 登记 N 章正文档 + 每章一个 score 信封（MISS 读面逐 doc 展开）。 */
function makeBook(docCount: number): string {
  const root = mkdtempSync(join(tmpdir(), 'r44-ao-yield-'))
  roots.push(root)
  mkdirSync(join(root, '项目', '分析'), { recursive: true })
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  const env = (score: number): Envelope => ({
    generatedAt: new Date().toISOString(),
    model: 'mock',
    sourceHash: '0'.repeat(64),
    payload: { score, dims: { 爽点: score } },
  })
  for (let no = 1; no <= docCount; no++) {
    const docId = generateDocId()
    upsertEntry(m, { id: docId, nodeType: 'document', path: `写作/正文/${String(no).padStart(4, '0')}-第${no}章.md`, parentId: null })
    writeAnalysis(root, docId, 'score', env(5 + (no % 3)))
  }
  writeManifest(manifestPath, m)
  return root
}

afterEach(() => {
  __setAnalysisOverviewTtlForTest(null)
  __resetAnalysisOverviewScanCountForTest()
  vi.restoreAllMocks()
  for (const r of roots) rmSync(r, { recursive: true, force: true })
  roots = []
})

describe('R44-10 analysis-overview MISS 分批让出', () => {
  it('MISS 路径多 doc 时事件循环可响应：setImmediate 心跳至少插队一次', async () => {
    const root = makeBook(60)
    __setAnalysisOverviewTtlForTest(60_000)
    let beats = 0
    const probe = (): void => {
      if (beats < 256) {
        beats++
        setImmediate(probe)
      }
    }
    const p = getAnalysisOverviewCached(root)
    setImmediate(probe)
    const ov = await p
    expect(beats).toBeGreaterThan(0) // 「至少一次」：不脆断言次数（r37-scan-async-twins 同款）
    expect(__analysisOverviewScanCountForTest()).toBe(1)
    // 让出不破坏结果：60 doc 全部入趋势
    expect(ov.scoreTrend).toHaveLength(60)
    expect(ov.allChapters).toHaveLength(60)
  })

  it('每 25 doc 让出：60 doc 的 MISS 扫描 setImmediate 调用 ≥ 3（段间 1 + 循环 2）', async () => {
    const root = makeBook(60)
    __setAnalysisOverviewTtlForTest(60_000)
    const spy = vi.spyOn(globalThis, 'setImmediate') // graceful-shutdown setTimeout spy 同款先例
    await getAnalysisOverviewCached(root)
    // yieldToEventLoop 经 setImmediate 让出：60 doc 逐信封读循环在 25/50 处各让一次
    //（floor(60/25)=2），加 manifest 段与逐信封段之间的段间让出 1 次——下界断言
    //（框架自身的 setImmediate 调用只会使计数更高，不影响下界成立）
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(__analysisOverviewScanCountForTest()).toBe(1)
  })
})
