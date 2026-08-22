<script setup lang="ts">
/**
 * 对话助手面板（方案 §3.7.4）。
 *
 * A（工作台 tab）和 B（底部 dock）共用此组件，容器控制尺寸。
 * 视觉参考 Codex Desktop：大圆角输入框 + 内嵌圆形发送 + 无气泡感消息流。
 *
 * hh §八-16 拆分：消息流（确认闸/变体切换/重新生成/滚动跟随）→ chat/ChatMessages.vue
 * （纯搬家，DOM 不变）；本件留输入区 + useChatComposer 编排。公开契约
 * （bookName/currentChapter/hideComposer）不变——ChatDock / WorkbenchView 零改动。
 */
import { ref, nextTick } from 'vue'
import { Send, Trash2, BookOpen, ChevronDown, Square } from 'lucide-vue-next'
import { useChatStore } from '../../stores/chat'
import { useChatComposer } from '../../composables/useChatComposer'
import ModelEffortBar from '../ui/ModelEffortBar.vue'
import ChatMessages from './chat/ChatMessages.vue'

const props = defineProps<{
  bookName: string
  /** 当前编辑器章号（章节选择器用） */
  currentChapter?: number
  /** 隐藏底部输入区（dock 拆分为独立输入框时，对话框只显示消息） */
  hideComposer?: boolean
}>()

const chat = useChatStore()

// ── 发送/停止/清空/章节选择（共享 composable）────

/** 消息流子件句柄——发送后滚底（onPushed 回调经 defineExpose 调子件 scrollToBottom） */
const messagesRef = ref<InstanceType<typeof ChatMessages> | null>(null)

const {
  input, sending, busy, chatRunning, selectedChapter,
  chapterMenuOpen, chapterWrapRef,
  handleSend, handleKeydown, stopChat, handleClear,
  toggleChapterMenu, selectChapter,
} = useChatComposer(
  () => props.bookName,
  () => props.currentChapter,
  async () => { await nextTick(); messagesRef.value?.scrollToBottom() },
)
</script>

<template>
  <section class="chat-panel">
    <ChatMessages
      ref="messagesRef"
      :book-name="props.bookName"
      :selected-chapter="selectedChapter"
    />

    <!-- 输入区：Codex 风格——章节左下 + 模型/推理等级右下 + 发送 -->
    <div v-if="!hideComposer" class="chat-composer">
      <div class="composer-box">
        <!-- 主区：输入框 -->
        <div class="composer-main">
          <textarea
            v-model="input"
            class="chat-input"
            placeholder="给 AI 发消息…"
            rows="2"
            :disabled="busy"
            @keydown="handleKeydown"
          />
        </div>

        <!-- 底栏：章节选择+快捷键提示（左）+ 模型/推理等级/清空/发送（右） -->
        <div class="composer-footer">
          <div class="composer-foot-left">
            <div ref="chapterWrapRef" class="composer-chapter-wrap">
              <button type="button" class="composer-chapter" :class="{ on: selectedChapter !== undefined }" @click="toggleChapterMenu">
                <BookOpen :size="14" />
                <span>{{ selectedChapter !== undefined ? `第 ${selectedChapter} 章` : '全书' }}</span>
                <ChevronDown :size="10" />
              </button>
              <div v-if="chapterMenuOpen" class="chapter-menu">
                <button type="button" class="chapter-menu-item" :class="{ active: selectedChapter === undefined }" @click="selectChapter(undefined)">全书</button>
                <button v-if="currentChapter" type="button" class="chapter-menu-item" :class="{ active: selectedChapter === currentChapter }" @click="selectChapter(currentChapter)">第 {{ currentChapter }} 章</button>
              </div>
            </div>
            <span class="composer-hint">Enter 发送 · Shift+Enter 换行</span>
          </div>
          <div class="composer-actions">
            <ModelEffortBar />
            <button
              v-if="chat.hasMessages"
              class="composer-clear"
              title="清空对话"
              @click="handleClear"
            >
              <Trash2 :size="13" />
            </button>
            <button
              v-if="chatRunning"
              class="chat-stop-btn"
              title="停止"
              @click="stopChat"
            >
              <Square :size="14" />
            </button>
            <button
              v-else
              class="chat-send-btn"
              :disabled="!input.trim()"
              @click="handleSend"
            >
              <Send :size="15" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* ── 输入区：Codex 风格——章节左下 + 模型/推理等级右下 + 发送 ── */
.chat-composer {
  padding: var(--size-4-1) var(--size-4-5) var(--size-4-4);
  flex-shrink: 0;
}
.composer-box {
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  background: var(--background-primary);
  box-shadow: var(--shadow-s);
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.composer-box:hover {
  border-color: var(--background-modifier-border-hover);
}
.composer-box:focus-within {
  border-color: var(--interactive-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--interactive-accent) 14%, transparent), var(--shadow-s);
}
.composer-main {
  display: flex;
  align-items: flex-start;
  gap: var(--size-4-2);
  padding: var(--size-4-3) var(--size-4-3) var(--size-4-1);
}
.composer-chapter-wrap {
  position: relative;
}
.composer-chapter {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  padding: 3px 11px;
  border-radius: 999px;
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  font-family: inherit;
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.composer-chapter:hover {
  border-color: var(--background-modifier-border-hover);
  color: var(--text-normal);
}
.composer-chapter.on {
  border-color: color-mix(in srgb, var(--interactive-accent) 40%, transparent);
  color: var(--text-accent);
}
/* 章节自定义下拉菜单（向上弹出，与 composer-box 同风格） */

.chat-input {
  flex: 1;
  min-height: 56px;
  resize: none;
  border: none;
  background: transparent;
  padding: var(--size-4-1) 0;
  font-size: var(--font-size-m);
  font-family: inherit;
  line-height: 1.6;
  color: var(--text-normal);
  outline: none;
}
.chat-input::placeholder {
  color: var(--text-faint);
}
.chat-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.composer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--size-4-2);
  padding: var(--size-4-1) var(--size-4-3) var(--size-4-3);
}
.composer-foot-left {
  display: flex;
  align-items: center;
  gap: var(--size-4-6);
  min-width: 0;
}
.composer-hint {
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
  user-select: none;
}
.composer-actions {
  display: flex;
  align-items: center;
  gap: 5px;
}
.composer-clear {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: var(--text-faint);
  background: none;
  border: none;
  cursor: pointer;
  border-radius: var(--radius-s);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.composer-clear:hover {
  color: var(--text-normal);
  background: var(--background-modifier-hover);
}
.chat-stop-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  border-radius: 50%;
  border: none;
  background: var(--dv-bad);
  color: var(--text-on-accent);
  cursor: pointer;
  transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.chat-stop-btn:hover {
  opacity: 0.9;
  transform: translateY(-1px);
}
.chat-send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  border-radius: 50%;
  border: none;
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  cursor: pointer;
  transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.chat-send-btn:hover:not(:disabled) {
  opacity: 0.9;
  transform: translateY(-1px);
  box-shadow: 0 4px 14px color-mix(in srgb, var(--interactive-accent) 35%, transparent);
}
.chat-send-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
</style>
