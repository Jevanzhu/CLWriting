<script setup lang="ts">
/**
 * 对话消息流（hh §八-16 自 ChatPanel.vue 拆出，纯搬家）。
 * 无气泡感消息流（用户浅卡片右对齐 / AI 纯文本全宽）+ 工具卡确认闸 + G1 变体切换与
 * 重新生成 + 滚动跟随（rAF 节流）。输入区留在 ChatPanel（dock 拆分场景只挂本件时由
 * hideComposer 控制）。selectedChapter 经 props 传入（regenerate 的章号语境）。
 */
import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue'
import { PenLine, ShieldCheck, AlertCircle, Loader2, MessageSquareText, RefreshCw, ChevronLeft, ChevronRight, Info } from 'lucide-vue-next'
import { useChatStore, type ChatMessage } from '../../../stores/chat'
import { confirmTool } from '../../../api/chat'
import { ApiError } from '../../../api/client'
import { useUiStore } from '../../../stores/ui'

const props = defineProps<{
  bookName: string
  /** 重新生成的章号语境（来自 ChatPanel 的 useChatComposer 选择态） */
  selectedChapter?: number
}>()

const chat = useChatStore()
const ui = useUiStore()

// ── 滚动（rAF 节流：流式 chat_text 每帧可能触发多次，同帧只滚一次，P2-FE-7）──

const scrollRef = ref<HTMLElement | null>(null)
let scrollRaf = 0
// R62-51：用户上滚离开底部的距离阈值（px）——流式输出自动滚动只在距底阈值内跟随，
// 上滚读历史时不再被 SSE 流式内容拽回去
const AUTO_FOLLOW_THRESHOLD = 64
/** 距底是否在阈值内（rAF 复用：onScroll 高频，同帧只读一次）允许自动跟随 */
let nearBottom = true
function onScroll(): void {
  const el = scrollRef.value
  if (!el) return
  nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= AUTO_FOLLOW_THRESHOLD
}
/** 滚底。force=false（流式默认）只在用户距底阈值内才滚——上滚读历史不打扰；
 *  force=true（发送后/显式调用）无条件滚底。 */
function scrollToBottom(force = false): void {
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    if (!scrollRef.value) return
    if (force || nearBottom) scrollRef.value.scrollTop = scrollRef.value.scrollHeight
  })
}

// 卸载时取消未完成的 rAF，防回调访问已销毁组件
onBeforeUnmount(() => {
  if (scrollRaf) cancelAnimationFrame(scrollRaf)
})

// ── 消息流滚动跟随 ──────────────────────────────

watch(
  // R32-9：notice 变化同样触发滚底（入队提示在流尾部，不跟随则不可见）
  [() => chat.messages.length, () => chat.messages.at(-1)?.content, () => chat.notice],
  () => void nextTick(scrollToBottom),
)

// 发送后滚底由 ChatPanel 经 ref 调用（useChatComposer 的 onPushed 回调）
defineExpose({ scrollToBottom })

// ── 工具确认 ────────────────────────────────────

// R73-64：确认在途按 callId 记集合（Vue 对 Set.add/delete 不响应，重赋值触发——learn store
// 同款惯例）。原 confirmingCallId 单值把所有待确认卡串行化：多张待确认卡并存时，第二张的
// 点击被入口静默忽略（按钮虽未禁但毫无反应）；改为同卡防重、跨卡并行。
const confirmingCallIds = ref<Set<string>>(new Set())

async function handleConfirm(callId: string, ok: boolean): Promise<void> {
  if (confirmingCallIds.value.has(callId)) return // 防重复点击（仅同卡；跨卡不受阻）
  confirmingCallIds.value = new Set(confirmingCallIds.value).add(callId)
  // R69-28（十七轮）：入口捕获书名——await 窗口切书后，迟到的失败 toast/工具终态
  // 落在新书界面（与 doc.finalize catch 同族守卫）
  const book = props.bookName
  try {
    await confirmTool(book, { callId, ok })
  } catch (e) {
    if (props.bookName !== book) return
    if (e instanceof ApiError && e.status === 404) {
      // R65-50（E-2）：404 = 工具调用已超时失效——修复前静默 return，卡面停留 pending、
      // 确认按钮可反复点但服务端早已丢弃，作者无任何反馈。置失败终态给可见交代
      chat.updateTool(callId, { status: 'failed', summary: '确认已超时：该工具调用已失效' })
      return
    }
    ui.toast('确认请求失败，请重试', 'error')
  } finally {
    const rest = new Set(confirmingCallIds.value)
    rest.delete(callId)
    confirmingCallIds.value = rest
  }
}

// ── 工具图标映射 ─────────────────────────────────

const TOOL_ICONS: Record<string, typeof PenLine> = {
  write_chapter: PenLine,
  check_chapter: ShieldCheck,
}

const TOOL_LABELS: Record<string, string> = {
  write_chapter: '自动写章',
  check_chapter: '机检',
}

// ── G1：重新生成 + 变体切换 ─────────────────────

/** 最后一条已完成的 assistant 气泡（「重新生成」按钮的挂载点；!running 才可点） */
const lastDoneAssistant = computed(() => {
  const last = chat.messages[chat.messages.length - 1]
  return last && last.role === 'assistant' && last.done ? last : null
})

/** 重新生成最后一条回复（服务端以新 branchId 落库，SSE 回流新变体） */
function handleRegenerate(): void {
  void chat.regenerate(props.bookName, props.selectedChapter)
}

/**
 * 各助手消息的变体组定位（msgId → 当前序号/总数/同组分支 id 列表）。
 * 命中条件：消息 seq 落在某分支组区间（rootSeq ≤ seq ≤ lastSeq）且
 * 同 parentSeq 的变体组数 > 1（按 rootSeq 升序稳定排序）。
 */
const variantGroups = computed(() => {
  const map = new Map<string, { index: number; total: number; label: string; branchIds: string[] }>()
  for (const msg of chat.messages) {
    if (msg.role !== 'assistant' || msg.seq === undefined) continue
    const seq = msg.seq
    const group = chat.branches.find((b) => seq >= b.rootSeq && seq <= b.lastSeq)
    if (!group) continue
    const variants = chat.branches
      .filter((b) => b.parentSeq === group.parentSeq)
      .sort((a, b) => a.rootSeq - b.rootSeq)
    const index = variants.findIndex((b) => b.branchId === group.branchId)
    if (index < 0 || variants.length <= 1) continue
    map.set(msg.id, {
      index,
      total: variants.length,
      label: `${index + 1}/${variants.length}`,
      branchIds: variants.map((v) => v.branchId),
    })
  }
  return map
})

/** 切到相邻变体组（首尾循环；运行中禁用） */
function switchVariant(msg: ChatMessage, dir: -1 | 1): void {
  if (chat.running) return
  const g = variantGroups.value.get(msg.id)
  if (!g) return
  const total = g.branchIds.length
  const next = g.branchIds[(g.index + dir + total) % total]
  if (next) void chat.switchBranch(props.bookName, next)
}
</script>

<template>
  <!-- 消息区：无气泡感，用户消息浅卡片右对齐，AI 消息纯文本全宽 -->
  <div ref="scrollRef" class="chat-messages" @scroll="onScroll">
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
        <!-- G1：变体切换器（seq 落在同 parentSeq 的多变体组内时显示；运行中禁用） -->
        <div v-if="variantGroups.has(msg.id)" class="chat-variant">
          <button
            type="button"
            class="chat-variant-btn"
            :disabled="chat.running"
            title="上一个变体"
            @click="switchVariant(msg, -1)"
          >
            <ChevronLeft :size="13" />
          </button>
          <span class="chat-variant-label">{{ variantGroups.get(msg.id)?.label }}</span>
          <button
            type="button"
            class="chat-variant-btn"
            :disabled="chat.running"
            title="下一个变体"
            @click="switchVariant(msg, 1)"
          >
            <ChevronRight :size="13" />
          </button>
        </div>

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

          <!-- 确认按钮（R73-64：仅本卡在途才禁用——其他待确认卡可并行确认） -->
          <div v-if="tool.status === 'pending'" class="chat-tool-confirm">
            <button class="chat-confirm-no" :disabled="confirmingCallIds.has(tool.callId)" @click="handleConfirm(tool.callId, false)">取消</button>
            <button class="chat-confirm-yes" :disabled="confirmingCallIds.has(tool.callId)" @click="handleConfirm(tool.callId, true)">
              <Loader2 v-if="confirmingCallIds.has(tool.callId)" :size="12" class="spin" />
              确认执行
            </button>
          </div>
        </div>

        <!-- G1：最后一条已完成回复尾随「重新生成」（!running 才可用；新 branchId 落库） -->
        <button
          v-if="lastDoneAssistant && msg.id === lastDoneAssistant.id"
          type="button"
          class="chat-regen-btn"
          :disabled="chat.running"
          @click="handleRegenerate"
        >
          <RefreshCw :size="12" />
          <span>重新生成</span>
        </button>
      </div>
    </template>

    <!-- 错误 -->
    <div v-if="chat.error" class="chat-error-msg">
      <AlertCircle :size="14" />
      <span>{{ chat.error }}</span>
    </div>

    <!-- R32-9（三十二轮）：非错误提示（E1a steer 入队确认 / AA-P3-1 队列超容丢弃等
         chat.notice）——此前全前端无渲染点：发送即清空输入框、运行中追加零反馈，
         作者无法得知「已入队」。消息流内联展示（对齐 error 区样式，中性色）。 -->
    <div v-if="chat.notice" class="chat-notice-msg">
      <Info :size="14" />
      <span>{{ chat.notice }}</span>
    </div>
  </div>
</template>

<style scoped>
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

/* ── R32-9：非错误提示（notice，中性色对齐 error 区布局） ── */
.chat-notice-msg {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: var(--font-size-s);
  padding: var(--size-4-2);
  border-radius: var(--radius-s);
  background: var(--background-secondary);
}

/* ── G1：变体切换器 + 重新生成 ── */
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
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
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
  transition: border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
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

/* 动画 */
.spin {
  animation: clw-spin 1s linear infinite;
}

</style>
