// @vitest-environment happy-dom
/**
 * R27-76（二十七轮 D 域）回归：ChatDock 挂 :key="bookName" 切书即重建。
 *
 * 根因：WorkspaceShell 里 ChatDock 无 :key——组件本地 input 跨书残留，A 书打了字
 * 没发、切到 B 书后同一份文本直接发进 B 书（handleSend 按发送时刻书名入账）。
 *
 * 语义：:key=bookName 令切书销毁重建 dock——输入框草稿、fabOpen/chatOpen 展开态
 * 一并复位，A 书文本不可能再进 B 书输入框。
 *
 * 测法：shallow 挂 WorkspaceShell 但 ChatDock 用真件（其子件仍被 shallow stub），
 * 展开输入框写入文本后改 bookName prop，断言 dock 重建（输入框关闭，再展开为空）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import WorkspaceShell from '../../../src/studio/web-next/src/components/shell/WorkspaceShell.vue'
import ChatDock from '../../../src/studio/web-next/src/components/shell/ChatDock.vue'
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

async function textValue(w: ReturnType<typeof mountShell>): Promise<string> {
  return (w.find('.chat-input').element as HTMLTextAreaElement).value
}

function mountShell(book: string) {
  const w = mount(WorkspaceShell, {
    props: { bookName: book },
    shallow: true,
    global: { stubs: { ChatDock } }, // 仅 ChatDock 用真件，其余子件 shallow stub
  })
  const ws = useWorkspaceStore()
  ws.activeView = 'editor' // dock 显示条件：非 workbench 视图（workbench 有对话 tab 不叠 dock）
  return w
}

describe('R27-76: ChatDock 跨书残留', () => {
  it('A 书输入框有未发送文本 → 切 B 书 dock 重建，文本不带入（修复前直通 B 书输入框）', async () => {
    const w = mountShell('书甲')
    await flushPromises()
    expect(w.findComponent(ChatDock).exists()).toBe(true)

    // 展开 dock 输入框，打进 A 书的稿子
    await w.find('.fab').trigger('click')
    await nextTick()
    expect(w.find('.chat-input').exists()).toBe(true)
    await w.find('.chat-input').setValue('甲书未发送的稿子')
    expect(await textValue(w)).toBe('甲书未发送的稿子')

    // 切书：dock 应整体重建（key=bookName）——展开态与输入文本全部复位
    await w.setProps({ bookName: '书乙' })
    await nextTick()
    expect(w.findComponent(ChatDock).exists()).toBe(true)
    expect(w.findAllComponents(ChatDock)).toHaveLength(1) // 旧的销毁、无叠加
    expect(w.find('.chat-input').exists()).toBe(false) // fabOpen 复位为收起

    // 再展开：输入框为空——A 书文本无处可残留，不会误发进 B 书
    await w.find('.fab').trigger('click')
    await nextTick()
    expect(await textValue(w)).toBe('')
  })

  it('同书内普通重渲染不重建 dock（key 不误伤：输入中状态保留）', async () => {
    const w = mountShell('书甲')
    await flushPromises()
    await w.find('.fab').trigger('click')
    await nextTick()
    await w.find('.chat-input').setValue('还在打字')

    // 同书的外壳状态变化（收展左栏）触发重渲染，key 未变 → dock 实例保留
    const ws = useWorkspaceStore()
    ws.leftOpen = !ws.leftOpen
    await nextTick()
    expect(w.find('.chat-input').exists()).toBe(true)
    expect(await textValue(w)).toBe('还在打字')
  })
})
