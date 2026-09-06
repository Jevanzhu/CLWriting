// @vitest-environment happy-dom
/**
 * R57-F-1（五十七轮）：AuditView 续页 catch 漏 loadGen 复检——loadMoreConvo/loadMoreWorkflow
 * 的成功路径已有 R48-23 代数复检（gen !== loadGen 不得拼入已重置列表），但 catch 只查
 * alive（R36-25）：续页在途时点「刷新」，load() 清列表递增代数后，迟到的续页失败仍会把
 * 错误态（err 回写）写到已被新刷新取代的视图上（新代成功数据顶着旧错误横幅）。
 *
 * 观测面：作废代数的迟到失败不再触发 friendlyError / 不回写 err；未刷新的正常失败路径
 * 不误伤（错误照常展示）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  getAudit: vi.fn(),
  clearAudit: vi.fn(),
  friendlyError: vi.fn((e: unknown) => String((e as Error).message ?? e)),
}))
vi.mock('../../../src/studio/web-next/src/api/audit', () => ({
  getAudit: mocks.getAudit,
  clearAudit: mocks.clearAudit,
}))
vi.mock('../../../src/studio/web-next/src/shared/error', () => ({
  friendlyError: mocks.friendlyError,
}))

import AuditView from '../../../src/studio/web-next/src/views/AuditView.vue'

function pending<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 每页 500 条（与组件 PAGE_LIMIT 对齐）、总 600：首屏满页后「加载更多」入口可见 */
const TOTAL = 600

function ev(i: number): { seq: number; type: string; data: Record<string, unknown>; shadowed: boolean } {
  return { seq: i, type: 'user/message', data: { message: `事件${i}` }, shadowed: false }
}

function page(n: number) {
  return {
    conversation: {
      modelVisible: [],
      humanVisible: [],
      shadowedCount: 0,
      events: Array.from({ length: n }, (_, i) => ev(i)),
      eventsTotal: TOTAL,
    },
    workflowEvents: Array.from({ length: n }, (_, i) => ev(i)),
    workflowTotal: TOTAL,
    goals: [],
    todos: [],
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('R57-F-1：AuditView 续页 catch 的代数复检', () => {
  it('convo 续页失败 settle 在刷新后 → 错误态不回写（修复前 friendlyError 被调用 + err 顶着旧横幅）', async () => {
    const moreReq = pending<unknown>()
    let calls = 0
    mocks.getAudit.mockImplementation(() => {
      calls++
      if (calls === 2) return moreReq.promise // 续页在途
      return Promise.resolve(page(500)) // 首屏 / 期间刷新（新代首屏）
    })

    const wrapper = mount(AuditView, { props: { bookName: '测试书' } })
    await flushPromises()
    expect(mocks.getAudit).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.load-more').exists()).toBe(true)

    // 续页开工（在途）
    await wrapper.find('.load-more').trigger('click')
    expect(mocks.getAudit).toHaveBeenCalledTimes(2)

    // 期间点「刷新」→ load() 递增代数、清列表重取（新代）
    await wrapper.find('.reload-btn:not(.danger)').trigger('click')
    await flushPromises()
    expect(mocks.getAudit).toHaveBeenCalledTimes(3)
    expect(wrapper.find('.audit-err').exists()).toBe(false)

    // 迟到的续页失败此刻才 settle
    moreReq.reject(new Error('续页服务端挂了'))
    await flushPromises()

    // 修复点：作废代数的迟到失败不触发 friendlyError / 不回写 err
    expect(mocks.friendlyError).not.toHaveBeenCalled()
    expect(wrapper.find('.audit-err').exists()).toBe(false)
    wrapper.unmount()
  })

  it('workflow 续页同款：失败 settle 在刷新后 → 错误态不回写', async () => {
    const moreReq = pending<unknown>()
    let calls = 0
    mocks.getAudit.mockImplementation(() => {
      calls++
      if (calls === 2) return moreReq.promise
      return Promise.resolve(page(500))
    })

    const wrapper = mount(AuditView, { props: { bookName: '测试书' } })
    await flushPromises()
    // 切到工作流 tab，工作流续页入口可见
    await wrapper.findAll('.tabbar button')[1]!.trigger('click')
    expect(wrapper.find('.load-more').exists()).toBe(true)

    await wrapper.find('.load-more').trigger('click')
    expect(mocks.getAudit).toHaveBeenCalledTimes(2)

    await wrapper.find('.reload-btn:not(.danger)').trigger('click')
    await flushPromises()
    expect(wrapper.find('.audit-err').exists()).toBe(false)

    moreReq.reject(new Error('工作流续页挂了'))
    await flushPromises()

    expect(mocks.friendlyError).not.toHaveBeenCalled()
    expect(wrapper.find('.audit-err').exists()).toBe(false)
    wrapper.unmount()
  })

  it('未刷新的续页失败 → 错误照常展示（守卫不误伤正常报错路径）', async () => {
    let calls = 0
    mocks.getAudit.mockImplementation(() => {
      calls++
      if (calls === 1) return Promise.resolve(page(500))
      return Promise.reject(new Error('续页服务端挂了'))
    })

    const wrapper = mount(AuditView, { props: { bookName: '测试书' } })
    await flushPromises()
    await wrapper.find('.load-more').trigger('click')
    await flushPromises()

    expect(mocks.friendlyError).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.audit-err').exists()).toBe(true)
    expect(wrapper.text()).toContain('续页服务端挂了')
    wrapper.unmount()
  })
})
