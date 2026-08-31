/**
 * learn store 单测（第十一轮 P1-TST-1）：
 * 收割候选加载 / 勾选切换 / 入库提交 / 清空 / 切书竞态守卫（M-3 二轮复审）。
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

/** R32-31：金句 fixture 工厂（身份 = 出处+正文，勾选 API 传整对象） */
function Q(正文: string, 出处: string) {
  return { 场景: '通用', 正文, 出处, 章号: 1 }
}
/** R33D-30：样章 fixture 工厂（同款身份统一） */
function S(正文: string, 出处: string) {
  return { 场景: '通用', 正文, 出处, 章号: 1, 打分: 80 }
}

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

    s.toggleSample(S('b1', 'c'))
    expect(s.isSamplePicked(S('b1', 'c'))).toBe(true)
    expect(s.pickedCount).toBe(1)

    s.toggleSample(S('b1', 'c'))
    expect(s.isSamplePicked(S('b1', 'c'))).toBe(false)
    expect(s.pickedCount).toBe(0)
  })

  it('toggleQuote → 加入再移除', async () => {
    learnMock.mockResolvedValue({ samples: [], quotes: [{ 正文: 'qb1' }] })
    const s = useLearnStore()
    await s.harvest('book1')

    // R32-31：金句身份 = 出处+正文——toggle/isPicked 传整对象
    s.toggleQuote(Q('qb1', '《书》第1章'))
    expect(s.isQuotePicked(Q('qb1', '《书》第1章'))).toBe(true)

    s.toggleQuote(Q('qb1', '《书》第1章'))
    expect(s.isQuotePicked(Q('qb1', '《书》第1章'))).toBe(false)
  })

  // R32-31（三十二轮）：同文不同出处 → 独立勾选互不联动（此前共用正文身份）
  it('R32-31: 同文不同出处 → 各自独立勾选', async () => {
    learnMock.mockResolvedValue({
      samples: [],
      quotes: [Q('同文', '《书》第1章'), Q('同文', '《书》第2章')],
    })
    const s = useLearnStore()
    await s.harvest('book1')

    s.toggleQuote(Q('同文', '《书》第1章'))
    expect(s.isQuotePicked(Q('同文', '《书》第1章'))).toBe(true)
    expect(s.isQuotePicked(Q('同文', '《书》第2章'))).toBe(false)
    expect(s.pickedCount).toBe(1)

    // commit 只移除已勾选身份，另一条保留
    commitMock.mockResolvedValue({ ok: true, sampleFiles: [], quoteFiles: ['q1.md'] })
    await s.commit('book1')
    expect(s.quotes).toHaveLength(1)
    expect(s.quotes[0]!.出处).toBe('《书》第2章')
  })

  it('clearPicks → 清空所有勾选', async () => {
    learnMock.mockResolvedValue({ samples: [{ 正文: 'b1' }], quotes: [{ 正文: 'q1' }] })
    const s = useLearnStore()
    await s.harvest('book1')
    s.toggleSample(S('b1', 'c'))
    s.toggleQuote(Q('q1', '《书》第1章'))
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
    s.toggleSample(S('b1', 'c'))

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
    learnMock.mockResolvedValue({ samples: [{ 场景: 's', 正文: 'b1', 出处: 'c' }], quotes: [] })
    commitMock.mockRejectedValue(new Error('写入失败'))
    const s = useLearnStore()
    await s.harvest('book1')
    s.toggleSample(S('b1', 'c'))

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
    s.toggleSample(S('b1', 'c'))

    s.clear()
    expect(s.samples).toHaveLength(0)
    expect(s.quotes).toHaveLength(0)
    expect(s.pickedCount).toBe(0)
    expect(s.error).toBeNull()
    expect(s.commitMessage).toBeNull()
  })
})

describe('learn: 切书竞态（M-3 reqGen 守卫）', () => {
  it('A 书在途 harvest 在 clear 之后回填 → 被守卫拒绝，不污染候选列表', async () => {
    let releaseA!: () => void
    const gate = new Promise<void>((r) => {
      releaseA = r
    })
    learnMock.mockImplementationOnce(() =>
      gate.then(() => ({ samples: [{ 场景: 'A 场', 正文: 'A 书正文候选', 出处: 'chA' }], quotes: [] })),
    )
    const s = useLearnStore()
    const pA = s.harvest('bookA')

    // 切书：clear 作废 A 的代数，B 书收割立即返回
    s.clear()
    learnMock.mockResolvedValueOnce({ samples: [{ 场景: 'B 场', 正文: 'B 书正文候选', 出处: 'chB' }], quotes: [] })
    await s.harvest('bookB')
    expect(s.samples[0]!.正文).toBe('B 书正文候选')

    // A 书慢响应落地：守卫拦截，B 书候选不被覆盖（勾选入库即跨书污染，此处必须拦死）
    releaseA()
    await pA
    expect(s.samples).toHaveLength(1)
    expect(s.samples[0]!.正文).toBe('B 书正文候选')
    expect(s.loading).toBe(false)
  })
})

// R-1（第十六轮）：clear() 推代 + finally 查代把 loading 永久卡 true——收割按钮再不可触发
describe('learn: R-1 clear 在途 harvest 不卡 loading', () => {
  it('harvest 在途 → clear → 迟到响应 settle → loading 为 false（按钮可再触发）', async () => {
    let releaseA!: () => void
    const gate = new Promise<void>((r) => { releaseA = r })
    learnMock.mockImplementationOnce(() =>
      gate.then(() => ({ samples: [], quotes: [] })),
    )
    const s = useLearnStore()
    const p = s.harvest('bookA')
    expect(s.loading).toBe(true)

    s.clear() // 切书：reqGen 推进
    expect(s.loading).toBe(false) // 修复前：仍 true，且迟到的 finally 查代不过永不复位

    releaseA()
    await p
    expect(s.loading).toBe(false)
    expect(s.hasResult).toBe(false) // 迟到数据不落地
  })
})
