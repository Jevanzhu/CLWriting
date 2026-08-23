/**
 * review store 单测（第十一轮 P1-TST-1）：
 * 发起三审 / 读存量信封 / 作者裁决 / 清空。
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

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('review: 发起三审', () => {
  it('run 成功 → collected + envelope 填充', async () => {
    reviewMock.mockResolvedValue({
      ok: true, lenses: ['reader', 'editor'], collected: { ok: true, collected_lenses: ['reader'], missing_lenses: ['editor'] },
    })
    envelopeMock.mockResolvedValue({ envelope: { generatedAt: '2026-01-01', model: 'm', sourceHash: 'h', payload: { collected: { ok: true, collected_lenses: [], missing_lenses: [] } } }, stale: false })
    const s = useReviewStore()
    await s.run('book1', 'doc_1')
    expect(s.collected).not.toBeNull()
    expect(s.envelope).not.toBeNull()
    expect(s.stale).toBe(false)
    expect(s.loading).toBe(false)
    expect(s.error).toBeNull()
    expect(s.lastDocId).toBe('doc_1')
  })

  it('run 失败 → error 设置 + collected 清空', async () => {
    reviewMock.mockRejectedValue(new Error('AI 不可达'))
    const s = useReviewStore()
    await s.run('book1', 'doc_1')
    expect(s.error).not.toBeNull()
    expect(s.collected).toBeNull()
    expect(s.loading).toBe(false)
  })
})

describe('review: 读存量信封', () => {
  it('loadEnvelope 有信封 → 填充 envelope + stale', async () => {
    envelopeMock.mockResolvedValue({
      envelope: { generatedAt: 't', model: 'm', sourceHash: 'h', payload: { collected: { ok: true, collected_lenses: ['reader'], missing_lenses: [] } } },
      stale: true,
    })
    const s = useReviewStore()
    await s.loadEnvelope('book1', 'doc_1')
    expect(s.envelope).not.toBeNull()
    expect(s.stale).toBe(true)
    expect(s.lastDocId).toBe('doc_1')
  })

  it('loadEnvelope 无信封 → envelope null', async () => {
    envelopeMock.mockResolvedValue(undefined)
    const s = useReviewStore()
    await s.loadEnvelope('book1', 'doc_1')
    expect(s.envelope).toBeNull()
  })
})

describe('review: 作者裁决', () => {
  it('setVerdict → 调 runVerdictDoc + reload envelope', async () => {
    verdictMock.mockResolvedValue(undefined)
    envelopeMock.mockResolvedValue({
      envelope: { generatedAt: 't2', model: 'm', sourceHash: 'h2', payload: { collected: { ok: true, collected_lenses: [], missing_lenses: [] }, verdict: { approved: true, at: 'now' } } },
      stale: false,
    })
    const s = useReviewStore()
    await s.setVerdict('book1', 'doc_1', true)
    expect(verdictMock).toHaveBeenCalledWith('book1', 'doc_1', true)
    expect(s.verdict).not.toBeNull()
    expect(s.verdict?.approved).toBe(true)
  })
})

describe('review: clear', () => {
  it('clear → 全部重置', async () => {
    reviewMock.mockResolvedValue({ ok: true, lenses: [], collected: { ok: true, collected_lenses: [], missing_lenses: [] } })
    envelopeMock.mockResolvedValue({ envelope: null, stale: false })
    const s = useReviewStore()
    await s.run('book1', 'doc_1')

    s.clear()
    expect(s.collected).toBeNull()
    expect(s.envelope).toBeNull()
    expect(s.stale).toBe(false)
    expect(s.error).toBeNull()
    expect(s.lastDocId).toBeNull()
  })
})

// R-1（第十六轮）：clear() 推代 + finally 查代把 loading 永久卡 true——三审按钮再不可触发
describe('review: R-1 clear 在途 run 不卡 loading', () => {
  it('run 在途 → clear → 迟到响应 settle → loading 为 false（按钮可再触发）', async () => {
    let release!: (v: unknown) => void
    reviewMock.mockReturnValue(new Promise((r) => { release = r }))
    const s = useReviewStore()
    const p = s.run('book1', 'doc_1')
    expect(s.loading).toBe(true)

    s.clear() // 切文档：opGen 推进
    expect(s.loading).toBe(false) // 修复前：仍 true，且迟到的 finally 查代不过永不复位

    release({ ok: true, lenses: [], collected: { ok: true, collected_lenses: [], missing_lenses: [] } })
    await p
    expect(s.loading).toBe(false)
    expect(s.collected).toBeNull() // 迟到数据不落地
  })
})
