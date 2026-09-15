// @vitest-environment happy-dom
/**
 * 四轮重评 P3-19（2026-09-15 处置批）：金句区渲染帽（样板 = SampleCandidateList
 * R47-16 / R0912-3 #23 的 capView 手法）。金句量不受前端控制，整区 v-for 全量渲染
 * DOM 爆炸；修后默认渲染前 100 张 +「显示剩余 N 条」按需展开，计数仍面向全量。
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'

vi.mock('../../../src/studio/web-next/src/api/learn', () => ({
  runLearn: vi.fn(),
  runLearnCommit: vi.fn(),
}))

import { runLearn } from '../../../src/studio/web-next/src/api/learn'
import { useLearnStore } from '../../../src/studio/web-next/src/stores/learn'
import QuoteCardGrid from '../../../src/studio/web-next/src/components/learn/QuoteCardGrid.vue'

const learnMock = runLearn as ReturnType<typeof vi.fn>

enableAutoUnmount(afterEach)

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

/** N 条金句候选（出处逐条唯一，避免 quoteKey 撞键） */
function many(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    场景: '战斗',
    正文: `第${i + 1}条金句正文`,
    出处: `第${i + 1}章`,
    章号: i + 1,
  }))
}

describe('四轮重评 P3-19: QuoteCardGrid 渲染帽', () => {
  it('超 100 条只渲染前 100 张；「显示剩余」展开后全量、钮消失；计数面向全量', async () => {
    learnMock.mockResolvedValueOnce({ samples: [], quotes: many(120) })
    const store = useLearnStore()
    await store.harvest('book1')

    const w = mount(QuoteCardGrid)
    await flushPromises()
    expect(w.findAll('.quote-card')).toHaveLength(100) // 渲染帽生效
    expect(w.find('.expand-more').text()).toContain('显示剩余 20 条')
    expect(w.find('.sec-count').text()).toBe('120') // 数据面不动：区头计数仍全量

    await w.find('.expand-more').trigger('click')
    expect(w.findAll('.quote-card')).toHaveLength(120)
    expect(w.find('.expand-more').exists()).toBe(false)
    w.unmount()
  })

  it('100 条内（帽边界）无展开钮，全量渲染', async () => {
    learnMock.mockResolvedValueOnce({ samples: [], quotes: many(100) })
    const store = useLearnStore()
    await store.harvest('book1')

    const w = mount(QuoteCardGrid)
    await flushPromises()
    expect(w.findAll('.quote-card')).toHaveLength(100)
    expect(w.find('.expand-more').exists()).toBe(false)
    w.unmount()
  })

  it('展开态跨收割重置：重跑收割（loading 落 false）回到 100 张上限（R0912-3 #23 同款）', async () => {
    learnMock.mockResolvedValueOnce({ samples: [], quotes: many(120) })
    const store = useLearnStore()
    await store.harvest('book1')

    const w = mount(QuoteCardGrid)
    await flushPromises()
    await w.find('.expand-more').trigger('click')
    expect(w.findAll('.quote-card')).toHaveLength(120)

    learnMock.mockResolvedValueOnce({ samples: [], quotes: many(120) })
    await store.harvest('book1')
    await flushPromises()
    expect(w.findAll('.quote-card')).toHaveLength(100) // 展开态已清，回渲染帽
    expect(w.find('.expand-more').exists()).toBe(true)
    w.unmount()
  })
})
