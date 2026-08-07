<script setup lang="ts">
/**
 * 对话助手 dock（FAB 演进版）：左下角 FAB → 输入框 + 独立「对话」按钮 → 对话框。
 * 「对话」按钮未开时在输入框上方 6px；打开时融入对话框头部左上角（胶囊标签）。
 * 输入框为 Codex 风格（与工作台对话一致）：章节左下 + 模型/推理等级/清空/发送右下。
 */
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { MessageCircle, ChevronUp, ChevronDown, X, Send, BookOpen, Trash2, Square } from 'lucide-vue-next'
import ChatPanel from '../panels/ChatPanel.vue'
import { useChatStore } from '../../stores/chat'
import { useWorkbenchStore } from '../../stores/workbench'
import { sendChat, clearChatHistory } from '../../api/chat'
import { interrupt } from '../../api/stream'
import { useChatTier, EFFORT_LEVELS } from '../../composables/useChatTier'

const props = defineProps<{
  bookName: string
  currentChapter?: number
}>()

const chat = useChatStore()
const wb = useWorkbenchStore()
const tier = useChatTier()

/** 输入框是否展开 */
const fabOpen = ref(false)
/** 对话框是否打开 */
const chatOpen = ref(false)
const input = ref('')
const busy = computed(() => chat.running || wb.running)
// F-P1-2：本地发送锁，防 HTTP-SSE 窗口期重复发送（busy 由 SSE chat_start 设置，有窗口期）
const sending = ref(false)

/** 发送目标的章节选择（默认跟随当前编辑器章） */
const selectedChapter = ref<number | undefined>(props.currentChapter)
watch(() => props.currentChapter, (v) => {
  if (v !== undefined) selectedChapter.value = v
})

// ── 模型/推理等级下拉宽度贴合当前选中项 ──

const modelSelect = ref<HTMLSelectElement | null>(null)
const effortSelect = ref<HTMLSelectElement | null>(null)

/** 用临时 span 测量当前选中文本宽度，写入 select 宽度（自适应当前内容） */
function fitSelect(el: HTMLSelectElement | null): void {
  if (!el) return
  const span = document.createElement('span')
  span.style.cssText = `font:${getComputedStyle(el).font};white-space:nowrap;position:absolute;visibility:hidden;padding:0 4px;`
  span.textContent = el.value || '选择模型'
  document.body.appendChild(span)
  el.style.width = `${span.offsetWidth + 16}px`
  document.body.removeChild(span)
}

watch(
  () => [tier.activeModel, tier.activeEffort],
  () => nextTick(() => {
    fitSelect(modelSelect.value)
    fitSelect(effortSelect.value)
  }),
)
watch(
  () => fabOpen,
  (open) => {
    if (open) nextTick(() => {
      fitSelect(modelSelect.value)
      fitSelect(effortSelect.value)
    })
  },
)
onMounted(() => {
  nextTick(() => {
    fitSelect(modelSelect.value)
    fitSelect(effortSelect.value)
  })
})

/** FAB toggle：开 → 收（收起时对话框一并收起） */
function onFab(): void {
  fabOpen.value = !fabOpen.value
  if (!fabOpen.value) chatOpen.value = false
}

/** 「对话」按钮 toggle 对话框 */
function onExpandChat(): void {
  chatOpen.value = !chatOpen.value
}

/** 独立输入框发送 → 推入对话并自动展开对话框看回复 */
async function handleSend(): Promise<void> {
  const text = input.value.trim()
  if (!text || busy.value || sending.value) return
  input.value = ''
  chat.pushUser(text)
  chatOpen.value = true
  sending.value = true
  try {
    await sendChat(props.bookName, {
      message: text,
      ...(selectedChapter.value !== undefined ? { chapter: selectedChapter.value } : {}),
    })
  } catch (e) {
    chat.popUser()
    chat.error = e instanceof Error ? e.message : String(e)
  } finally {
    sending.value = false
  }
}

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void handleSend()
  }
}

/** 章节下拉菜单（自定义浮层，替代原生 select 以掌控定位） */
const chapterMenuOpen = ref(false)
const chapterWrapRef = ref<HTMLElement | null>(null)

function toggleChapterMenu(): void {
  chapterMenuOpen.value = !chapterMenuOpen.value
}

function selectChapter(ch: number | undefined): void {
  selectedChapter.value = ch
  chapterMenuOpen.value = false
}

function onDocClick(e: MouseEvent): void {
  if (chapterMenuOpen.value && chapterWrapRef.value && !chapterWrapRef.value.contains(e.target as Node)) {
    chapterMenuOpen.value = false
  }
}

onMounted(() => document.addEventListener('click', onDocClick))
onUnmounted(() => document.removeEventListener('click', onDocClick))

async function stopChat(): Promise<void> {
  try { await interrupt(props.bookName) } catch { /* 忽略 */ }
}

async function handleClear(): Promise<void> {
  // 运行中先中断后端，再清前后端（防清空后仍冒新消息）
  if (chat.running) await stopChat()
  try { await clearChatHistory(props.bookName) } catch { /* 忽略 */ }
  chat.clear()
}
</script>

<template>
  <div class="chat-dock">
    <!-- 对话框（独立圆角框，75% 玻璃，正文宽度，紧贴输入框上方） -->
    <div v-if="chatOpen" class="chat-window">
      <!-- 头部占位：对话按钮融入此处左上角 -->
      <div class="window-head"></div>
      <div class="window-body">
        <ChatPanel :book-name="bookName" :current-chapter="currentChapter" hide-composer />
      </div>
    </div>

    <!-- 输入框（Codex 风格，与工作台对话一致） -->
    <div v-if="fabOpen" class="chat-stack">
      <div class="chat-composer">
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
                <select
                  ref="modelSelect"
                  :value="tier.activeModel"
                  class="chat-select chat-model"
                  :disabled="tier.tierLoading"
                  @change="tier.onModelChange"
                >
                  <option v-if="tier.activeModel && !tier.models.includes(tier.activeModel)" :value="tier.activeModel">{{ tier.activeModel }}</option>
                  <option value="" disabled>选择模型</option>
                  <option v-for="m in tier.models" :key="m" :value="m">{{ m }}</option>
                </select>
                <ChevronDown :size="10" />
              </label>
              <label class="composer-chip" :class="{ on: !!tier.chatTier }">
                <select
                  ref="effortSelect"
                  :value="tier.activeEffort"
                  class="chat-select chat-effort"
                  :disabled="tier.tierLoading || !tier.activeModel"
                  @change="tier.onEffortChange"
                >
                  <option v-for="l in EFFORT_LEVELS" :key="l" :value="l">{{ l }}</option>
                </select>
                <ChevronDown :size="10" />
              </label>
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
    </div>

    <!-- 「对话」按钮：未开时在输入框上方；打开时融入对话框左上角 -->
    <button v-if="fabOpen" class="chat-expand" :class="{ on: chatOpen }" @click="onExpandChat">
      <MessageCircle :size="13" />
      <span>对话</span>
      <ChevronDown v-if="chatOpen" :size="13" />
      <ChevronUp v-else :size="13" />
    </button>

    <!-- FAB（左下角，常驻 toggle） -->
    <button class="fab" :class="{ on: fabOpen }" title="对话助手" @click="onFab">
      <X v-if="fabOpen" :size="18" />
      <MessageCircle v-else :size="21" />
    </button>
  </div>
</template>

<style scoped>
.chat-dock {
  position: absolute;
  inset: 0;
  z-index: 60;
  pointer-events: none; /* 透明区域不挡编辑 */
  /* 框宽/框高共享变量：两框同宽同轴，按钮对齐用 */
  --chat-w: calc(min(1020px, calc(100% - 96px)) - 284px);
  --chat-h: min(55vh, 520px);
  /* 输入框距底 + 输入框固定高度：对话框/按钮定位偏移基准 */
  --composer-foot: 45px;
  --composer-h: 130px;
  /* 输入框↔对话框↔按钮 统一间距 */
  --chat-gap: 12px;
}
.chat-dock > * {
  pointer-events: auto;
}

/* ── FAB：accent 实心圆钮，55% 透明 ── */
.fab {
  position: absolute;
  left: 16px;
  bottom: 16px;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: none;
  background: color-mix(in srgb, var(--interactive-accent) 55%, transparent);
  backdrop-filter: blur(20px) saturate(1.4);
  -webkit-backdrop-filter: blur(20px) saturate(1.4);
  color: var(--text-on-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: var(--shadow-m);
  transition:
    transform var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}
.fab:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-l);
  background: color-mix(in srgb, var(--interactive-accent-hover) 55%, transparent);
}
.fab:active {
  transform: translateY(0) scale(0.96);
}
.fab.on {
  background: color-mix(in srgb, var(--background-modifier-active-hover) 55%, transparent);
  color: var(--text-normal);
}

/* ── 输入框定位（居中、贴底） ── */
.chat-stack {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: var(--composer-foot);
  width: var(--chat-w);
}
/* 「对话」按钮：未开时在输入框上方，左对齐输入框左缘 */
.chat-expand {
  position: absolute;
  left: calc(50% - var(--chat-w) / 2);
  transform: none;
  bottom: calc(var(--composer-foot) + var(--composer-h) + var(--chat-gap));
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 14px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--background-modifier-border) 70%, transparent);
  background: color-mix(in srgb, var(--background-primary) 70%, transparent); /* 与输入框/对话框同透明度 */
  backdrop-filter: blur(20px) saturate(1.4);
  -webkit-backdrop-filter: blur(20px) saturate(1.4);
  box-shadow: var(--shadow-m);
  color: var(--text-muted);
  font-size: var(--font-size-s);
  cursor: pointer;
  transition: left var(--dur-norm) var(--ease-out), bottom var(--dur-norm) var(--ease-out), background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.chat-expand:hover {
  box-shadow: var(--shadow-l);
  color: var(--text-normal);
}
/* 对话框打开：按钮融入对话框头部左上角，胶囊标签（与对话框同玻璃） */
.chat-expand.on {
  left: calc(50% - var(--chat-w) / 2 + 14px);
  bottom: calc(var(--composer-foot) + var(--composer-h) + var(--chat-gap) + var(--chat-h) - 40px);
  background: color-mix(in srgb, var(--background-secondary) 60%, transparent);
  border-color: color-mix(in srgb, var(--background-modifier-border) 60%, transparent);
  box-shadow: none;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  color: var(--text-accent);
  padding: 4px 12px;
}
.chat-expand.on:hover {
  color: var(--text-normal);
}

/* ── 对话框：70% 玻璃，紧贴输入框上方 ── */
.chat-window {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(var(--composer-foot) + var(--composer-h) + var(--chat-gap)); /* 输入框顶部 + 间距 */
  width: var(--chat-w);
  height: var(--chat-h);
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-l);
  border: 1px solid color-mix(in srgb, var(--background-modifier-border) 70%, transparent);
  box-shadow: var(--shadow-l);
  overflow: hidden;
  background: color-mix(in srgb, var(--background-primary) 70%, transparent);
  backdrop-filter: blur(20px) saturate(1.4);
  -webkit-backdrop-filter: blur(20px) saturate(1.4);
  animation: dock-in var(--dur-norm) var(--ease-out);
}
/* 头部占位：对话按钮融入的纵向空间 */
.window-head {
  height: 40px;
  flex-shrink: 0;
}
.window-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
@keyframes dock-in {
  from {
    opacity: 0;
    transform: translateX(-50%) translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
}

/* ── 输入框：Codex 风格（与工作台对话一致） ── */
.chat-composer {
  flex-shrink: 0;
}
.composer-box {
  border: 1px solid color-mix(in srgb, var(--background-modifier-border) 70%, transparent);
  border-radius: var(--radius-l);
  background: color-mix(in srgb, var(--background-primary) 70%, transparent); /* 与对话框/按钮同透明度 */
  backdrop-filter: blur(20px) saturate(1.4);
  -webkit-backdrop-filter: blur(20px) saturate(1.4);
  box-shadow: var(--shadow-m);
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
/* 章节自定义下拉菜单（向上弹出，与 composer-box 玻璃风格一致） */
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
  box-shadow: var(--shadow-m);
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
  min-height: 70px;
  box-sizing: border-box; /* 70 含内边距，保证整体 ≤130px */
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
  padding: 2px 12px 6px;
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
  font-family: var(--font-ui); /* UI 字体，清晰可读 */
  font-weight: 500;
  line-height: 1.4; /* line-height:1 会裁掉中文字体上下部（11px 盒高 < 13px 文字） */
  letter-spacing: 0.01em;
  outline: none;
  cursor: pointer;
  padding: 0;
}
.chat-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
/* 宽度由 JS 测量贴合当前选中项（兜底上限防超长模型名溢出） */
.chat-model {
  max-width: 300px;
  white-space: nowrap;
}
.chat-effort {
  max-width: 96px;
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
</style>