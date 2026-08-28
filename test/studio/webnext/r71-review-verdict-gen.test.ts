/**
 * R71-27（七十一轮）回归：setVerdict 无入口代捕获——await 期间切书，续体
 * loadEnvelope(旧参) 再推 opGen 反超新书拉取，旧书信封串显。
 *
 * 修复：入口捕获 opGen 快照，await 返回后查代不过直接弃（对齐同文件 run/loadEnvelope）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/review', () => ({
  runReview: vi.fn(),
  getReviewEnvelope: vi.fn(),
  runVerdictDoc: vi.fn(),
}))

import { getReviewEnvelope, runVerdictDoc } from '../../../src/studio/web-next/src/api/review'
import { useReviewStore } from '../../../src/studio/web-next/src/stores/review'

const envelopeMock = getReviewEnvelope as ReturnType<typeof vi.fn>
const verdictMock = runVerdictDoc as ReturnType<typeof vi.fn>

/** 两书可区分信封（payload.collected.missing_lenses 标记来源） */
function envOf(tag: string, approved = false) {
  return {
    envelope: {
      generatedAt: `t-${tag}`,
      model: 'm',
      sourceHash: `h-${tag}`,
      payload: {
        collected: { ok: true, collected_lenses: [], missing_lenses: [tag] },
        ...(approved ? { verdict: { approved, at: 'now' } } : {}),
      },
    },
    stale: false,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('R71-27: setVerdict 在途切书 → 旧参 loadEnvelope 不再发起', () => {
  it('裁决在途 clear（切书）+ 新书 loadEnvelope 已回填 → 续体不再拉旧书信封（不推代反超）', async () => {
    let resolveVerdict!: (v: unknown) => void
    verdictMock.mockReturnValue(new Promise((r) => (resolveVerdict = r)))
    const s = useReviewStore()
    const p = s.setVerdict('书A', 'doc_A', true) // 裁决挂起（入口捕获 gen）

    s.clear() // 切书：opGen 推进 + 状态清空
    envelopeMock.mockResolvedValueOnce(envOf('书B'))
    await s.loadEnvelope('书B', 'doc_B') // 新书信封先落位
    expect(s.lastDocId).toBe('doc_B')
    expect(envelopeMock).toHaveBeenCalledTimes(1)

    resolveVerdict({ ok: true })
    await p
    // 修复点：续体查代不过直接弃——不再 loadEnvelope('书A','doc_A')（修复前会发起，
    // 再推代反超 → 旧书信封覆盖 B 书）
    expect(envelopeMock).toHaveBeenCalledTimes(1)
    expect(s.lastDocId).toBe('doc_B') // B 书数据不被旧书拉取串显
    expect(s.envelope?.generatedAt).toBe('t-书B')
  })

  it('未切书（对照）→ 裁决后正常拉信封、verdict 落地（守卫不误伤）', async () => {
    verdictMock.mockResolvedValue(undefined)
    envelopeMock.mockResolvedValueOnce(envOf('书A', true))
    const s = useReviewStore()
    await s.setVerdict('书A', 'doc_A', true)
    expect(verdictMock).toHaveBeenCalledWith('书A', 'doc_A', true)
    expect(envelopeMock).toHaveBeenCalledWith('书A', 'doc_A')
    expect(s.verdict?.approved).toBe(true)
  })

  it('裁决在途期间新文档 loadEnvelope 在跑 → 迟到续体不反超（同书两代竞争）', async () => {
    let resolveVerdict!: (v: unknown) => void
    verdictMock.mockReturnValue(new Promise((r) => (resolveVerdict = r)))
    const s = useReviewStore()
    const p = s.setVerdict('书A', 'doc_A', false)

    // 在途期间新文档打开（loadEnvelope 推代并回填 doc_B）
    envelopeMock.mockResolvedValueOnce(envOf('doc_B-env'))
    await s.loadEnvelope('书A', 'doc_B')

    resolveVerdict({ ok: true })
    await p
    expect(s.lastDocId).toBe('doc_B') // doc_A 的迟到拉取不覆盖 doc_B
    expect(envelopeMock).toHaveBeenCalledTimes(1)
  })
})
