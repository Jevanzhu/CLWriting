/**
 * W3 chat store 单测：事件分派 + 工具卡片状态机 + 历史回合。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useChatStore } from '../../../src/studio/web-next/src/stores/chat'

beforeEach(() => {
  setActivePinia(createPinia())
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
