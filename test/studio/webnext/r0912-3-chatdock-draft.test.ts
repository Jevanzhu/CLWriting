// @vitest-environment happy-dom
/**
 * R0912-3 #11（2026-09-12 全量重评修复批）回归：dock 收起（FAB toggle）不再丢
 * 未发送草稿。
 *
 * 根因：.chat-stack 原挂 v-if——收起即卸载 ChatComposer，useChatComposer 的组件
 * 本地 input 随实例销毁，草稿静默丢失（同书内 ChatPanel 输入区是常驻口径）。
 * 修法：v-show 保实例（R48-97 豁免理由见 ChatDock 模板注）。切书跨书残留语义
 * 不变：外层 :key=bookName 整 dock 销毁重建，由 r27-chatdock-rekey 锚定，本文件
 * 不重复覆盖。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import WorkspaceShell from '../../../src/studio/web-next/src/components/shell/WorkspaceShell.vue'
import ChatDock from '../../../src/studio/web-next/src/components/shell/ChatDock.vue'
// composer 为真件（R0912-C2-P3-4 起 input 状态在子件，同 r27-chatdock-rekey 口径）
import ChatComposer from '../../../src/studio/web-next/src/components/panels/chat/ChatComposer.vue'
import { usePrefsStore } from '../../../src/studio/web-next/src/stores/prefs'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'

const mocks = vi.hoisted(() => ({
  sendChat: vi.fn(),
  confirmTool: vi.fn(),
  clearChatHistory: vi.fn(),
  interrupt: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/chat', () => ({
  sendChat: mocks.sendChat,
  confirmTool: mocks.confirmTool,
  clearChatHistory: mocks.clearChatHistory,
}))
vi.mock('../../../src/studio/web-next/src/api/stream', () => ({
  interrupt: mocks.interrupt,
}))

beforeEach(() => {
  setActivePinia(createPinia())
  for (const m of Object.values(mocks)) m.mockReset()
  usePrefsStore().chatEnabled = true // dock 默认关（R66 开关），测试显式开
})

function mountShell(book: string) {
  const w = mount(WorkspaceShell, {
    props: { bookName: book },
    shallow: true,
    global: { stubs: { ChatDock, ChatComposer } }, // 仅 ChatDock + ChatComposer 用真件
  })
  const ws = useWorkspaceStore()
  ws.activeView = 'editor' // dock 显示条件：非 workbench 视图
  return w
}

async function inputValue(w: ReturnType<typeof mountShell>): Promise<string> {
  return (w.find('.chat-input').element as HTMLTextAreaElement).value
}

describe('R0912-3 #11: dock 收起草稿保留', () => {
  it('输入草稿 → FAB 收起 → 再展开，草稿原样在输入框（修复前实例卸载清空）', async () => {
    const w = mountShell('书甲')
    await flushPromises()

    // 展开 → 打草稿
    await w.find('.fab').trigger('click')
    await nextTick()
    expect(w.find('.chat-input').exists()).toBe(true)
    await w.find('.chat-input').setValue('没发完的稿子')
    expect(await inputValue(w)).toBe('没发完的稿子')
    const elBefore = w.find('.chat-input').element

    // 收起：栈隐藏（display:none），但 composer 实例与草稿同存
    await w.find('.fab').trigger('click')
    await nextTick()
    const stack = w.find('.chat-stack')
    expect(stack.exists()).toBe(true)
    expect((stack.element as HTMLElement).style.display).toBe('none')

    // 再展开：草稿还在，且是同一个输入框元素（实例未被重建）
    await w.find('.fab').trigger('click')
    await nextTick()
    expect((stack.element as HTMLElement).style.display).not.toBe('none')
    expect(await inputValue(w)).toBe('没发完的稿子')
    expect(w.find('.chat-input').element).toBe(elBefore)
  })
})
