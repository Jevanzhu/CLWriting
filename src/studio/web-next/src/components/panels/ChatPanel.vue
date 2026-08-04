<script setup lang="ts">
/**
 * 对话助手面板（方案 §3.7.4）。
 *
 * A（工作台 tab）和 B（底部 dock）共用此组件，容器控制尺寸。
 * 消息气泡 + 工具卡片 + 章节选择器 + 模型/推理等级选择器 + 输入框。
 */
import { ref, computed, nextTick, watch } from 'vue'
import { Send, BookOpen, Trash2, PenLine, ShieldCheck, AlertCircle, Loader2 } from 'lucide-vue-next'
import { useChatStore } from '../../stores/chat'
import { useWorkbenchStore } from '../../stores/workbench'
import { sendChat, confirmTool } from '../../api/chat'

const props = defineProps<{
  bookName: string
  /** 当前编辑器章号（章节选择器用） */
  currentChapter?: number
}>()

const chat = useChatStore()
const wb = useWorkbenchStore()

// ── 输入 ────────────────────────────────────────

const input = ref('')
const selectedChapter = ref<number | undefined>(props.currentChapter)

watch(() => props.currentChapter, (v) => {
  if (v !== undefined) selectedChapter.value = v
})

// ── 联合判据：chat 或 workbench 在跑都禁发送 ──────

const busy = computed(() => chat.running || wb.running)

// ── 发送 ────────────────────────────────────────

const scrollRef = ref<HTMLElement | null>(null)

async function handleSend(): Promise<void> {
  const text = input.value.trim()
  if (!text || busy.value) return
  input.value = ''
  chat.pushUser(text)
  await nextTick()
  scrollToBottom()
  try {
    await sendChat(props.bookName, {
      message: text,
      ...(selectedChapter.value !== undefined ? { chapter: selectedChapter.value } : {}),
    })
  } catch (e) {
    chat.error = e instanceof Error ? e.message : String(e)
  }
}

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void handleSend()
  }
}

// ── 工具确认 ────────────────────────────────────

async function handleConfirm(callId: string, ok: boolean): Promise<void> {
  try {
    await confirmTool(props.bookName, { callId, ok })
  } catch {
    /* 404 = 已超时，忽略 */
  }
}

// ── 清空 ────────────────────────────────────────

function handleClear(): void {
  chat.clear()
}

// ── 滚动 ────────────────────────────────────────

function scrollToBottom(): void {
  if (scrollRef.value) {
    scrollRef.value.scrollTop = scrollRef.value.scrollHeight
  }
}

watch(() => chat.messages.length, () => {
  void nextTick(scrollToBottom)
})

// ── 工具图标映射 ─────────────────────────────────

const TOOL_ICONS: Record<string, typeof PenLine> = {
  write_chapter: PenLine,
  check_chapter: ShieldCheck,
  review_chapter: ShieldCheck,
}

const TOOL_LABELS: Record<string, string> = {
  write_chapter: '自动写章',
  check_chapter: '机检',
  review_chapter: '审稿',
}
</script>

<template>
  <section class="chat-panel">
    <!-- 顶栏：章节选择器 + 清空 -->
    <div class="chat-topbar">
      <label class="chat-chapter">
        <BookOpen :size="14" />
        <select v-model.number="selectedChapter" class="chat-chapter-select">
          <option :value="undefined">不指定章节</option>
          <option v-if="currentChapter" :value="currentChapter">第 {{ currentChapter }} 章</option>
        </select>
      </label>
      <button
        v-if="chat.hasMessages"
        class="chat-clear-btn"
        title="清空对话"
        @click="handleClear"
      >
        <Trash2 :size="14" />
      </button>
    </div>

    <!-- 消息区 -->
    <div ref="scrollRef" class="chat-messages">
      <div v-if="!chat.hasMessages && !chat.running" class="chat-empty">
        问点什么——AI 知道你的角色设定和前文。
      </div>

      <template v-for="(msg, i) in chat.messages" :key="i">
        <!-- 用户气泡 -->
        <div v-if="msg.role === 'user'" class="chat-bubble chat-bubble-user">
          {{ msg.content }}
        </div>

        <!-- 助手气泡 -->
        <div v-else class="chat-bubble chat-bubble-assistant">
          <!-- 文本 -->
          <div v-if="msg.content" class="chat-text">{{ msg.content }}</div>
          <div v-else-if="!msg.done && msg.tools.length === 0" class="chat-typing">
            <Loader2 :size="13" class="spin" />
          </div>

          <!-- 工具卡片 -->
          <div
            v-for="tool in msg.tools"
            :key="tool.callId"
            class="chat-tool-card"
            :class="{
              'tool-pending': tool.status === 'pending',
              'tool-running': tool.status === 'running',
              'tool-ok': tool.status === 'ok',
              'tool-failed': tool.status === 'failed' || tool.status === 'cancelled',
            }"
          >
            <div class="chat-tool-head">
              <component :is="TOOL_ICONS[tool.name] ?? PenLine" :size="14" />
              <span class="chat-tool-name">{{ TOOL_LABELS[tool.name] ?? tool.name }}</span>
              <span v-if="tool.status === 'running'" class="chat-tool-status">
                <Loader2 :size="12" class="spin" /> 执行中
              </span>
              <span v-else-if="tool.status === 'ok'" class="chat-tool-status">完成</span>
              <span v-else-if="tool.status === 'failed'" class="chat-tool-status">失败</span>
              <span v-else-if="tool.status === 'cancelled'" class="chat-tool-status">已取消</span>
            </div>

            <!-- 工具结果摘要 -->
            <div v-if="tool.summary" class="chat-tool-summary">{{ tool.summary }}</div>

            <!-- 确认按钮 -->
            <div v-if="tool.status === 'pending'" class="chat-tool-confirm">
              <button class="chat-confirm-no" @click="handleConfirm(tool.callId, false)">取消</button>
              <button class="chat-confirm-yes" @click="handleConfirm(tool.callId, true)">确认执行</button>
            </div>
          </div>
        </div>
      </template>

      <!-- 错误 -->
      <div v-if="chat.error" class="chat-error-msg">
        <AlertCircle :size="14" />
        <span>{{ chat.error }}</span>
      </div>
    </div>

    <!-- 输入区 -->
    <div class="chat-input-area">
      <textarea
        v-model="input"
        class="chat-input"
        placeholder="输入你的问题…"
        rows="2"
        :disabled="busy"
        @keydown="handleKeydown"
      />
      <button
        class="chat-send-btn"
        :disabled="!input.trim() || busy"
        @click="handleSend"
      >
        <Send :size="15" />
      </button>
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

/* 顶栏 */
.chat-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--size-3-2) var(--size-2);
  flex-shrink: 0;
}
.chat-chapter {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-muted);
  font-size: var(--font-size-s);
}
.chat-chapter-select {
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-default);
  font-size: var(--font-size-s);
  padding: 1px 4px;
  outline: none;
}
.chat-clear-btn {
  display: flex;
  align-items: center;
  color: var(--text-muted);
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
  transition: var(--dur-fast) var(--ease-out);
}
.chat-clear-btn:hover {
  color: var(--text-default);
  background: var(--bg-hover);
}

/* 消息区 */
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: var(--size-2) var(--size-3-2);
  display: flex;
  flex-direction: column;
  gap: var(--size-2);
  min-height: 0;
}
.chat-empty {
  color: var(--text-faint);
  font-size: var(--font-size-s);
  text-align: center;
  padding: var(--size-5) var(--size-2);
}

/* 气泡 */
.chat-bubble {
  max-width: 88%;
  padding: var(--size-2) var(--size-3-2);
  border-radius: 8px;
  font-size: var(--font-size-m);
  line-height: 1.6;
  word-wrap: break-word;
  white-space: pre-wrap;
}
.chat-bubble-user {
  align-self: flex-end;
  background: var(--interactive-accent);
  color: var(--bg-elevated);
}
.chat-bubble-assistant {
  align-self: flex-start;
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  gap: var(--size-2);
}
.chat-typing {
  color: var(--text-muted);
  display: flex;
  align-items: center;
  padding: 2px 0;
}

/* 工具卡片 */
.chat-tool-card {
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: var(--size-2) var(--size-3-2);
  font-size: var(--font-size-s);
  background: var(--bg-elevated);
}
.tool-pending { border-color: var(--dv-warn); }
.tool-running { border-color: var(--interactive-accent); }
.tool-ok { border-color: var(--dv-good); }
.tool-failed { border-color: var(--dv-bad); }

.chat-tool-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
}
.chat-tool-name { color: var(--text-default); }
.chat-tool-status {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 3px;
  color: var(--text-muted);
  font-weight: 400;
}
.chat-tool-summary {
  margin-top: 4px;
  color: var(--text-muted);
  white-space: pre-wrap;
  line-height: 1.5;
}
.chat-tool-confirm {
  display: flex;
  justify-content: flex-end;
  gap: var(--size-2);
  margin-top: var(--size-2);
}
.chat-confirm-no,
.chat-confirm-yes {
  font-size: var(--font-size-s);
  padding: 3px 10px;
  border-radius: 4px;
  border: 1px solid var(--border-default);
  cursor: pointer;
  transition: var(--dur-fast) var(--ease-out);
}
.chat-confirm-no {
  background: var(--bg-elevated);
  color: var(--text-muted);
}
.chat-confirm-no:hover { background: var(--bg-hover); }
.chat-confirm-yes {
  background: var(--interactive-accent);
  color: var(--bg-elevated);
  border-color: var(--interactive-accent);
}

/* 错误 */
.chat-error-msg {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--dv-bad);
  font-size: var(--font-size-s);
  padding: var(--size-2);
}

/* 输入区 */
.chat-input-area {
  display: flex;
  gap: var(--size-2);
  padding: var(--size-2) var(--size-3-2) var(--size-3-2);
  flex-shrink: 0;
  align-items: flex-end;
}
.chat-input {
  flex: 1;
  resize: none;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: var(--size-2) var(--size-3-2);
  font-size: var(--font-size-m);
  font-family: inherit;
  background: var(--bg-elevated);
  color: var(--text-default);
  outline: none;
  transition: var(--dur-fast) var(--ease-out);
}
.chat-input:focus {
  border-color: var(--interactive-accent);
}
.chat-input::placeholder {
  color: var(--text-faint);
}
.chat-send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  border: none;
  background: var(--interactive-accent);
  color: var(--bg-elevated);
  cursor: pointer;
  transition: var(--dur-fast) var(--ease-out);
  flex-shrink: 0;
}
.chat-send-btn:hover:not(:disabled) {
  opacity: 0.85;
}
.chat-send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 动画 */
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
