// @vitest-environment happy-dom
/**
 * R0912-3 #23（2026-09-12 全量代码重评修复批）：样章候选区 expandedGroups 跨收割重置。
 * 组件实例随 LearnView 常驻，上一轮手动「显示剩余」展开的大组在新收割数据上仍全量
 * 渲染；修后收割跑完（learn.loading 落 false）即清展开态。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { afterEach } from 'vitest'

vi.mock('../../../src/studio/web-next/src/api/learn', () => ({
  runLearn: vi.fn(),
  runLearnCommit: vi.fn(),
}))

import { runLearn } from '../../../src/studio/web-next/src/api/learn'
import { useLearnStore } from '../../../src/studio/web-next/src/stores/learn'
import SampleCandidateList from '../../../src/studio/web-next/src/components/learn/SampleCandidateList.vue'

const learnMock = runLearn as ReturnType<typeof vi.fn>

enableAutoUnmount(afterEach)

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

/** N 条同场景候选（>50 触发分组渲染上限） */
function many(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    场景: '战斗',
    正文: `第${i + 1}条候选正文`,
    出处: `第${i + 1}章`,
    章号: i + 1,
    打分: 80,
  }))
}

describe('R0912-3 #23: SampleCandidateList expandedGroups 跨收割重置', () => {
  it('手动展开的大组在重跑收割后回到 50 条渲染上限', async () => {
    learnMock.mockResolvedValueOnce({ samples: many(60), quotes: [] })
    const store = useLearnStore()
    await store.harvest('book1')

    const w = mount(SampleCandidateList)
    await flushPromises()
    expect(w.findAll('.cand-card')).toHaveLength(50) // 渲染上限生效

    // 手动展开 → 全量渲染
    await w.find('.expand-more').trigger('click')
    expect(w.findAll('.cand-card')).toHaveLength(60)
    expect(w.find('.expand-more').exists()).toBe(false)

    // 修复点：重跑收割（loading 落 false）→ 展开态重置，回到 50 条上限
    learnMock.mockResolvedValueOnce({ samples: many(60), quotes: [] })
    await store.harvest('book1')
    await flushPromises()
    expect(w.findAll('.cand-card')).toHaveLength(50)
    expect(w.find('.expand-more').exists()).toBe(true)
    w.unmount()
  })
})
