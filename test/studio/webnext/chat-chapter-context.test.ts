// @vitest-environment happy-dom
/**
 * chat 章号语境（chat store 单一事实源）——按行为合并两散落文件
 * （原 r35-chat-selected-chapter + r37-e28-e29-chat-chapter）。
 *
 * - R35-11（三十五轮）：对话章号语境单一事实源。修复前 ChatDock 与 ChatPanel 各建一份
 *   useChatComposer 实例（dock 开窗时双实例并存），selectedChapter 互不同步——「重新
 *   生成」按 ChatPanel 那份带错章号语境；且 currentChapter watch 无条件覆盖（v!==undefined），
 *   用户显式选「全书」后被静默改回。修复后：选择上提 chat store（dock/工作台/ChatMessages
 *   regenerate 同源）；显式选择落本书记忆后 currentChapter 不再覆盖；切书（chat.clear）
 *   复位到目标书记忆值。
 * - R37-29（三十七轮批E）：followChatChapter 补 undefined 分支——切到非正文文档（细纲/
 *   设定无章号）时章号语境清空，不残留上一章。
 * - R37-28：clearChapterMemo（删书清理章号显式记忆）——chapterMemo 原无书删除出口，
 *   删书后记忆常驻、同名重建书回填旧书章号语境；useShelf.confirmDelete 删书成功即清
 *   该书记忆，其它书不受牵连。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import ChatPanel from '../../../src/studio/web-next/src/components/panels/ChatPanel.vue'
import ChatDock from '../../../src/studio/web-next/src/components/shell/ChatDock.vue'
import { useChatStore } from '../../../src/studio/web-next/src/stores/chat'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'

const mocks = vi.hoisted(() => ({
  sendChat: vi.fn(),
  confirmTool: vi.fn(),
  clearChatHistory: vi.fn(),
  interrupt: vi.fn(),
  deleteBook: vi.fn(),
  clearFalsePositiveMarks: vi.fn(),
  shelfLoad: vi.fn(async () => {}),
}))

vi.mock('../../../src/studio/web-next/src/api/chat', () => ({
  sendChat: mocks.sendChat,
  confirmTool: mocks.confirmTool,
  clearChatHistory: mocks.clearChatHistory,
  fetchChatHistory: vi.fn(),
  fetchChatBranches: vi.fn(),
  regenerateChat: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/workbench', () => ({
  interrupt: mocks.interrupt,
}))

vi.mock('../../../src/studio/web-next/src/api/shelf', () => ({ deleteBook: mocks.deleteBook }))
vi.mock('../../../src/studio/web-next/src/stores/check', () => ({
  clearFalsePositiveMarks: mocks.clearFalsePositiveMarks,
  fpBookPrefix: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/stores/shelf', () => ({
  useShelfStore: vi.fn(() => ({ books: [], load: mocks.shelfLoad })),
}))
vi.mock('../../../src/studio/web-next/src/stores/prefs', () => ({
  usePrefsStore: vi.fn(() => ({ shelfView: 'grid', setShelfView: vi.fn() })),
}))
// 重评-0914-三轮 nano R7-1：ApiError 本地复刻收编——工厂改 importOriginal 展开，真类单源 src/studio/web-next/src/api/client.ts
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return {
    ...actual,
    apiJson: vi.fn(),
    getToken: vi.fn(() => 'test-token'),
  }
})

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

import { useShelf } from '../../../src/studio/web-next/src/composables/useShelf'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

function seedDonePair(chat: ReturnType<typeof useChatStore>): void {
  chat.messages.push(
    { id: 'u1', role: 'user', content: '写一段', done: true, tools: [], seq: 1 },
    { id: 'a1', role: 'assistant', content: '答案', done: true, tools: [], seq: 2 },
  )
}

/** 经章节菜单点选（真实 UI 路径） */
async function pickChapter(w: ReturnType<typeof mount>, label: string): Promise<void> {
  await w.find('.composer-chapter').trigger('click')
  const item = w.findAll('.chapter-menu-item').find((b) => b.text() === label)
  if (!item) throw new Error(`菜单项不存在：${label}`)
  await item.trigger('click')
  await nextTick()
}

// ── R35-11：章号语境单一事实源（组件面） ────────────────────────

describe('R35-11: 章号语境单一事实源', () => {
  it('dock 选章 → 同书 ChatPanel 的 regenerate 携所选章号（双实例不再分裂）', async () => {
    const chat = useChatStore()
    seedDonePair(chat)
    // dock（编辑器视图输入框）用户在第 3 章语境下显式选「第 3 章」（输入框在 FAB 之后）
    const dock = mount(ChatDock, { props: { bookName: '书A', currentChapter: 3 } })
    await dock.find('.fab').trigger('click')
    await pickChapter(dock, '第 3 章')
    expect(chat.selectedChapter).toBe(3)

    // dock 开窗内嵌的 ChatPanel（hide-composer，仍自建 composer 实例）→ regenerate 读同源
    const panel = mount(ChatPanel, { props: { bookName: '书A', currentChapter: 3, hideComposer: true } })
    const regen = vi.spyOn(chat, 'regenerate').mockResolvedValue(undefined)
    await panel.find('.chat-regen-btn').trigger('click')
    expect(regen).toHaveBeenCalledWith('书A', 3)
    dock.unmount()
    panel.unmount()
  })

  it('显式选「全书」后 currentChapter 变化不再覆盖（手动选择保护）', async () => {
    const chat = useChatStore()
    const w = mount(ChatPanel, { props: { bookName: '书A', currentChapter: 3 } })
    // 初值跟随当前章（原行为保持）
    expect(chat.selectedChapter).toBe(3)
    await pickChapter(w, '全书')
    expect(chat.selectedChapter).toBeUndefined()

    await w.setProps({ currentChapter: 7 })
    await nextTick()
    expect(chat.selectedChapter).toBeUndefined() // 修复点：不被静默改回具体章号
    w.unmount()
  })

  it('无显式选择 → currentChapter 变化照常跟随（跟随语义不回归）', async () => {
    const chat = useChatStore()
    const w = mount(ChatPanel, { props: { bookName: '书A', currentChapter: 3 } })
    await w.setProps({ currentChapter: 5 })
    await nextTick()
    expect(chat.selectedChapter).toBe(5)
    w.unmount()
  })

  it('切书（chat.clear）→ 复位到目标书记忆值；显式「全书」记忆同样保留', async () => {
    const chat = useChatStore()
    const ws = useWorkspaceStore()
    const w = mount(ChatPanel, { props: { bookName: '书A', currentChapter: 3 } })
    await pickChapter(w, '第 3 章')
    expect(chat.selectedChapter).toBe(3)

    // A→B：B 无记忆 → 复位「全书」（随后的 currentChapter 跟随照常）
    ws.bookName = '书B'
    chat.clear()
    expect(chat.selectedChapter).toBeUndefined()
    chat.followChatChapter('书B', 9)
    expect(chat.selectedChapter).toBe(9)

    // B→A：A 的显式记忆（第 3 章）恢复，且不被 currentChapter 覆盖
    ws.bookName = '书A'
    chat.clear()
    expect(chat.selectedChapter).toBe(3)
    chat.followChatChapter('书A', 9)
    expect(chat.selectedChapter).toBe(3)

    // 显式「全书」也是记忆：不被覆盖
    const w2 = mount(ChatPanel, { props: { bookName: '书C', currentChapter: 2 } })
    await pickChapter(w2, '全书')
    ws.bookName = '书D'
    chat.clear()
    ws.bookName = '书C'
    chat.clear()
    expect(chat.selectedChapter).toBeUndefined()
    chat.followChatChapter('书C', 4)
    expect(chat.selectedChapter).toBeUndefined()
    w.unmount()
    w2.unmount()
  })
})

// ── R37-29：followChatChapter 的 undefined 分支 ────────────────────────

describe('R37-29: 切非正文文档清空章号语境', () => {
  it('正文章 → 切细纲（current=undefined）→ selectedChapter 清空（不残留上一章）', () => {
    const chat = useChatStore()
    chat.followChatChapter('书A', 5) // 正文第 5 章
    expect(chat.selectedChapter).toBe(5)
    // 修复点：非正文文档无章语境 → undefined（修复前残留 5，发送带错章上下文）
    chat.followChatChapter('书A', undefined)
    expect(chat.selectedChapter).toBe(undefined)
  })

  it('显式选择记忆（含显式「全书」）不被跟随覆盖（R35-11 语义不回归）', () => {
    const chat = useChatStore()
    chat.selectChatChapter('书A', 3) // 显式选第 3 章（落记忆）
    chat.followChatChapter('书A', 9)
    expect(chat.selectedChapter).toBe(3)
    chat.followChatChapter('书A', undefined)
    expect(chat.selectedChapter).toBe(3)
    chat.selectChatChapter('书A', undefined) // 显式选「全书」
    chat.followChatChapter('书A', 9)
    expect(chat.selectedChapter).toBe(undefined)
  })

  it('undefined 跟随后再回正文章 → 跟随恢复（清空不是单向门）', () => {
    const chat = useChatStore()
    chat.followChatChapter('书A', 2)
    chat.followChatChapter('书A', undefined)
    chat.followChatChapter('书A', 7)
    expect(chat.selectedChapter).toBe(7)
  })
})

// ── R37-28：clearChapterMemo + 删书清理 ────────────────────────

describe('R37-28: 删书清理章号显式记忆（只清该书）', () => {
  it('store 面：两书记忆 + 清一书 → 只清该书，另一书不受牵连', () => {
    const chat = useChatStore()
    chat.selectChatChapter('书A', 3)
    chat.selectChatChapter('书B', 5)
    chat.clearChapterMemo('书A')
    // A 记忆已清：跟随不再被 A 的旧记忆挡住
    chat.followChatChapter('书A', 9)
    expect(chat.selectedChapter).toBe(9)
    // B 记忆仍在：跟随被 B 的记忆挡住（selectedChapter 不随 B 的跟随变化）
    chat.followChatChapter('书B', 7)
    expect(chat.selectedChapter).toBe(9)
  })

  it('组件面：useShelf.confirmDelete 删书成功 → 连带清该书章号记忆', async () => {
    mocks.deleteBook.mockResolvedValue(undefined)
    const chat = useChatStore()
    chat.selectChatChapter('书A', 3)
    chat.selectChatChapter('书B', 5)

    const s = useShelf()
    s.requestDelete(['书A'])
    await s.confirmDelete()

    expect(mocks.deleteBook).toHaveBeenCalledWith('书A')
    // 书A 记忆随删书清理（同名重建书不回填旧章号语境）
    chat.followChatChapter('书A', 12)
    expect(chat.selectedChapter).toBe(12)
    // 书B 记忆保留：跟随被 B 的记忆挡住
    chat.followChatChapter('书B', 12)
    expect(chat.selectedChapter).toBe(12)
  })

  it('删除失败 → 记忆不清（书未删成，选择不能丢）', async () => {
    mocks.deleteBook.mockRejectedValue(new Error('server 500'))
    const chat = useChatStore()
    chat.selectChatChapter('书A', 3)

    const s = useShelf()
    s.requestDelete(['书A'])
    await s.confirmDelete()

    chat.followChatChapter('书A', 9)
    expect(chat.selectedChapter).toBe(3) // 记忆仍在
  })
})
