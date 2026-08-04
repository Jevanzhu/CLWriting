import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

/**
 * 对话助手 store（方案 §3.7.3）。
 *
 * 消息列表 + 工具卡片状态机 + running。
 * chat_* 事件在 useSse 消费点分流到 dispatch()（不塞进 workbench.dispatch）。
 */

/** 工具卡片状态 */
export type ToolStatus = 'pending' | 'running' | 'ok' | 'failed' | 'cancelled'

/** 工具卡片 */
export interface ToolCard {
  callId: string
  name: string
  input: unknown
  status: ToolStatus
  summary?: string
}

/** 聊天消息气泡（文本 + 关联工具卡片按时序穿插） */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  done: boolean
  /** 本回合的工具卡片（按时序） */
  tools: ToolCard[]
}

export const useChatStore = defineStore('chat', () => {
  /** 消息列表 */
  const messages = ref<ChatMessage[]>([])
  /** 对话进行中 */
  const running = ref(false)
  /** 最近一次错误 */
  const error = ref<string | null>(null)
  /** 当前正在填充的 assistant 气泡索引（chat_text 追加目标） */
  let currentIdx = -1

  /** 是否有消息 */
  const hasMessages = computed(() => messages.value.length > 0)

  /** 分派一条 chat_* SSE 事件 */
  function dispatch(ev: { type: string; [k: string]: unknown }): void {
    switch (ev.type) {
      case 'chat_start': {
        running.value = true
        error.value = null
        break
      }
      case 'chat_turn': {
        // 新回合 = 新 assistant 气泡
        messages.value.push({ role: 'assistant', content: '', done: false, tools: [] })
        currentIdx = messages.value.length - 1
        break
      }
      case 'chat_text': {
        if (currentIdx >= 0) {
          messages.value[currentIdx]!.content += ev['text'] as string
        }
        break
      }
      case 'chat_tool_pending': {
        if (currentIdx >= 0) {
          messages.value[currentIdx]!.tools.push({
            callId: ev['callId'] as string,
            name: ev['name'] as string,
            input: ev['input'],
            status: 'pending',
          })
        }
        break
      }
      case 'chat_tool': {
        // readonly 工具不经 pending 直接 tool → 创建卡片
        ensureTool(ev['callId'] as string, ev['name'] as string, ev['input'])
        updateTool(ev['callId'] as string, { status: 'running' })
        break
      }
      case 'chat_tool_result': {
        const ok = ev['ok'] as boolean
        updateTool(ev['callId'] as string, {
          status: ok ? 'ok' : 'cancelled',
          summary: ev['summary'] as string,
        })
        break
      }
      case 'chat_reset': {
        // 只清当前回合的文本（重试防拼接）
        if (currentIdx >= 0) {
          messages.value[currentIdx]!.content = ''
        }
        break
      }
      case 'chat_done': {
        running.value = false
        if (currentIdx >= 0) {
          messages.value[currentIdx]!.done = true
        }
        break
      }
      case 'chat_error': {
        running.value = false
        error.value = ev['error'] as string
        break
      }
    }
  }

  /** 确保工具卡片存在（readonly 工具不经 pending，chat_tool 时补建） */
  function ensureTool(callId: string, name: string, input: unknown): void {
    if (currentIdx < 0) return
    const tools = messages.value[currentIdx]!.tools
    if (!tools.some((t) => t.callId === callId)) {
      tools.push({ callId, name, input, status: 'pending' })
    }
  }

  /** 更新工具卡片状态 */
  function updateTool(callId: string, patch: Partial<ToolCard>): void {
    for (const msg of messages.value) {
      const tool = msg.tools.find((t) => t.callId === callId)
      if (tool) {
        Object.assign(tool, patch)
        return
      }
    }
  }

  /** 添加用户消息（发送时调用） */
  function pushUser(text: string): void {
    messages.value.push({ role: 'user', content: text, done: true, tools: [] })
  }

  /** 清空对话 */
  function clear(): void {
    messages.value = []
    error.value = null
    currentIdx = -1
  }

  return {
    messages,
    running,
    error,
    hasMessages,
    dispatch,
    pushUser,
    clear,
  }
})
