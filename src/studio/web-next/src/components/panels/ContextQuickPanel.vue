<script setup lang="ts">
// 上下文速查面板（细案 T2.3）：设定区文件速查（点开开 tab）+ AI 设定问答（问书）。
import { ref, computed } from 'vue'
import { CornerDownLeft, Send, Loader2, Sparkles, AlertCircle, MessageCircle } from 'lucide-vue-next'
import { useTreeStore } from '../../stores/tree'
import { useDocStore } from '../../stores/doc'
import { useWorkspaceStore } from '../../stores/workspace'
import { useUiStore } from '../../stores/ui'
import { serverOnline } from '../../composables/useHeartbeat'
import { askBook } from '../../api/ask'
import EmptyState from '../ui/EmptyState.vue'
import type { TreeNode } from '../../types/tree'

const props = defineProps<{ bookName: string }>()
const tree = useTreeStore()
const doc = useDocStore()
const ws = useWorkspaceStore()
const ui = useUiStore()

// 设定区叶子（递归 定稿/设定 组）
const settings = computed<TreeNode[]>(() => {
  const out: TreeNode[] = []
  const shezhi = tree.grouped.find((n) => n.path === '定稿/设定')
  const walk = (ns: TreeNode[]): void => {
    for (const n of ns) {
      if (!n.isDirectory) out.push(n)
      else if (n.children.length) walk(n.children)
    }
  }
  if (shezhi) walk(shezhi.children)
  return out
})

async function open(node: TreeNode): Promise<void> {
  if (!node.docId) return
  try {
    await doc.open(node)
    ws.openTab(node.docId)
  } catch {
    /* 打开失败静默 */
  }
}

/** 插入文档名到正文光标（命令管道 → EditorView → CmHost）；无活动文档时跳过。 */
function onInsert(text: string): void {
  if (!ws.activeDocId) return
  ws.requestInsert(text)
}

// ── AI 设定问答（问书）──
const aiOff = computed(() => ui.aiAvailable === false)
const question = ref('')
const answer = ref('')
const asking = ref(false)
const askErr = ref<string | null>(null)

// 四态：idle（引导）→ asking（加载）→ answered（结果）/ errored（失败）
type AskPhase = 'idle' | 'asking' | 'answered' | 'errored'
const askPhase = computed<AskPhase>(() => {
  if (asking.value) return 'asking'
  if (askErr.value) return 'errored'
  if (answer.value) return 'answered'
  return 'idle'
})

async function onAsk(): Promise<void> {
  const q = question.value.trim()
  if (!q || asking.value) return
  asking.value = true
  askErr.value = null
  answer.value = ''
  try {
    const r = await askBook(props.bookName, q)
    answer.value = r.answer ?? ''
  } catch (e) {
    askErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    asking.value = false
  }
}
</script>

<template>
  <div class="ctx-panel">
    <div class="side-title">设定速查</div>
    <div v-if="!settings.length" class="side-hint">无设定文档</div>
    <div v-else class="setting-list">
      <div
        v-for="s in settings"
        :key="s.docId"
        class="setting-item"
        @click="open(s)"
      >
        <span class="setting-name">{{ s.name }}</span>
        <button
          class="insert-btn"
          data-tip="插入到正文光标处"
          @click.stop="onInsert(s.name)"
        >
          <CornerDownLeft :size="13" />
        </button>
      </div>
    </div>

    <!-- AI 顾问（问书）：设定文件全量拼 prompt → spawnRole 回答 -->
    <div class="ai-slot" :class="{ disabled: aiOff || !serverOnline }">
      <div class="side-title ai-title">
        <Sparkles :size="12" class="ai-title-icon" />
        <span>问书</span>
      </div>
      <EmptyState
        v-if="aiOff || !serverOnline"
        :icon="Sparkles"
        size="compact"
        :text="!serverOnline ? 'API 未连接' : 'AI 不可达'"
      />
      <div v-else class="ask-area">
        <!-- 输入行 -->
        <div class="ask-input-row">
          <input
            v-model="question"
            class="ask-input"
            placeholder="问一个设定问题…"
            :disabled="asking"
            @keydown.enter="onAsk"
          />
          <button class="ask-btn" :disabled="!question.trim() || asking" @click="onAsk">
            <Loader2 v-if="asking" :size="13" class="spin" />
            <Send v-else :size="13" />
          </button>
        </div>
        <!-- 四态过渡（idle / asking / answered / errored）-->
        <Transition name="clw-fade" mode="out-in">
          <div v-if="askPhase === 'asking'" key="asking" class="ask-loading">
            <span class="ask-dot" />
            <span class="ask-dot" />
            <span class="ask-dot" />
          </div>
          <div v-else-if="askPhase === 'errored'" key="err" class="ask-err">
            <AlertCircle :size="13" class="ask-err-icon" />
            <span>{{ askErr }}</span>
          </div>
          <div v-else-if="askPhase === 'answered'" key="answer" class="ask-answer">
            {{ answer }}
          </div>
          <div v-else key="idle" class="ask-idle">
            <MessageCircle :size="13" />
            <span>问任何关于角色、世界观、设定的问题</span>
          </div>
        </Transition>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ctx-panel {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
}
.side-title {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.side-hint {
  font-size: var(--font-size-s);
  color: var(--text-faint);
}
.setting-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.setting-item {
  font-size: var(--font-size-s);
  color: var(--text-muted);
  padding: 5px var(--size-4-2);
  border-radius: var(--radius-s);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
}
.setting-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.insert-btn {
  flex-shrink: 0;
  display: flex;
  color: var(--text-faint);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
}
.insert-btn:hover {
  color: var(--text-accent);
}
.setting-item:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}

/* ── AI 顾问（问书）── */
.ai-slot {
  margin-top: var(--size-4-4);
  padding-top: var(--size-4-3);
  border-top: 1px solid var(--background-modifier-border);
  display: flex;
  flex-direction: column;
  gap: var(--size-4-4);
}
.ai-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-muted);
}
.ai-title-icon {
  color: var(--interactive-accent);
}
.ai-slot.disabled {
  opacity: 0.5;
}

.ask-area {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
}

/* 输入行 */
.ask-input-row {
  display: flex;
  gap: 6px;
}
.ask-input {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  font-size: var(--font-size-s);
  transition: border-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}
.ask-input:focus {
  outline: none;
  border-color: var(--interactive-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive-accent) 18%, transparent);
}
.ask-input::placeholder {
  color: var(--text-faint);
}
.ask-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.ask-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--radius-s);
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.ask-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.ask-btn:hover:not(:disabled) {
  background: var(--interactive-accent-hover);
}
.ask-btn:active:not(:disabled) {
  transform: scale(0.92);
}
.spin {
  animation: ask-spin 0.9s linear infinite;
}
@keyframes ask-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 四态过渡 */
.clw-fade-enter-active,
.clw-fade-leave-active {
  transition: opacity var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.clw-fade-enter-from {
  opacity: 0;
  transform: translateY(4px);
}
.clw-fade-leave-to {
  opacity: 0;
  transform: translateY(-2px);
}

/* idle 引导 */
.ask-idle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  padding: 2px 2px;
}

/* loading 三点脉冲 */
.ask-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: var(--size-4-2) 0;
}
.ask-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--interactive-accent);
  opacity: 0.4;
  animation: ask-pulse 1.2s var(--ease-std) infinite;
}
.ask-dot:nth-child(2) {
  animation-delay: 0.15s;
}
.ask-dot:nth-child(3) {
  animation-delay: 0.3s;
}
@keyframes ask-pulse {
  0%, 60%, 100% {
    opacity: 0.3;
    transform: scale(0.8);
  }
  30% {
    opacity: 1;
    transform: scale(1.1);
  }
}

/* 回答卡片 */
.ask-answer {
  font-size: var(--font-size-s);
  color: var(--text-normal);
  line-height: 1.65;
  white-space: pre-wrap;
  max-height: 280px;
  overflow-y: auto;
  padding: var(--size-4-2) var(--size-4-3);
  background: var(--background-secondary);
  border-left: 2px solid var(--interactive-accent);
  border-radius: var(--radius-s);
}

/* 错误 */
.ask-err {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: var(--font-size-xs);
  color: var(--text-error);
  background: color-mix(in srgb, var(--text-error) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--text-error) 20%, transparent);
  border-radius: var(--radius-s);
  padding: 6px 8px;
  line-height: 1.5;
}
.ask-err-icon {
  flex-shrink: 0;
  margin-top: 1px;
}
</style>
