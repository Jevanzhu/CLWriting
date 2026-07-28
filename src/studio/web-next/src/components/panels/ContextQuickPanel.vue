<script setup lang="ts">
// 上下文速查面板（细案 T2.3）：设定区文件速查（点开开 tab）+ AI 设定问答（问书）。
import { ref, computed } from 'vue'
import { CornerDownLeft, Send, Loader2 } from 'lucide-vue-next'
import { useTreeStore } from '../../stores/tree'
import { useDocStore } from '../../stores/doc'
import { useWorkspaceStore } from '../../stores/workspace'
import { useUiStore } from '../../stores/ui'
import { serverOnline } from '../../composables/useHeartbeat'
import { askBook } from '../../api/ask'
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
      <div class="side-title">AI 顾问</div>
      <div v-if="aiOff || !serverOnline" class="side-hint">
        {{ !serverOnline ? 'API 未连接' : 'AI 不可达' }}
      </div>
      <div v-else class="ask-area">
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
        <div v-if="askErr" class="ask-err">{{ askErr }}</div>
        <div v-if="answer" class="ask-answer">{{ answer }}</div>
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

/* AI 顾问 */
.ai-slot {
  margin-top: var(--size-4-2);
  padding-top: var(--size-4-2);
  border-top: 1px solid var(--background-modifier-border);
}
.ai-slot.disabled .side-hint {
  color: var(--text-faint);
  opacity: 0.6;
}
.ask-area {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
}
.ask-input-row {
  display: flex;
  gap: 4px;
}
.ask-input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  font-size: var(--font-size-s);
}
.ask-input:focus {
  outline: none;
  border-color: var(--interactive-accent);
}
.ask-input::placeholder {
  color: var(--text-faint);
}
.ask-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  cursor: pointer;
}
.ask-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.ask-btn:hover:not(:disabled) {
  opacity: 0.88;
}
.spin {
  animation: ask-spin 0.9s linear infinite;
}
@keyframes ask-spin {
  to {
    transform: rotate(360deg);
  }
}
.ask-err {
  font-size: var(--font-size-xs);
  color: var(--text-error);
}
.ask-answer {
  font-size: var(--font-size-s);
  color: var(--text-normal);
  line-height: 1.6;
  white-space: pre-wrap;
  max-height: 240px;
  overflow-y: auto;
  padding: var(--size-4-2);
  background: var(--background-secondary);
  border-radius: var(--radius-s);
}
</style>
