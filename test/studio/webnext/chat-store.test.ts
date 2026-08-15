/**
 * W3 chat store 单测：事件分派 + 工具卡片状态机 + 历史回合。
 * Y-P2-5：对话历史种子化（空时拉取 / 已有消息不拉取 / 竞态守卫）。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/chat', () => ({
  sendChat: vi.fn(),
  clearChatHistory: vi.fn(),
  confirmTool: vi.fn(),
  fetchChatHistory: vi.fn(),
}))

import { fetchChatHistory, type ChatHistoryMessage } from '../../../src/studio/web-next/src/api/chat'
import { useChatStore } from '../../../src/studio/web-next/src/stores/chat'

const fetchMock = fetchChatHistory as ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('W3: chat store 事件分派', () => {
  it('chat_start → running=true', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    expect(chat.running).toBe(true)
  })

  it('chat_turn + chat_text → 新气泡 + 文本追加', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    chat.dispatch({ type: 'chat_text', text: '你好' })
    chat.dispatch({ type: 'chat_text', text: '世界' })
    expect(chat.messages).toHaveLength(1)
    expect(chat.messages[0]!.content).toBe('你好世界')
    expect(chat.messages[0]!.role).toBe('assistant')
  })

  it('第二个 chat_turn → 新气泡（不拼接到旧气泡）', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    chat.dispatch({ type: 'chat_text', text: '第一轮' })
    chat.dispatch({ type: 'chat_turn', turn: 1 })
    chat.dispatch({ type: 'chat_text', text: '第二轮' })
    expect(chat.messages).toHaveLength(2)
    expect(chat.messages[0]!.content).toBe('第一轮')
    expect(chat.messages[1]!.content).toBe('第二轮')
  })

  it('chat_reset → 只清当前回合文本', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    chat.dispatch({ type: 'chat_text', text: '旧的' })
    chat.dispatch({ type: 'chat_reset' })
    expect(chat.messages[0]!.content).toBe('')
  })

  it('chat_done → running=false + 气泡标记 done', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    chat.dispatch({ type: 'chat_done' })
    expect(chat.running).toBe(false)
    expect(chat.messages[0]!.done).toBe(true)
  })

  it('chat_error → running=false + error 有值', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_error', error: '出错了' })
    expect(chat.running).toBe(false)
    expect(chat.error).toBe('出错了')
  })
})

describe('W3: 工具卡片状态流转', () => {
  it('pending → running → ok', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    chat.dispatch({ type: 'chat_tool_pending', callId: 'c1', name: 'write_chapter', input: { chapter: 5 } })
    chat.dispatch({ type: 'chat_tool', callId: 'c1', name: 'write_chapter', input: { chapter: 5 } })
    chat.dispatch({ type: 'chat_tool_result', callId: 'c1', summary: '写好了', ok: true })

    const tool = chat.messages[0]!.tools[0]!
    expect(tool.status).toBe('ok')
    expect(tool.summary).toBe('写好了')
  })

  it('pending → cancelled（ok=false 的 tool_result）', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    chat.dispatch({ type: 'chat_tool_pending', callId: 'c2', name: 'write_chapter', input: { chapter: 1 } })
    chat.dispatch({ type: 'chat_tool_result', callId: 'c2', summary: '已取消', ok: false })

    const tool = chat.messages[0]!.tools[0]!
    expect(tool.status).toBe('cancelled')
  })

  it('readonly 工具不走 pending，直接 tool → result', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    // check_chapter 是 readonly → 只有 chat_tool + chat_tool_result，没有 chat_tool_pending
    chat.dispatch({ type: 'chat_tool', callId: 'c3', name: 'check_chapter', input: { chapter: 1 } })
    chat.dispatch({ type: 'chat_tool_result', callId: 'c3', summary: '全绿', ok: true })

    expect(chat.messages[0]!.tools).toHaveLength(1)
    expect(chat.messages[0]!.tools[0]!.status).toBe('ok')
    expect(chat.messages[0]!.tools[0]!.name).toBe('check_chapter')
  })
})

describe('W3: pushUser + clear', () => {
  it('pushUser 添加用户气泡', () => {
    const chat = useChatStore()
    chat.pushUser('帮我看看第5章')
    expect(chat.messages).toHaveLength(1)
    expect(chat.messages[0]!.role).toBe('user')
    expect(chat.messages[0]!.content).toBe('帮我看看第5章')
  })

  it('clear 清空全部', () => {
    const chat = useChatStore()
    chat.pushUser('hi')
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    chat.dispatch({ type: 'chat_text', text: 'hello' })
    chat.clear()
    expect(chat.messages).toHaveLength(0)
    expect(chat.error).toBeNull()
  })
})

// ── Y-P2-5：历史种子化 ────────────────────────────────

/** 一轮带工具往返的历史投影（后端 GET /chat/history 的响应形状） */
const HISTORY: { messages: ChatHistoryMessage[] } = {
  messages: [
    { role: 'user', content: '帮我看看第 1 章' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '我先检查一下。' },
        { type: 'reasoning', text: '思考过程不该显示' },
        { type: 'tool_use', id: 'tu-1', name: 'check_chapter', input: { chapter: 1 } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'tu-1', content: '全绿', isError: false }],
    },
    { role: 'assistant', content: '检查完毕，没有问题。' },
  ],
}

/** 手动决议的 Promise（竞态测试：让 fetch 挂起到指定时机） */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('Y-P2-5: 历史种子化', () => {
  it('messages 为空 → 拉取并种子化（user 文本 / assistant 块 / tool_result 回填卡片 / reasoning 跳过）', async () => {
    fetchMock.mockResolvedValueOnce(HISTORY)
    const chat = useChatStore()
    await chat.seedHistory('书A')
    expect(fetchMock).toHaveBeenCalledWith('书A')
    // tool_result 合成的 user 消息不渲染为气泡 → 4 条投影 = 3 个气泡
    expect(chat.messages).toHaveLength(3)
    expect(chat.messages[0]!.role).toBe('user')
    expect(chat.messages[0]!.content).toBe('帮我看看第 1 章')
    expect(chat.messages[0]!.done).toBe(true)
    expect(chat.messages[1]!.role).toBe('assistant')
    expect(chat.messages[1]!.content).toBe('我先检查一下。') // reasoning 不入内容
    expect(chat.messages[1]!.tools).toHaveLength(1)
    expect(chat.messages[1]!.tools[0]).toMatchObject({
      callId: 'tu-1',
      name: 'check_chapter',
      input: { chapter: 1 },
      status: 'ok',
      summary: '全绿',
    })
    expect(chat.messages[2]!.content).toBe('检查完毕，没有问题。')
  })

  it('tool_result isError → 卡片标 failed', async () => {
    fetchMock.mockResolvedValueOnce({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu-9', name: 'write_chapter', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', toolUseId: 'tu-9', content: '写失败', isError: true }],
        },
      ],
    })
    const chat = useChatStore()
    await chat.seedHistory('书A')
    expect(chat.messages).toHaveLength(1)
    expect(chat.messages[0]!.tools[0]!.status).toBe('failed')
    expect(chat.messages[0]!.tools[0]!.summary).toBe('写失败')
  })

  it('已有消息 → 不拉取', async () => {
    const chat = useChatStore()
    chat.pushUser('已经在聊了')
    await chat.seedHistory('书A')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(chat.messages).toHaveLength(1)
  })

  it('正在生成（running）→ 不拉取', async () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    await chat.seedHistory('书A')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('拉取期间 SSE 新消息到达 → 放弃种子化（不插入错位）', async () => {
    const d = deferred<typeof HISTORY>()
    fetchMock.mockReturnValueOnce(d.promise)
    const chat = useChatStore()
    const p = chat.seedHistory('书A')
    // 等待期间 SSE 推来新回合（如后端对话在跑）
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    chat.dispatch({ type: 'chat_text', text: '新消息' })
    d.resolve(HISTORY)
    await p
    expect(chat.messages).toHaveLength(1)
    expect(chat.messages[0]!.content).toBe('新消息') // 只有 SSE 的气泡，历史被放弃
  })

  it('拉取期间切书（clear）→ 旧书历史不再种入', async () => {
    const d = deferred<typeof HISTORY>()
    fetchMock.mockReturnValueOnce(d.promise)
    const chat = useChatStore()
    const p = chat.seedHistory('书A')
    chat.clear() // 切到书B：clear 使在途响应失效
    d.resolve(HISTORY)
    await p
    expect(chat.messages).toHaveLength(0)
  })

  it('拉取失败 → 静默放弃（不抛错，messages 保持空）', async () => {
    fetchMock.mockRejectedValueOnce(new Error('后端未起'))
    const chat = useChatStore()
    await expect(chat.seedHistory('书A')).resolves.toBeUndefined()
    expect(chat.messages).toHaveLength(0)
  })

  it('空历史（messages: []）→ 不种入任何气泡', async () => {
    fetchMock.mockResolvedValueOnce({ messages: [] })
    const chat = useChatStore()
    await chat.seedHistory('书A')
    expect(chat.messages).toHaveLength(0)
  })
})
