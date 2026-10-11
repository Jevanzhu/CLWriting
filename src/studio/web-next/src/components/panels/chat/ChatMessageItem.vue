<script setup lang="ts">
/**
 * 单条对话消息（自 ChatMessages.vue 拆出，DOM/类名/样式不变）。
 *
 * 职责：用户浅卡片右对齐 / 助手纯文本全宽 + 变体切换器 + 工具卡列表 + 尾随「重新生成」。
 * 变体组定位与切分支动作（依赖 store 的 branches + 运行态）留在列表容器——本件只收
 * 展示入参（variant-label / show-regen / running）并上抛意图，容器侧仍持单一事实源。
 */
import { ChevronLeft, ChevronRight, Loader2, RefreshCw } from 'lucide-vue-next'
import type { ChatMessage } from '../../../stores/chat'
import type { ChapterNameLookup } from '../../../../../../shared/contract/tool-meta'
import ChatToolCard from './ChatToolCard.vue'

defineProps<{
  msg: ChatMessage
  /** 对话运行中（变体切换与重新生成禁用） */
  running: boolean
  /** 变体组位次标签（如「2/3」）；null = 不在多变体组内，不渲染切换器 */
  variantLabel: string | null
  /** 是否挂「重新生成」（仅末条已完成助手消息；!running 才可用） */
  showRegen: boolean
  chapterNameOf: ChapterNameLookup
  /** 确认请求在途的 callId 集合（按卡读；跨卡并行不受阻） */
  confirmingCallIds: ReadonlySet<string>
}>()

const emit = defineEmits<{
  switchVariant: [dir: -1 | 1]
  regenerate: []
  confirm: [callId: string, ok: boolean]
}>()
</script>

<template>
  <!-- 消息区：无气泡感，用户消息浅卡片右对齐，AI 消息纯文本全宽 -->
  <div v-if="msg.role === 'user'" class="chat-msg chat-msg-user">
    {{ msg.content }}
  </div>

  <!-- 助手消息 -->
  <div v-else class="chat-msg chat-msg-assistant">
    <!-- 变体切换器（seq 落在同 parentSeq 的多变体组内时显示；运行中禁用） -->
    <div v-if="variantLabel !== null" class="chat-variant">
      <button
        type="button"
        class="chat-variant-btn"
        :disabled="running"
        title="上一个变体"
        @click="emit('switchVariant', -1)"
      >
        <ChevronLeft :size="13" />
      </button>
      <span class="chat-variant-label">{{ variantLabel }}</span>
      <button
        type="button"
        class="chat-variant-btn"
        :disabled="running"
        title="下一个变体"
        @click="emit('switchVariant', 1)"
      >
        <ChevronRight :size="13" />
      </button>
    </div>

    <!-- 文本 -->
    <div v-if="msg.content" class="chat-text">{{ msg.content }}</div>
    <div v-else-if="!msg.done && msg.tools.length === 0" class="chat-typing">
      <Loader2 :size="13" class="spin" />
    </div>

    <!-- 工具卡片（摘要按卡算一次见 ChatToolCard） -->
    <ChatToolCard
      v-for="tool in msg.tools"
      :key="tool.callId"
      :tool="tool"
      :chapter-name-of="chapterNameOf"
      :confirming="confirmingCallIds.has(tool.callId)"
      @confirm="(callId, ok) => emit('confirm', callId, ok)"
    />

    <!-- 最后一条已完成回复尾随「重新生成」（!running 才可用；新 branchId 落库） -->
    <button v-if="showRegen" type="button" class="chat-regen-btn" :disabled="running" @click="emit('regenerate')">
      <RefreshCw :size="12" />
      <span>重新生成</span>
    </button>
  </div>
</template>

<style scoped>
/* ── 消息：无气泡感 ── */
.chat-msg {
  max-width: 100%;
  font-size: var(--font-size-m);
  line-height: 1.7;
  word-wrap: break-word;
  white-space: pre-wrap;
  animation: chat-pop var(--dur-norm) var(--ease-out);
}
@keyframes chat-pop {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.chat-msg-user {
  align-self: flex-end;
  max-width: 82%;
  padding: var(--size-4-2) var(--size-4-4);
  border-radius: var(--radius-l);
  border-bottom-right-radius: var(--radius-s);
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  color: var(--text-normal);
}
.chat-msg-assistant {
  align-self: stretch;
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
}
.chat-typing {
  color: var(--text-muted);
  display: flex;
  align-items: center;
  padding: 2px 0;
}

/* ── 变体切换器 + 重新生成 ── */
.chat-variant {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  align-self: flex-start;
  padding: 1px 3px;
  border-radius: 999px;
  border: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
}
.chat-variant-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  background: none;
  border-radius: var(--radius-s);
  color: var(--text-muted);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.chat-variant-btn:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.chat-variant-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.chat-variant-label {
  padding: 0 3px;
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
  user-select: none;
}
.chat-regen-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  align-self: flex-start;
  margin-top: var(--size-4-1);
  padding: 3px 12px;
  border-radius: 999px;
  border: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  font-family: inherit;
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}
.chat-regen-btn:hover:not(:disabled) {
  border-color: var(--background-modifier-border-hover);
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.chat-regen-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
