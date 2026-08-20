// @vitest-environment happy-dom
/**
 * D1（批 4）AI 用量卡片组件测试：
 * - byTask 聚合渲染（任务行/tokens/P50·P95/成功率降序）+ 按日 sparkline
 * - 空态（无调用记录）
 * - D2 金额口径两态：配价显示金额、未配价显示引导（不显示 0）
 * - API 失败 → 空态不炸
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import WbUsageCard from '../../../src/studio/web-next/src/components/workbench/WbUsageCard.vue'

const mocks = vi.hoisted(() => ({
  getTraceStats: vi.fn(),
  getCostStats: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/trace-stats', () => ({
  getTraceStats: mocks.getTraceStats,
}))
vi.mock('../../../src/studio/web-next/src/api/cost-stats', () => ({
  getCostStats: mocks.getCostStats,
}))

const BY_TASK = {
  'self-heal': {
    count: 12,
    successRate: 0.92,
    avgAttempts: 1.2,
    durationP50: 4200,
    durationP95: 9800,
    totalInputTokens: 1_250_000,
    totalOutputTokens: 48_000,
    byDay: { '2026-08-18': { count: 5, successRate: 1, tokens: 1 }, '2026-08-19': { count: 7, successRate: 1, tokens: 1 } },
  },
  outline: {
    count: 3,
    successRate: 0.67,
    avgAttempts: 1,
    durationP50: 800,
    durationP95: 1500,
    totalInputTokens: 12_000,
    totalOutputTokens: 3_000,
    byDay: { '2026-08-19': { count: 3, successRate: 1, tokens: 1 } },
  },
}

describe('WbUsageCard（D1 批 4）', () => {
  beforeEach(() => {
    mocks.getTraceStats.mockReset()
    mocks.getCostStats.mockReset()
  })

  it('byTask 渲染：任务行按次数降序 + tokens/P50·P95/成功率', async () => {
    mocks.getTraceStats.mockResolvedValue({ total: 15, byTask: BY_TASK, ruleHits: [] })
    mocks.getCostStats.mockResolvedValue({ enabled: false, total: 0, byDay: {}, byTask: {}, byChapter: {}, unpricedModels: [] })
    const w = mount(WbUsageCard, { props: { bookName: '测试书' } })
    await flushPromises()
    const text = w.text()
    expect(text).toContain('15 次调用')
    expect(text).toContain('self-heal')
    expect(text).toContain('outline')
    // 降序：self-heal 行在 outline 前
    expect(text.indexOf('self-heal')).toBeLessThan(text.indexOf('outline'))
    expect(text).toContain('1.3M') // tokens 格式化
    expect(text).toContain('4.2s / 9.8s')
    expect(text).toContain('92%')
    // 按日 sparkline（两天 > 1 条柱）
    expect(w.findAll('.usage-bar').length).toBe(2)
  })

  it('空态：无调用记录提示', async () => {
    mocks.getTraceStats.mockResolvedValue({ total: 0, byTask: {}, ruleHits: [] })
    mocks.getCostStats.mockResolvedValue({ enabled: false, total: 0, byDay: {}, byTask: {}, byChapter: {}, unpricedModels: [] })
    const w = mount(WbUsageCard, { props: { bookName: '测试书' } })
    await flushPromises()
    expect(w.text()).toContain('暂无 AI 调用记录')
    expect(w.find('table').exists()).toBe(false)
  })

  it('D2 金额两态：配价显示金额；未配价显示引导不显示 0 金额', async () => {
    mocks.getTraceStats.mockResolvedValue({ total: 15, byTask: BY_TASK, ruleHits: [] })
    mocks.getCostStats.mockResolvedValue({
      enabled: true,
      currency: 'USD',
      total: 1.2345,
      byDay: {},
      byTask: {},
      byChapter: { '3': { cost: 1.2, calls: 10 } },
      unpricedModels: [],
    })
    const w1 = mount(WbUsageCard, { props: { bookName: '测试书' } })
    await flushPromises()
    expect(w1.text()).toContain('1.2345')
    expect(w1.text()).toContain('USD')
    expect(w1.text()).toContain('1 个章节有记账')

    mocks.getCostStats.mockResolvedValue({ enabled: false, total: 0, byDay: {}, byTask: {}, byChapter: {}, unpricedModels: [] })
    const w2 = mount(WbUsageCard, { props: { bookName: '测试书' } })
    await flushPromises()
    expect(w2.text()).toContain('未配置价格表')
    expect(w2.text()).not.toContain('0.0000')
  })

  it('API 失败 → 空态不炸', async () => {
    mocks.getTraceStats.mockRejectedValue(new Error('offline'))
    mocks.getCostStats.mockRejectedValue(new Error('offline'))
    const w = mount(WbUsageCard, { props: { bookName: '测试书' } })
    await flushPromises()
    expect(w.text()).toContain('暂无 AI 调用记录')
  })

  it('切书重拉：bookName prop 变化 → 重取数，旧书用量/金额不残留（Y-P2-3 同类）', async () => {
    mocks.getTraceStats.mockResolvedValueOnce({ total: 15, byTask: BY_TASK, ruleHits: [] })
    mocks.getTraceStats.mockResolvedValueOnce({ total: 2, byTask: { outline: BY_TASK.outline! }, ruleHits: [] })
    mocks.getCostStats.mockResolvedValueOnce({ enabled: true, currency: 'USD', total: 1.2345, byDay: {}, byTask: {}, byChapter: {}, unpricedModels: [] })
    mocks.getCostStats.mockResolvedValueOnce({ enabled: false, total: 0, byDay: {}, byTask: {}, byChapter: {}, unpricedModels: [] })

    const w = mount(WbUsageCard, { props: { bookName: '旧书' } })
    await flushPromises()
    expect(w.text()).toContain('15 次调用')
    expect(w.text()).toContain('1.2345')

    // 切书：WorkbenchView 不加 :key、组件实例复用——此前仅挂载拉一次，
    // 旧书的调用量与金额会残留挂在新书工作台（金额属敏感数据错位）
    await w.setProps({ bookName: '新书' })
    await flushPromises()
    expect(mocks.getTraceStats).toHaveBeenLastCalledWith('新书')
    expect(mocks.getCostStats).toHaveBeenLastCalledWith('新书')
    expect(w.text()).toContain('2 次调用')
    expect(w.text()).not.toContain('15 次调用')
    expect(w.text()).not.toContain('1.2345')
    expect(w.text()).toContain('未配置价格表')
  })
})
