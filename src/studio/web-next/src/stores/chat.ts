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

/** 消息列表上限（防长对话内存膨胀） */
const MAX_MESSAGES = 200

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
      case 'sync': {
        // 连接快照（SSE 重连补发）：同步后端真实 chat 运行态，防断连错过 chat_done 致永久锁死
        running.value = ev['chatRunning'] === true
        // P2-9：重连时后端只补发 chatRunning，不重发 chat_turn——若旧 currentIdx 已随回合结束失效，
        // 找到最后一个未 done 的 assistant 气泡重建索引（否则 chat_text 追加到错误气泡或被静默丢弃）
        if (running.value && (currentIdx < 0 || messages.value[currentIdx]?.done)) {
          // 反向找最后一个未 done 的 assistant 气泡（lib=ES2022 无 findLastIndex，手写循环）
          let lastUndone = -1
          for (let i = messages.value.length - 1; i >= 0; i--) {
            const m = messages.value[i]
            if (m && m.role === 'assistant' && !m.done) {
              lastUndone = i
              break
            }
          }
          currentIdx = lastUndone
        }
        break
      }
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
        // 重试防拼接：清当前回合的文本和工具卡片（旧工具结果不残留）
        if (currentIdx >= 0) {
          messages.value[currentIdx]!.content = ''
          messages.value[currentIdx]!.tools = []
        }
        break
      }
      case 'chat_done': {
        running.value = false
        if (currentIdx >= 0) {
          messages.value[currentIdx]!.done = true
        }
        // P2-9：回合结束即失效 currentIdx——SSE 断线重连后 sync 不会重发 chat_turn，
        // 旧索引指向已 done 气泡会让后续 chat_text 追加错误位置
        currentIdx = -1
        trimMessages()
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
    trimMessages()
  }

  /** 裁剪最旧消息，保持列表不超过上限（在 push / chat_done 后调） */
  function trimMessages(): void {
    if (messages.value.length > MAX_MESSAGES) {
      messages.value.splice(0, messages.value.length - MAX_MESSAGES)
    }
  }

  /** 回滚最后一条用户消息（sendChat 失败时调，防幽灵消息） */
  function popUser(): void {
    const last = messages.value[messages.value.length - 1]
    if (last && last.role === 'user') messages.value.pop()
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
    popUser,
    clear,
  }
})
