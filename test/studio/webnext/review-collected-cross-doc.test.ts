/**
 * R1010b-FE-P2-1（2026-09-10 内存专项重审修复批）回归：review store 跨文档切换不清 collected。
 *
 * 修复前：collected 只在 run 成功 / loadEnvelope 回填时写入、切文档从不清——文档 A
 *（有采集）切到 B：B 有信封时 `!collected.value` 为假跳过回填、B 无信封时 env 为 null
 * 同样保留 A 的 collected，ReviewPanel 的 blockers/warnings/passed 全派生自 collected，
 * A 的三审意见串显在 B 的面板上（verdict 徽章却是 B 的）。修复：store 入口 lastLoadKey
 * 归属键（`书::docId`），loadEnvelope 判定跨文档/跨书先清再拉；run 落地同步推进键；
 * clear 复位。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/review', () => ({
  runReview: vi.fn(),
  getReviewEnvelope: vi.fn(),
  runVerdictDoc: vi.fn(),
}))

import { runReview, getReviewEnvelope, runVerdictDoc } from '../../../src/studio/web-next/src/api/review'
import { useReviewStore } from '../../../src/studio/web-next/src/stores/review'

const reviewMock = runReview as ReturnType<typeof vi.fn>
const envelopeMock = getReviewEnvelope as ReturnType<typeof vi.fn>
const verdictMock = runVerdictDoc as ReturnType<typeof vi.fn>

const collectedA = { ok: true, collected_lenses: ['reader'], missing_lenses: [] }
const collectedB = { ok: true, collected_lenses: ['editor'], missing_lenses: [] }

function envelopeOf(collected: unknown, verdict?: unknown) {
  return {
    envelope: { generatedAt: 't', model: 'm', sourceHash: 'h', payload: { collected, ...(verdict ? { verdict } : {}) } },
    stale: false,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('R1010b-FE-P2-1: 跨文档切换不清 collected', () => {
  it('① A（有采集）→ B 无信封：collected 清空（不串显 A 的意见）', async () => {
    reviewMock.mockResolvedValue({ ok: true, lenses: [], collected: collectedA })
    const s = useReviewStore()
    await s.run('book1', 'doc_A')
    expect(s.collected).toEqual(collectedA)

    envelopeMock.mockResolvedValue(undefined) // B 无存量信封
    await s.loadEnvelope('book1', 'doc_B')
    expect(s.envelope).toBeNull()
    expect(s.collected).toBeNull() // 修复前：仍 collectedA（串显）
  })

  it('② A → B 有自己的信封：collected 回填为 B 的（不是 A 的）', async () => {
    envelopeMock.mockResolvedValueOnce(envelopeOf(collectedA)) // 文档 A
    const s = useReviewStore()
    await s.loadEnvelope('book1', 'doc_A')
    expect(s.collected).toEqual(collectedA)

    envelopeMock.mockResolvedValueOnce(envelopeOf(collectedB)) // 文档 B
    await s.loadEnvelope('book1', 'doc_B')
    expect(s.collected).toEqual(collectedB) // 修复前：`!collected.value` 为假跳过回填，仍 collectedA
  })

  it('②b 跨书同 docId（bookA → bookB）：归属键含书名，同样先清', async () => {
    reviewMock.mockResolvedValue({ ok: true, lenses: [], collected: collectedA })
    const s = useReviewStore()
    await s.run('bookA', 'doc_1')
    expect(s.collected).toEqual(collectedA)

    envelopeMock.mockResolvedValue(undefined)
    await s.loadEnvelope('bookB', 'doc_1')
    expect(s.collected).toBeNull()
  })

  it('③ run() 落地后同文档 loadEnvelope：不清新采集结果（回填被 collected 非空挡住）', async () => {
    reviewMock.mockResolvedValue({ ok: true, lenses: [], collected: collectedA })
    const s = useReviewStore()
    await s.run('book1', 'doc_1')

    envelopeMock.mockResolvedValue(envelopeOf(collectedB)) // 信封 payload 与新跑结果不同源
    await s.loadEnvelope('book1', 'doc_1')
    expect(s.collected).toEqual(collectedA) // 修复前（若无归属键推进）：被误清后回填成 collectedB
  })

  it('④ setVerdict 同文档链：裁决回读 loadEnvelope 不清刚落的采集', async () => {
    reviewMock.mockResolvedValue({ ok: true, lenses: [], collected: collectedA })
    verdictMock.mockResolvedValue(undefined)
    envelopeMock.mockResolvedValue(envelopeOf(collectedA, { approved: true, at: 'now' }))
    const s = useReviewStore()
    await s.run('book1', 'doc_1')
    await s.setVerdict('book1', 'doc_1', true)
    expect(s.collected).toEqual(collectedA) // 同文档重入豁免
    expect(s.verdict?.approved).toBe(true)
  })

  it('⑤ clear() 复位归属键：clear 后再 loadEnvelope 同文档照常回填信封 collected', async () => {
    reviewMock.mockResolvedValue({ ok: true, lenses: [], collected: collectedA })
    const s = useReviewStore()
    await s.run('book1', 'doc_1')
    s.clear()
    expect(s.collected).toBeNull()

    envelopeMock.mockResolvedValue(envelopeOf(collectedB))
    await s.loadEnvelope('book1', 'doc_1')
    expect(s.collected).toEqual(collectedB) // 归属键已复位 → 键不同先清（null）→ 回填不受阻
  })
})
