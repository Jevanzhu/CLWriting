// @vitest-environment happy-dom
/**
 * R-P2-6（评审修复批）：SampleCandidateList v-for key 去正文化回归。
 *
 * 原键 `出处\u0000正文` 含整章正文（列表 diff 时巨串逐项比较放大开销），且同组
 * 「同出处+同正文」两条候选同 key（Vue keyed diff 抛 "Duplicate keys found during
 * update" 告警，属正确性边角）。新键 `场景\u0000出处\u0000组内全量下标`（下标来自
 * 分组 computed 内排序后的全量 items，非 visibleItems 可见切片）。
 *
 * 本文件锚定两条红线：
 * 1. 组内键唯一（白盒读 sampleGroups 的 key 字段，重复候选 + 过滤/分组各形态全覆盖）；
 * 2. 列表 keyed diff 全程（挂载 + 筛选切换收缩/回扩）零 duplicate key 告警——
 *    旧键方案在本场景必触发 Vue 告警（Vue 仅在更新期 keyed diff 建新索引表时告警，
 *    故用筛选切换逼出真实 diff，而非只看首挂）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SampleCandidateList from '../../../src/studio/web-next/src/components/learn/SampleCandidateList.vue'
import { useLearnStore } from '../../../src/studio/web-next/src/stores/learn'
import type { SampleCandidateFE } from '../../../src/studio/web-next/src/api/learn'

function sample(场景: string, 出处: string, 正文: string, 打分: number): SampleCandidateFE {
  return { 场景, 出处, 正文, 打分, 章号: 1 }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

/** console.warn 中是否出现 duplicate key 告警（Vue keyed diff 更新期文案） */
function hasDuplicateKeyWarn(warnSpy: ReturnType<typeof vi.spyOn>): boolean {
  return warnSpy.mock.calls.some(
    (c) => typeof c[0] === 'string' && c[0].includes('Duplicate keys'),
  )
}

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
    learn.samples = Array.from({ length: 55 }, (_, i) =>
      sample('战斗', '《书》第1章', `第${i}条正文`, 100 - i),
    )
    const wrapper = mount(SampleCandidateList)
    expect(wrapper.findAll('.cand-card')).toHaveLength(50) // 默认截断
    await wrapper.find('.expand-more').trigger('click')
    expect(wrapper.findAll('.cand-card')).toHaveLength(55)
    const groups = (wrapper.vm as unknown as { sampleGroups: { items: { key: string }[] }[] })
      .sampleGroups
    const keys = groups[0]!.items.map((it) => it.key)
    expect(new Set(keys).size).toBe(55)
    wrapper.unmount()
  })
})
