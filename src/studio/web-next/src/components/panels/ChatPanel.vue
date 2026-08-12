<script setup lang="ts">
/**
 * 对话助手面板（方案 §3.7.4）。
 *
 * A（工作台 tab）和 B（底部 dock）共用此组件，容器控制尺寸。
 * 视觉参考 Codex Desktop：大圆角输入框 + 内嵌圆形发送 + 无气泡感消息流。
 */
import { ref, nextTick, watch } from 'vue'
import { Send, Trash2, PenLine, ShieldCheck, AlertCircle, Loader2, Cpu, MessageSquareText, BookOpen, ChevronDown, Square } from 'lucide-vue-next'
import { useChatStore } from '../../stores/chat'
import { confirmTool } from '../../api/chat'
import { ApiError } from '../../api/client'
import { useUiStore } from '../../stores/ui'
import { useChatTier, EFFORT_LEVELS } from '../../composables/useChatTier'
import { useChatComposer } from '../../composables/useChatComposer'

const props = defineProps<{
  bookName: string
  /** 当前编辑器章号（章节选择器用） */
  currentChapter?: number
  /** 隐藏底部输入区（dock 拆分为独立输入框时，对话框只显示消息） */
  hideComposer?: boolean
}>()

const chat = useChatStore()

// ── 滚动（ChatPanel 独有）────────────────────────

const scrollRef = ref<HTMLElement | null>(null)
// rAF 节流：流式 chat_text 每帧可能触发多次，同帧只滚一次（P2-FE-7）
let scrollRaf = 0
function scrollToBottom(): void {
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    if (scrollRef.value) scrollRef.value.scrollTop = scrollRef.value.scrollHeight
  })
}

// ── 发送/停止/清空/章节选择（共享 composable）────

const {
  input, sending, busy, selectedChapter,
  chapterMenuOpen, chapterWrapRef,
  handleSend, handleKeydown, stopChat, handleClear,
  toggleChapterMenu, selectChapter,
} = useChatComposer(
  () => props.bookName,
  () => props.currentChapter,
  async () => { await nextTick(); scrollToBottom() },
)

const tier = useChatTier()
const ui = useUiStore()

// ── 工具确认 ────────────────────────────────────

async function handleConfirm(callId: string, ok: boolean): Promise<void> {
  try {
    await confirmTool(props.bookName, { callId, ok })
  } catch (e) {
    // 404 = 工具调用已超时，静默忽略；其他错误提示作者
    if (e instanceof ApiError && e.status === 404) return
    ui.toast('确认请求失败，请重试', 'error')
  }
}

// ── 消息流滚动跟随 ──────────────────────────────

watch(
  [() => chat.messages.length, () => chat.messages.at(-1)?.content],
  () => void nextTick(scrollToBottom),
)

// ── 工具图标映射 ─────────────────────────────────

const TOOL_ICONS: Record<string, typeof PenLine> = {
  write_chapter: PenLine,
  check_chapter: ShieldCheck,
}

const TOOL_LABELS: Record<string, string> = {
  write_chapter: '自动写章',
  check_chapter: '机检',
}
</script>

<template>
  <section class="chat-panel">
    <!-- 消息区：无气泡感，用户消息浅卡片右对齐，AI 消息纯文本全宽 -->
    <div ref="scrollRef" class="chat-messages">
      <div v-if="!chat.hasMessages && !chat.running" class="chat-empty">
        <MessageSquareText :size="32" class="chat-empty-icon" />
        <p class="chat-empty-title">和 AI 聊聊你的故事</p>
        <p class="chat-empty-sub">提问剧情走向、让 AI 机检章节，或直接写下一章</p>
      </div>

      <template v-for="msg in chat.messages" :key="msg.id">
        <!-- 用户消息 -->
        <div v-if="msg.role === 'user'" class="chat-msg chat-msg-user">
          {{ msg.content }}
        </div>

        <!-- 助手消息 -->
        <div v-else class="chat-msg chat-msg-assistant">
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
              <span v-if="tool.status === 'running'" class="chat-tool-badge">
                <Loader2 :size="12" class="spin" /> 执行中
              </span>
              <span v-else-if="tool.status === 'ok'" class="chat-tool-badge ok">完成</span>
              <span v-else-if="tool.status === 'failed'" class="chat-tool-badge bad">失败</span>
              <span v-else-if="tool.status === 'cancelled'" class="chat-tool-badge bad">已取消</span>
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
            <label class="composer-chip" :class="{ on: !!tier.chatTier }" data-tip="对话档 · 未配置时回落创作档">
              <Cpu :size="12" />
              <select
                :value="tier.activeModel"
                class="chat-select chat-model"
                :disabled="tier.tierLoading"
                @change="tier.onModelChange"
              >
                <option v-if="tier.activeModel && !tier.models.includes(tier.activeModel)" :value="tier.activeModel">{{ tier.activeModel }}</option>
                <option value="" disabled>选择模型</option>
                <option v-for="m in tier.models" :key="m" :value="m">{{ m }}</option>
              </select>
            </label>
            <select
              :value="tier.activeEffort"
              class="composer-chip chat-effort"
              :disabled="tier.tierLoading || !tier.activeModel"
              @change="tier.onEffortChange"
            >
              <option v-for="l in EFFORT_LEVELS" :key="l" :value="l">{{ l }}</option>
            </select>
            <button
              v-if="chat.hasMessages"
              class="composer-clear"
              title="清空对话"
              @click="handleClear"
            >
              <Trash2 :size="13" />
            </button>
            <button
              v-if="busy"
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

/* ── 消息区 ── */
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: var(--size-4-3) var(--size-4-5);
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
  min-height: 0;
}
.chat-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--size-4-1);
  color: var(--text-faint);
  text-align: center;
  padding: var(--size-4-6);
}
.chat-empty-icon {
  opacity: 0.45;
  margin-bottom: var(--size-4-1);
}
.chat-empty-title {
  font-size: var(--font-size-m);
  font-weight: 600;
  color: var(--text-muted);
}
.chat-empty-sub {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  line-height: 1.5;
}

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

/* ── 工具卡片 ── */
.chat-tool-card {
  border: 1px solid var(--background-modifier-border);
  border-left-width: 3px;
  border-radius: var(--radius-s);
  padding: var(--size-4-2) var(--size-4-3);
  font-size: var(--font-size-s);
  background: var(--background-secondary);
}
.tool-pending { border-left-color: var(--dv-warn); }
.tool-running { border-left-color: var(--interactive-accent); }
.tool-ok { border-left-color: var(--dv-good); }
.tool-failed { border-left-color: var(--dv-bad); }

.chat-tool-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
}
.chat-tool-name {
  color: var(--text-normal);
}
.chat-tool-badge {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: var(--font-size-xs);
  font-weight: 500;
  color: var(--text-muted);
  background: var(--background-modifier-hover);
}
.chat-tool-badge.ok {
  color: var(--dv-good);
  background: color-mix(in srgb, var(--dv-good) 12%, transparent);
}
.chat-tool-badge.bad {
  color: var(--dv-bad);
  background: color-mix(in srgb, var(--dv-bad) 12%, transparent);
}
.chat-tool-summary {
  margin-top: var(--size-4-1);
  color: var(--text-muted);
  white-space: pre-wrap;
  line-height: 1.5;
  font-size: var(--font-size-xs);
}
.chat-tool-confirm {
  display: flex;
  justify-content: flex-end;
  gap: var(--size-4-2);
  margin-top: var(--size-4-2);
}
.chat-confirm-no,
.chat-confirm-yes {
  font-size: var(--font-size-xs);
  padding: 4px 14px;
  border-radius: 999px;
  border: 1px solid var(--background-modifier-border);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.chat-confirm-no {
  background: var(--background-primary);
  color: var(--text-muted);
}
.chat-confirm-no:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.chat-confirm-yes {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  border-color: transparent;
}
.chat-confirm-yes:hover {
  filter: brightness(1.1);
}

/* ── 错误 ── */
.chat-error-msg {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--dv-bad);
  font-size: var(--font-size-s);
  padding: var(--size-4-2);
  border-radius: var(--radius-s);
  background: color-mix(in srgb, var(--dv-bad) 8%, transparent);
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
.chapter-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  z-index: 10;
  min-width: 100%;
  border-radius: var(--radius-l);
  border: 1px solid color-mix(in srgb, var(--background-modifier-border) 70%, transparent);
  background: color-mix(in srgb, var(--background-primary) 70%, transparent);
  backdrop-filter: blur(20px) saturate(1.4);
  -webkit-backdrop-filter: blur(20px) saturate(1.4);
  box-shadow: var(--shadow-s);
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  white-space: nowrap;
  animation: chapter-menu-in var(--dur-fast) var(--ease-out);
}
@keyframes chapter-menu-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.chapter-menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  text-align: left;
  padding: 7px 12px;
  border: none;
  background: none;
  border-radius: var(--radius-s);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.chapter-menu-item:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.chapter-menu-item.active {
  color: var(--text-accent);
  background: color-mix(in srgb, var(--interactive-accent) 10%, transparent);
  font-weight: 600;
}
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
.composer-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--background-secondary);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.composer-chip:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.composer-chip.on {
  color: var(--text-accent);
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
.chat-select {
  appearance: none;
  border: none;
  background: transparent;
  color: inherit;
  font-size: inherit;
  font-family: inherit;
  outline: none;
  cursor: pointer;
  padding: 0;
}
.chat-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.chat-model {
  max-width: 140px;
  text-overflow: ellipsis;
}
.chat-effort {
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
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

/* 动画 */
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>