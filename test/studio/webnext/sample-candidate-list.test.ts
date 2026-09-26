// @vitest-environment happy-dom
/**
 * SampleCandidateList（样章候选区）行为族——按行为合并两散落文件
 * （原 r0912-3-sample-expand-reset + rp2-6-sample-candidate-key，真 learn store 同装置）。
 *
 * - R0912-3 #23（2026-09-12 全量代码重评修复批）：expandedGroups 跨收割重置。组件实例
 *   随 LearnView 常驻，上一轮手动「显示剩余」展开的大组在新收割数据上仍全量渲染；
 *   修后收割跑完（learn.loading 落 false）即清展开态。
 * - R-P2-6（评审修复批）：v-for key 去正文化。原键 `出处\u0000正文` 含整章正文（列表
 *   diff 时巨串逐项比较放大开销），且同组「同出处+同正文」两条候选同 key（Vue keyed
 *   diff 抛 "Duplicate keys found during update" 告警，属正确性边角）。新键
 *   `场景\u0000出处\u0000组内全量下标`（下标来自分组 computed 内排序后的全量 items，
 *   非 visibleItems 可见切片）。两条红线：组内键唯一（白盒读 key 字段）；列表 keyed
 *   diff 全程（挂载 + 筛选切换收缩/回扩）零 duplicate key 告警。
 */
import { describe, it, expect, beforeEach, vi, afterEach, type MockInstance } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import SampleCandidateList from '../../../src/studio/web-next/src/components/learn/SampleCandidateList.vue'
import { useLearnStore } from '../../../src/studio/web-next/src/stores/learn'
import { runLearn } from '../../../src/studio/web-next/src/api/learn'
import type { SampleCandidateFE } from '../../../src/studio/web-next/src/api/learn'

vi.mock('../../../src/studio/web-next/src/api/learn', () => ({
  runLearn: vi.fn(),
  runLearnCommit: vi.fn(),
}))

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

function sample(场景: string, 出处: string, 正文: string, 打分: number): SampleCandidateFE {
  return { 场景, 出处, 正文, 打分, 章号: 1 }
}

/** console.warn 中是否出现 duplicate key 告警（Vue keyed diff 更新期文案） */
function hasDuplicateKeyWarn(warnSpy: MockInstance<typeof console.warn>): boolean {
  return warnSpy.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('Duplicate keys'))
}

// ── R0912-3 #23：expandedGroups 跨收割重置 ────────────────────────

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

// ── R-P2-6：候选卡 v-for 键组内唯一（不含整章正文） ────────────────────────

describe('R-P2-6：候选卡 v-for 键组内唯一（不含整章正文）', () => {
  it('同组「同出处+同正文」两条候选键不同；键形态 = 场景\\0出处\\0组内全量下标', () => {
    const learn = useLearnStore()
    // 两条完全同 identity（出处+正文，勾选身份同源）+ 一条同场景异文 + 一条异场景
    learn.samples = [
      sample('战斗', '《书》第1章', '同一段正文', 95),
      sample('战斗', '《书》第1章', '同一段正文', 95),
      sample('战斗', '《书》第2章', '另一段正文', 80),
      sample('日常', '《书》第3章', '日常正文', 70),
    ]
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wrapper = mount(SampleCandidateList)
    expect(wrapper.findAll('.cand-card')).toHaveLength(4)

    // 白盒：setup 绑定经 VTU dev 代理可读——键形态 = 场景\0出处\0组内全量下标，
    // 同打分稳定排序保持插入序（下标 0/1 即全量编号，非可见切片号）
    const groups = (wrapper.vm as unknown as { sampleGroups: { 场景: string; items: { key: string }[] }[] })
      .sampleGroups
    const battle = groups.find((g) => g.场景 === '战斗')!
    expect(battle.items.map((x) => x.key)).toEqual([
      '战斗\u0000《书》第1章\u00000',
      '战斗\u0000《书》第1章\u00001', // 同 identity 两条键不同（旧键方案此处相等）
      '战斗\u0000《书》第2章\u00002',
    ])
    expect(groups.find((g) => g.场景 === '日常')!.items[0]!.key).toBe('日常\u0000《书》第3章\u00000')
    expect(hasDuplicateKeyWarn(warnSpy)).toBe(false)
    warnSpy.mockRestore()
    wrapper.unmount()
  })

  it('筛选切换（全部→仅A级→全部）逼出 keyed diff 全程零 duplicate key 告警', async () => {
    const learn = useLearnStore()
    learn.samples = [
      sample('战斗', '《书》第1章', '同一段正文', 95),
      sample('战斗', '《书》第1章', '同一段正文', 95), // 同 identity 双条：旧键必撞
      sample('战斗', '《书》第2章', '不够 A 级', 60), // 低于 TIER_A=90：切换时列表收缩/回扩
    ]
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wrapper = mount(SampleCandidateList)
    const tabs = wrapper.findAll('.filter-tabs button')
    expect(tabs).toHaveLength(2)

    // 切「仅 A 级」：列表收缩（keyed diff，重建新 key 索引表——重复键在此告警）
    await tabs[1]!.trigger('click')
    expect(wrapper.findAll('.cand-card')).toHaveLength(2)
    // 切回「全部」：列表回扩，再来一次真实 diff
    await tabs[0]!.trigger('click')
    expect(wrapper.findAll('.cand-card')).toHaveLength(3)
    expect(hasDuplicateKeyWarn(warnSpy)).toBe(false)
    warnSpy.mockRestore()
    wrapper.unmount()
  })

  it('分组展开（渲染上限前缀 → 全量）后键仍唯一——切片延展不错位', async () => {
    const learn = useLearnStore()
    // 超过 GROUP_RENDER_CAP=50：造 55 条同场景同出处候选（打分互异稳定排序）
    learn.samples = Array.from({ length: 55 }, (_, i) => sample('战斗', '《书》第1章', `第${i}条正文`, 100 - i))
    const wrapper = mount(SampleCandidateList)
    expect(wrapper.findAll('.cand-card')).toHaveLength(50) // 默认截断
    await wrapper.find('.expand-more').trigger('click')
    expect(wrapper.findAll('.cand-card')).toHaveLength(55)
    const groups = (wrapper.vm as unknown as { sampleGroups: { items: { key: string }[] }[] }).sampleGroups
    const keys = groups[0]!.items.map((it) => it.key)
    expect(new Set(keys).size).toBe(55)
    wrapper.unmount()
  })
})
