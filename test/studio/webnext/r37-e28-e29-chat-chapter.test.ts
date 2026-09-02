/**
 * R37-28 / R37-29（三十七轮批E）回归：chat store 章号语境。
 *
 * R37-29：followChatChapter 补 undefined 分支——切到非正文文档（细纲/设定无章号，
 * currentChapter() 为 undefined）时原只在有值时赋值，章号语境残留上一章，发送会把
 * 对话挂到错误章上下文。
 * R37-28：clearChapterMemo（删书清理章号显式记忆）——chapterMemo 原无书删除出口，
 * 删书后记忆常驻、同名重建书回填旧书章号语境；useShelf.confirmDelete 删书成功即清
 * 该书记忆，其它书不受牵连。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  deleteBook: vi.fn(),
  clearFalsePositiveMarks: vi.fn(),
  shelfLoad: vi.fn(async () => {}),
}))
vi.mock('../../../src/studio/web-next/src/api/chat', () => ({
  sendChat: vi.fn(),
  clearChatHistory: vi.fn(),
  confirmTool: vi.fn(),
  fetchChatHistory: vi.fn(),
  fetchChatBranches: vi.fn(),
  regenerateChat: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/shelf', () => ({ deleteBook: mocks.deleteBook }))
vi.mock('../../../src/studio/web-next/src/stores/check', () => ({ clearFalsePositiveMarks: mocks.clearFalsePositiveMarks }))
vi.mock('../../../src/studio/web-next/src/stores/shelf', () => ({
  useShelfStore: vi.fn(() => ({ books: [], load: mocks.shelfLoad })),
}))
vi.mock('../../../src/studio/web-next/src/stores/prefs', () => ({
  usePrefsStore: vi.fn(() => ({ shelfView: 'grid', setShelfView: vi.fn() })),
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  apiJson: vi.fn(),
  getToken: vi.fn(() => 'test-token'),
  ApiError: class ApiError extends Error {
    status?: number
    code?: string
    constructor(message: string, status: number, code?: string) {
      super(message)
      this.status = status
      this.code = code
    }
  },
}))

import { useChatStore } from '../../../src/studio/web-next/src/stores/chat'
import { useShelf } from '../../../src/studio/web-next/src/composables/useShelf'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
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
