// @vitest-environment happy-dom
/**
 * R36-25（三十六轮）：AuditView load 无 script 层代守卫——当前被模板禁用态
 * （:disabled="loading"）封死，属可维护性修复：置 unmounted 标记，load/loadMore 的
 * await 回调落点前复检吞掉（防未来移除禁用态/新增自动刷新后失守：卸载后迟到响应
 * 仍回写 refs、catch 仍置 err/toast 面）。
 *
 * 观测面：load 失败路径的 friendlyError 调用（卸载后迟到失败不再调用 = 守卫生
 * 效）；加载成功路径数据落地照常；未卸载路径不误伤。
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

const EMPTY_PAYLOAD = {
  conversation: { modelVisible: [], humanVisible: [], shadowedCount: 0, events: [], eventsTotal: 0 },
  workflowEvents: [],
  workflowTotal: 0,
  goals: [],
  todos: [],
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.getAudit.mockResolvedValue(EMPTY_PAYLOAD)
})

describe('R36-25：AuditView load 存活守卫', () => {
  it('加载失败 settle 在卸载后 → 不回写 err（修复前 friendlyError 仍被调用）', async () => {
    const req = pending<unknown>()
    mocks.getAudit.mockReturnValue(req.promise)

    const wrapper = mount(AuditView, { props: { bookName: '测试书' } })
    await flushPromises()
    expect(mocks.getAudit).toHaveBeenCalledTimes(1)

    wrapper.unmount()
    req.reject(new Error('服务端挂了'))
    await flushPromises()

    // 修复点：卸载后迟到失败不触发 friendlyError / err 回写
    expect(mocks.friendlyError).not.toHaveBeenCalled()
  })

  it('加载成功 settle 在卸载后 → 未卸载的正常路径不误伤（数据照常落地）', async () => {
    const wrapper = mount(AuditView, { props: { bookName: '测试书' } })
    await flushPromises()
    // 空数据正常落地：标题渲染 + 事件重放区空态
    expect(wrapper.text()).toContain('事件审计')
    expect(wrapper.text()).toContain('暂无事件')
    wrapper.unmount()
  })

  it('未卸载失败 → 错误照常展示（不误伤）', async () => {
    mocks.getAudit.mockRejectedValue(new Error('boom'))
    const wrapper = mount(AuditView, { props: { bookName: '测试书' } })
    await flushPromises()
    expect(mocks.friendlyError).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('boom')
    wrapper.unmount()
  })

  it('刷新在途卸载 → 迟到成功不回写 loading（loading 不残留卡死渲染面）', async () => {
    const req = pending<unknown>()
    let first = true
    mocks.getAudit.mockImplementation(() => {
      if (first) {
        first = false
        return Promise.resolve(EMPTY_PAYLOAD)
      }
      return req.promise
    })
    const wrapper = mount(AuditView, { props: { bookName: '测试书' } })
    await flushPromises()

    // 刷新按钮触发第二次 load（在途）
    await wrapper.find('.reload-btn:not(.danger)').trigger('click')
    await flushPromises()
    expect(mocks.getAudit).toHaveBeenCalledTimes(2)

    wrapper.unmount()
    req.resolve(EMPTY_PAYLOAD)
    await flushPromises()
    // 卸载后迟到成功：无异常、friendlyError 未调用（注册表无残留）
    expect(mocks.friendlyError).not.toHaveBeenCalled()
  })
})