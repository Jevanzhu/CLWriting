<script setup lang="ts">
// 对话式段 2 聊天组件：消息流 + 末条流式 + 输入框。
// 数据态由 page 从 useNewbookStore 传入（messages/running）；发送/中断 emit 回 page 转 store。
import { ref, nextTick, watch } from 'vue'
import type { ChatMessage } from '../types'

const props = defineProps<{
  messages: ChatMessage[]
  running: boolean
}>()
const emit = defineEmits<{
  send: [text: string]
  interrupt: []
}>()

const input = ref('')
const listEl = ref<HTMLElement | null>(null)

function send(): void {
  const text = input.value.trim()
  if (!text || props.running) return
  emit('send', text)
  input.value = ''
}

function onKeydown(e: KeyboardEvent): void {
  // Enter 发送；Shift+Enter 换行
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

// 消息/流式变化 → 滚到底
watch(
  () => props.messages.map((m) => m.text).join(''),
  async () => {
    await nextTick()
    if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
  },
)
</script>

<template>
  <div class="onboard-chat">
    <div ref="listEl" class="chat-list">
      <div v-if="!messages.length" class="chat-empty">
        💬 描述你的想法，AI 会和你讨论设定（世界观 / 角色 / 主线 / 文风…）。<br />
        讨论完点下方「保存讨论」落盘到 <code>工作区/开书讨论.md</code>，供后续整理进各设定文件。
      </div>
      <div v-for="(m, i) in messages" :key="i" class="chat-msg" :class="m.role">
        <div class="chat-bubble">
          {{ m.text
          }}<span
            v-if="running && i === messages.length - 1 && m.role === 'assistant'"
            class="chat-cursor"
            >▍</span
          >
        </div>
      </div>
    </div>
    <div class="chat-input-row">
      <textarea
        v-model="input"
        class="chat-input"
        rows="2"
        placeholder="说点啥（Enter 发送 / Shift+Enter 换行）…"
        :disabled="running"
        @keydown="onKeydown"
      ></textarea>
      <button v-if="!running" class="btn primary" :disabled="!input.trim()" @click="send">
        发送
      </button>
      <button v-else class="btn" @click="emit('interrupt')">⏹ 中断</button>
    </div>
  </div>
</template>

<style scoped>
.onboard-chat {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.chat-list {
  max-height: 380px;
  overflow-y: auto;
  padding: 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: rgba(0, 0, 0, 0.02);
  border-radius: 8px;
}
.chat-empty {
  color: var(--muted, #888);
  font-size: 13px;
  padding: 18px 12px;
  line-height: 1.7;
}
.chat-empty code {
  background: rgba(0, 0, 0, 0.05);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 12px;
}
.chat-msg {
  display: flex;
}
.chat-msg.user {
  justify-content: flex-end;
}
.chat-msg.assistant {
  justify-content: flex-start;
}
.chat-bubble {
  max-width: 80%;
  padding: 8px 12px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.chat-msg.user .chat-bubble {
  background: var(--cinnabar, #c0392b);
  color: #fff;
}
.chat-msg.assistant .chat-bubble {
  background: var(--panel, #fff);
  border: 1px solid var(--border, #ddd);
  color: var(--ink, #222);
}
.chat-cursor {
  opacity: 0.6;
  animation: blink 1s steps(2) infinite;
}
@keyframes blink {
  to {
    opacity: 0;
  }
}
.chat-input-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
.chat-input {
  flex: 1;
  resize: vertical;
  font-size: 14px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--border, #ccc);
  font-family: inherit;
  background: var(--panel, #fff);
  color: var(--ink, #222);
}
</style>
