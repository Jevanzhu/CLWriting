/**
 * learn store 单测（第十一轮 P1-TST-1）：
 * 收割候选加载 / 勾选切换 / 入库提交 / 清空。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/learn', () => ({
  runLearn: vi.fn(),
  runLearnCommit: vi.fn(),
}))

import { runLearn, runLearnCommit } from '../../../src/studio/web-next/src/api/learn'
import { useLearnStore } from '../../../src/studio/web-next/src/stores/learn'

const learnMock = runLearn as ReturnType<typeof vi.fn>
const commitMock = runLearnCommit as ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('learn: 收割加载', () => {
  it('harvest 成功 → 候选列表填充 + 勾选清空', async () => {
    learnMock.mockResolvedValue({
      samples: [{ 场景: 's1', 正文: 'body1', 出处: 'ch1' }],
      quotes: [{ 场景: 'q1', 正文: 'qbody1', 出处: 'ch1' }],
    })
    const s = useLearnStore()
    await s.harvest('book1')
    expect(s.samples).toHaveLength(1)
    expect(s.quotes).toHaveLength(1)
    expect(s.loading).toBe(false)
    expect(s.error).toBeNull()
    expect(s.hasResult).toBe(true)
  })

  it('harvest 失败 → error 设置 + 候选清空', async () => {
    learnMock.mockRejectedValue(new Error('连接失败'))
    const s = useLearnStore()
    await s.harvest('book1')
    expect(s.error).not.toBeNull()
    expect(s.samples).toHaveLength(0)
    expect(s.quotes).toHaveLength(0)
    expect(s.hasResult).toBe(false)
    expect(s.loading).toBe(false)
  })
})

describe('learn: 勾选切换', () => {
  it('toggleSample → 加入再移除', async () => {
    learnMock.mockResolvedValue({ samples: [{ 正文: 'b1' }], quotes: [] })
    const s = useLearnStore()
    await s.harvest('book1')
    expect(s.pickedCount).toBe(0)

    s.toggleSample('b1')
    expect(s.isSamplePicked('b1')).toBe(true)
    expect(s.pickedCount).toBe(1)

    s.toggleSample('b1')
    expect(s.isSamplePicked('b1')).toBe(false)
    expect(s.pickedCount).toBe(0)
  })

  it('toggleQuote → 加入再移除', async () => {
    learnMock.mockResolvedValue({ samples: [], quotes: [{ 正文: 'qb1' }] })
    const s = useLearnStore()
    await s.harvest('book1')

    s.toggleQuote('qb1')
    expect(s.isQuotePicked('qb1')).toBe(true)

    s.toggleQuote('qb1')
    expect(s.isQuotePicked('qb1')).toBe(false)
  })

  it('clearPicks → 清空所有勾选', async () => {
    learnMock.mockResolvedValue({ samples: [{ 正文: 'b1' }], quotes: [{ 正文: 'q1' }] })
    const s = useLearnStore()
    await s.harvest('book1')
    s.toggleSample('b1')
    s.toggleQuote('q1')
    expect(s.pickedCount).toBe(2)

    s.clearPicks()
    expect(s.pickedCount).toBe(0)
  })
})

describe('learn: 入库提交', () => {
  it('commit 有勾选 → 调 API + 移除已入库项 + 设成功消息', async () => {
    learnMock.mockResolvedValue({ samples: [{ 场景: 's', 正文: 'b1', 出处: 'c' }], quotes: [] })
    commitMock.mockResolvedValue({ ok: true, sampleFiles: ['f1.md'], quoteFiles: [] })
    const s = useLearnStore()
    await s.harvest('book1')
    s.toggleSample('b1')

    await s.commit('book1')
    expect(commitMock).toHaveBeenCalledWith('book1', { samples: [{ 场景: 's', 正文: 'b1', 出处: 'c' }], quotes: [] })
    expect(s.commitMessage).toContain('已收录')
    expect(s.samples).toHaveLength(0) // 入库后从列表移除
    expect(s.pickedCount).toBe(0)
    expect(s.committing).toBe(false)
  })

  it('commit 无勾选 → 不调 API', async () => {
    learnMock.mockResolvedValue({ samples: [{ 正文: 'b1' }], quotes: [] })
    const s = useLearnStore()
    await s.harvest('book1')

    await s.commit('book1')
    expect(commitMock).not.toHaveBeenCalled()
  })

  it('commit 失败 → 设错误消息', async () => {
    learnMock.mockResolvedValue({ samples: [{ 正文: 'b1' }], quotes: [] })
    commitMock.mockRejectedValue(new Error('写入失败'))
    const s = useLearnStore()
    await s.harvest('book1')
    s.toggleSample('b1')

    await s.commit('book1')
    expect(s.commitMessage).toContain('失败')
    expect(s.committing).toBe(false)
  })
})

describe('learn: clear', () => {
  it('clear → 全部重置', async () => {
    learnMock.mockResolvedValue({ samples: [{ 正文: 'b1' }], quotes: [{ 正文: 'q1' }] })
    const s = useLearnStore()
    await s.harvest('book1')
    s.toggleSample('b1')

    s.clear()
    expect(s.samples).toHaveLength(0)
    expect(s.quotes).toHaveLength(0)
    expect(s.pickedCount).toBe(0)
    expect(s.error).toBeNull()
    expect(s.commitMessage).toBeNull()
  })
})
