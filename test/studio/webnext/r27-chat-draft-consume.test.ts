// @vitest-environment happy-dom
/**
 * R27-75（二十七轮 D 域）回归：失败草稿「先删后查」。
 *
 * 根因：restoreFailedDraft 里 failedDrafts.delete(book) 在输入框判空前执行——
 * stash 存在即无条件销毁，回填却以「输入框为空」为前提；回切时输入框已有新输入
 * （切书期间在 dock/面板里打了字）反而永久删稿，违背 R66-33 找回语义。
 *
 * 语义：delete 移入「确实回填了」分支——输入框非空时 stash 保留，等下次输入框
 * 为空的取书时机再回填；空输入框回切的即时回填行为不变（对照用例）。
 *
 * 测法：ChatPanel（不重建的常驻实例，走 composable watch 路径）+ sendChat 延迟
 * reject 制造「失败时已切书」，setProps 模拟切书时序，断言草稿存活与延迟回填。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import ChatPanel from '../../../src/studio/web-next/src/components/panels/ChatPanel.vue'
import { useChatStore } from '../../../src/studio/web-next/src/stores/chat'
import { clearFailedDrafts } from '../../../src/studio/web-next/src/composables/useChatComposer'

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
vi.mock('../../../src/studio/web-next/src/composables/useChatTier', () => ({
  useChatTier: () => ({
    chatTier: null,
    activeModel: 'test-model',
    activeEffort: 'low',
    models: ['test-model'],
    tierLoading: false,
    onModelChange: vi.fn(),
    onEffortChange: vi.fn(),
  }),
  EFFORT_LEVELS: ['low', 'medium', 'high'],
}))

/** 只用到 reject 的延迟 Promise（控制「await 窗口内切书」时序，照 r66-frontend-guards 范型） */
function deferredReject(): { reject: (e: Error) => void } {
  let reject!: (e: Error) => void
  new Promise<never>((_res, rej) => {
    reject = rej
  })
  return { reject }
}

const BOOK = '书R27甲'

async function stashDraftViaSwitchedFail(w: ReturnType<typeof mountChatPanel>): Promise<void> {
  const d = deferredReject()
  mocks.sendChat.mockImplementation(
    () =>
      new Promise((_res, rej) => {
        d.reject = rej
      }),
  )
  const textarea = w.find('.chat-input')
  await textarea.setValue('救命文稿')
  await textarea.trigger('keydown', { key: 'Enter' })
  await flushPromises() // sendChat 挂起中
  await w.setProps({ bookName: '书R27乙' }) // 失败返回前切书
  d.reject(new Error('发送炸了'))
  await flushPromises() // 草稿已存（书名守卫拦下 popUser）
  expect(useChatStore().error).toBeNull()
}

function mountChatPanel(book: string) {
  return mount(ChatPanel, { props: { bookName: book } })
}

async function inputText(w: ReturnType<typeof mountChatPanel>): Promise<string> {
  return (w.find('.chat-input').element as HTMLTextAreaElement).value
}

beforeEach(() => {
  setActivePinia(createPinia())
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.confirmTool.mockResolvedValue(undefined)
  mocks.clearChatHistory.mockResolvedValue(undefined)
  mocks.interrupt.mockResolvedValue(undefined)
  clearFailedDrafts(BOOK) // module 级 Map 跨用例残留清扫
})

describe('R27-75: 失败草稿先删后查（回填与消费绑定）', () => {
  it('回切时输入框已有新输入 → 不销毁草稿；输入框清空后再切回 → 补回填', async () => {
    const w = mountChatPanel(BOOK)
    await stashDraftViaSwitchedFail(w)

    // 切书期间已打新字（R27-76 前的 dock 常驻形态 / 工作台 tab ChatPanel 即此形态）
    await w.find('.chat-input').setValue('乙书新输入')
    await w.setProps({ bookName: BOOK }) // 回切原书 → watch 触发 restoreFailedDraft
    await nextTick()
    // 修复前：stash 被无条件 delete，原文稿永久丢失
    expect(await inputText(w)).toBe('乙书新输入') // 新输入不被覆盖

    // 新输入发走（输入框清空）→ 下次取书时机补回填
    await w.find('.chat-input').setValue('')
    await w.setProps({ bookName: '书R27乙' })
    await nextTick()
    await w.setProps({ bookName: BOOK })
    await nextTick()
    expect(await inputText(w)).toBe('救命文稿')
  })

  it('输入框为空时回切 → 照旧立即回填且只消费一次（对照：即时回填语义不变）', async () => {
    const w = mountChatPanel(BOOK)
    await stashDraftViaSwitchedFail(w)

    await w.setProps({ bookName: BOOK }) // 空输入框回切
    await nextTick()
    expect(await inputText(w)).toBe('救命文稿')

    // 已消费：再切走切回不重复回填
    await w.find('.chat-input').setValue('')
    await w.setProps({ bookName: '书R27乙' })
    await nextTick()
    await w.setProps({ bookName: BOOK })
    await nextTick()
    expect(await inputText(w)).toBe('')
  })
})
