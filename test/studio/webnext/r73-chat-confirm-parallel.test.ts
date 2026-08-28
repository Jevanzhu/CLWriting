// @vitest-environment happy-dom
/**
 * R73-64（二十一轮批 E）回归：ChatMessages 工具确认防重粒度。
 *
 * 修复前 confirmingCallId 单值把所有待确认卡串行化——多张待确认卡并存时，第二张的
 * 点击被入口静默忽略（按钮未禁但毫无反应）。修复后按 callId 记在途集合（Set 重赋值
 * 触发响应）：同卡防重、跨卡并行；在途仅禁本卡按钮。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import ChatMessages from '../../../src/studio/web-next/src/components/panels/chat/ChatMessages.vue'
import { useChatStore } from '../../../src/studio/web-next/src/stores/chat'

const mocks = vi.hoisted(() => ({
  confirmTool: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/chat', () => ({
  confirmTool: mocks.confirmTool,
}))

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.confirmTool.mockReset()
})

/** 两张待确认卡（两条助手消息各挂一张 pending 工具卡） */
function mountTwoPending() {
  const chat = useChatStore()
  chat.messages.push(
    {
      id: 'm1',
      role: 'assistant',
      content: '第一张',
      done: true,
      tools: [{ callId: 'c1', name: 'write_chapter', input: {}, status: 'pending' }],
    },
    {
      id: 'm2',
      role: 'assistant',
      content: '第二张',
      done: true,
      tools: [{ callId: 'c2', name: 'check_chapter', input: {}, status: 'pending' }],
    },
  )
  const w = mount(ChatMessages, { props: { bookName: 'test-book' } })
  return { w, chat }
}

describe('R73-64: 工具确认按 callId 防重（同卡防重、跨卡并行）', () => {
  it('同卡双击 → confirmTool 只发一次（防重保留）', async () => {
    let resolveC1!: (v: unknown) => void
    mocks.confirmTool.mockImplementationOnce(() => new Promise((r) => (resolveC1 = r)))
    const { w } = mountTwoPending()
    await nextTick()

    const yes = w.findAll('.chat-confirm-yes')[0]!
    await yes.trigger('click')
    expect(mocks.confirmTool).toHaveBeenCalledTimes(1)
    await w.findAll('.chat-confirm-yes')[0]!.trigger('click') // 同卡第二击
    expect(mocks.confirmTool).toHaveBeenCalledTimes(1) // 修复点：同卡仍防重
    // 在途反馈：本卡按钮禁用 + 转圈
    expect((w.findAll('.chat-confirm-yes')[0]!.element as HTMLButtonElement).disabled).toBe(true)

    resolveC1({})
    await flushPromises()
    expect((w.findAll('.chat-confirm-yes')[0]!.element as HTMLButtonElement).disabled).toBe(false) // 失败可重试（非 404 静默重置后按钮恢复）
    w.unmount()
  })

  it('跨卡并行：卡 A 确认在途 → 卡 B 可独立确认（修复前第二张点击被静默忽略）', async () => {
    let resolveC1!: (v: unknown) => void
    let resolveC2!: (v: unknown) => void
    mocks.confirmTool
      .mockImplementationOnce(() => new Promise((r) => (resolveC1 = r)))
      .mockImplementationOnce(() => new Promise((r) => (resolveC2 = r)))
    const { w } = mountTwoPending()
    await nextTick()

    await w.findAll('.chat-confirm-yes')[0]!.trigger('click') // 卡 A（c1）在途
    expect(mocks.confirmTool).toHaveBeenCalledTimes(1)
    expect((w.findAll('.chat-confirm-yes')[0]!.element as HTMLButtonElement).disabled).toBe(true) // A 在途禁
    expect((w.findAll('.chat-confirm-yes')[1]!.element as HTMLButtonElement).disabled).toBe(false) // B 不受牵连

    await w.findAll('.chat-confirm-yes')[1]!.trigger('click') // 卡 B（c2）并行确认
    expect(mocks.confirmTool).toHaveBeenCalledTimes(2) // 修复点：跨卡放行
    expect(mocks.confirmTool).toHaveBeenNthCalledWith(1, 'test-book', { callId: 'c1', ok: true })
    expect(mocks.confirmTool).toHaveBeenNthCalledWith(2, 'test-book', { callId: 'c2', ok: true })

    resolveC1({})
    resolveC2({})
    await flushPromises()
    w.unmount()
  })

  it('失败重试：c1 确认失败（非 404）后同卡可再点', async () => {
    const { ApiError } = await import('../../../src/studio/web-next/src/api/client')
    mocks.confirmTool
      .mockRejectedValueOnce(new ApiError('boom', 500))
      .mockResolvedValueOnce({})
    const { w } = mountTwoPending()
    await nextTick()

    await w.findAll('.chat-confirm-yes')[0]!.trigger('click')
    await flushPromises()
    expect((w.findAll('.chat-confirm-yes')[0]!.element as HTMLButtonElement).disabled).toBe(false)

    await w.findAll('.chat-confirm-yes')[0]!.trigger('click') // 重试成功
    await flushPromises()
    expect(mocks.confirmTool).toHaveBeenCalledTimes(2)
    w.unmount()
  })
})
