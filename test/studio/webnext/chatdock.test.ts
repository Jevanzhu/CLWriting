// @vitest-environment happy-dom
/**
 * ChatDock（书页右下对话坞）草稿语义：实例生命周期与跨书残留。
 *
 * R0912-3 #11（2026-09-12 全量重评修复批）：dock 收起（FAB toggle）不再丢未发送
 * 草稿——.chat-stack 原挂 v-if，收起即卸载 ChatComposer，useChatComposer 的组件
 * 本地 input 随实例销毁，草稿静默丢失（同书内 ChatPanel 输入区是常驻口径）。修法：
 * v-show 保实例（R48-97 豁免理由见 ChatDock 模板注）。
 *
 * R27-76（二十七轮 D 域）：ChatDock 挂 :key="bookName" 切书即重建——根因：无 key
 * 时组件本地 input 跨书残留，A 书打了字没发、切到 B 书后同一份文本直接发进 B 书
 * （handleSend 按发送时刻书名入账）。:key=bookName 令切书销毁重建 dock——输入框
 * 草稿、fabOpen/chatOpen 展开态一并复位。
 *
 * 测法：shallow 挂 WorkspaceShell 但 ChatDock/ChatComposer 用真件（其余子件仍被
 * shallow stub）；R0912-C2-P3-4 起 composer 自 ChatDock 内联模板收敛为子件
 * ChatComposer（input 状态随之在子件），锚定语义不变。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import WorkspaceShell from '../../../src/studio/web-next/src/components/shell/WorkspaceShell.vue'
import ChatDock from '../../../src/studio/web-next/src/components/shell/ChatDock.vue'
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
vi.mock('../../../src/studio/web-next/src/api/workbench', () => ({
  interrupt: mocks.interrupt,
}))
// R0916-7-P3-25：夹具经泛型 set 开 chatEnabled 会排防抖 PUT——mock 掉防真 fetch 冒烟
vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getGlobalPrefs: vi.fn(async () => ({})),
  putGlobalPrefs: vi.fn(async () => ({})),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  for (const m of Object.values(mocks)) m.mockReset()
  usePrefsStore().set('chatEnabled', true) // dock 默认关（R66 开关），测试显式开
})

function mountShell(book: string) {
  const w = mount(WorkspaceShell, {
    props: { bookName: book },
    shallow: true,
    global: { stubs: { ChatDock, ChatComposer } }, // 仅 ChatDock + ChatComposer 用真件，其余子件 shallow stub
  })
  const ws = useWorkspaceStore()
  ws.activeView = 'editor' // dock 显示条件：非 workbench 视图（workbench 有对话 tab 不叠 dock）
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
    expect(await inputValue(w)).toBe('甲书未发送的稿子')

    // 切书：dock 应整体重建（key=bookName）——展开态与输入文本全部复位
    await w.setProps({ bookName: '书乙' })
    await nextTick()
    expect(w.findComponent(ChatDock).exists()).toBe(true)
    expect(w.findAllComponents(ChatDock)).toHaveLength(1) // 旧的销毁、无叠加
    // R0912-3 #11 起 dock composer 常驻（v-show 保实例草稿），收起态改断言不可见；
    // fabOpen 复位为收起 + 重建实例输入为空的语义不变
    expect((w.find('.chat-stack').element as HTMLElement).style.display).toBe('none')

    // 再展开：输入框为空——A 书文本无处可残留，不会误发进 B 书
    await w.find('.fab').trigger('click')
    await nextTick()
    expect(await inputValue(w)).toBe('')
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
    expect(await inputValue(w)).toBe('还在打字')
  })
})
