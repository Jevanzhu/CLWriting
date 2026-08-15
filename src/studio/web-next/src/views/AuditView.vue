<script setup lang="ts">
// F1-P5 审计视图：事件重放 + 遮蔽差异（模型可见 vs 人类可见）+ 工作流链路。
// 只读审计——展示「模型看到的 vs 人类看到的」差异，以及每本书的事件流与血缘引用。
import { ref, computed, onMounted } from 'vue'
import {
  ScrollText, Eye, EyeOff, GitBranch, RefreshCw, AlertCircle,
  User, Bot, Wrench, ChevronRight, ChevronDown,
} from 'lucide-vue-next'
import { getAudit, type AuditEventFE, type AuditNodeFE, type AuditViewFE } from '../api/audit'
import { friendlyError } from '../shared/error'

const props = defineProps<{ bookName: string }>()

const view = ref<AuditViewFE | null>(null)
const loading = ref(true)
const err = ref<string | null>(null)
/** 事件重放展开的 seq 集合（点开看 data / 血缘） */
const expanded = ref<Set<number>>(new Set())
/** 差异视图模式：'model' | 'human' */
const diffMode = ref<'model' | 'human'>('model')
/** 工作流 tab：'events' | 'workflow' */
const tab = ref<'convo' | 'workflow'>('convo')

async function load(): Promise<void> {
  loading.value = true
  err.value = null
  try {
    view.value = await getAudit(props.bookName)
  } catch (e) {
    err.value = friendlyError(e)
  } finally {
    loading.value = false
  }
}

onMounted(load)

function toggle(seq: number): void {
  const s = new Set(expanded.value)
  if (s.has(seq)) s.delete(seq)
  else s.add(seq)
  expanded.value = s
}

/** 事件类型 → 展示标签（去前缀，如 assistant/message → assistant·message） */
function typeLabel(t: string): string {
  return t.replace('/', '·')
}

/** F5：goal 状态 → 中文标签 */
function goalStateLabel(s: string): string {
  return s === 'active' ? '进行中' : s === 'paused' ? '已暂停' : s === 'blocked' ? '被阻断' : s === 'complete' ? '已完成' : s
}

/** data 摘要（取几个常见字段，避免大对象撑爆列表） */
function dataSummary(e: AuditEventFE): string {
  const d = e.data
  if (typeof d['message'] === 'string') return String(d['message']).slice(0, 60)
  if (typeof d['task'] === 'string') return String(d['task'])
  if (typeof d['callId'] === 'string') return String(d['callId'])
  if (typeof d['chapter'] === 'number') return 'chapter ' + String(d['chapter'])
  // F5：goal/change（动词 + 标题 + 状态）+ todo/write（完成数/总数）
  if (typeof d['operation'] === 'string' && d['goal'] && typeof d['goal'] === 'object') {
    const g = d['goal'] as { title?: unknown; state?: unknown }
    return [d['operation'], typeof g.title === 'string' ? g.title : '', typeof g.state === 'string' ? '[' + g.state + ']' : ''].join(' ').trim().slice(0, 60)
  }
  if (Array.isArray(d['todos'])) {
    const ts = d['todos'] as { state?: unknown }[]
    const done = ts.filter((t) => t.state === 'completed').length
    return 'todos ' + done + '/' + ts.length
  }
  return ''
}

/** 差异节点角色图标 */
function roleIcon(n: AuditNodeFE): string {
  return n.role === 'user' ? 'user' : 'assistant'
}

/** 差异列表：当前模式下的节点（model = 未遮蔽；human = 全量） */
const diffNodes = computed<AuditNodeFE[]>(() => {
  const c = view.value?.conversation
  if (!c) return []
  return diffMode.value === 'model' ? c.modelVisible : c.humanVisible
})
</script>

<template>
  <div class="audit-scroll">
    <header class="audit-head">
      <div class="head-left">
        <h1 class="audit-title">事件审计</h1>
        <span v-if="view?.conversation" class="shadow-hint">
          <EyeOff :size="13" /> 遮蔽 {{ view.conversation.shadowedCount }} · 可见
          {{ view.conversation.modelVisible.length }} / 人类 {{ view.conversation.humanVisible.length }}
        </span>
        <span v-else-if="!loading && !err" class="shadow-hint">本库尚无对话事件</span>
      </div>
      <button class="reload-btn" :disabled="loading" @click="load">
        <RefreshCw :size="14" :class="{ spin: loading }" /> 刷新
      </button>
    </header>

    <p v-if="err" class="audit-err"><AlertCircle :size="14" /> {{ err }}</p>

    <template v-if="view">
      <!-- tab 切换 -->
      <div class="tabbar">
        <button :class="{ on: tab === 'convo' }" @click="tab = 'convo'">
          <ScrollText :size="14" /> 对话审计
        </button>
        <button :class="{ on: tab === 'workflow' }" @click="tab = 'workflow'">
          <GitBranch :size="14" /> 工作流链路（{{ view.workflowEvents.length }}）
        </button>
      </div>

      <!-- 对话审计：重放 + 遮蔽差异 -->
      <template v-if="tab === 'convo'">
        <template v-if="view.conversation">
          <!-- 遮蔽差异：模型可见 vs 人类可见 对照 -->
          <section class="sec">
            <h2 class="sec-title">
              遮蔽差异
              <span class="seg">
                <button :class="{ on: diffMode === 'model' }" @click="diffMode = 'model'">
                  <Eye :size="13" /> 模型可见
                </button>
                <button :class="{ on: diffMode === 'human' }" @click="diffMode = 'human'">
                  <EyeOff :size="13" /> 人类可见（含遮蔽）
                </button>
              </span>
            </h2>
            <div class="diff-list">
              <div
                v-for="n in diffNodes"
                :key="n.seq"
                class="diff-row"
                :class="{ shadowed: n.shadowed }"
              >
                <span class="seq">#{{ n.seq }}</span>
                <span class="role" :class="n.role">
                  <User v-if="roleIcon(n) === 'user'" :size="12" />
                  <Bot v-else :size="12" />
                  {{ n.role }}
                </span>
                <span class="kind">{{ n.kind }}</span>
                <span class="preview">{{ n.preview || '（空）' }}</span>
                <span v-if="n.shadowed" class="shadowed-mark"><EyeOff :size="12" /> 被遮蔽</span>
              </div>
              <div v-if="diffNodes.length === 0" class="empty">无可视消息</div>
            </div>
          </section>

          <!-- 事件重放（全量含遮蔽标记 + 血缘） -->
          <section class="sec">
            <h2 class="sec-title">事件重放（{{ view.conversation.events.length }}）</h2>
            <div class="ev-list">
              <div v-for="e in view.conversation.events" :key="e.seq" class="ev-row">
                <button class="ev-toggle" @click="toggle(e.seq)">
                  <ChevronRight v-if="!expanded.has(e.seq)" :size="13" />
                  <ChevronDown v-else :size="13" />
                </button>
                <span class="ev-seq" :class="{ shadowed: e.shadowed }">#{{ e.seq }}</span>
                <span class="ev-type" :class="{ shadowed: e.shadowed }">{{ typeLabel(e.type) }}</span>
                <span v-if="e.surfaceOp" class="ev-op" :class="e.surfaceOp">{{ e.surfaceOp }}</span>
                <span class="ev-summary">{{ dataSummary(e) }}</span>
                <span v-if="e.shadowed" class="ev-shadow"><EyeOff :size="11" /> 遮蔽</span>
                <span v-if="e.sourceSeqs?.length" class="ev-lineage">
                  <GitBranch :size="11" /> {{ e.sourceSeqs.join(',') }}
                </span>
                <div v-if="expanded.has(e.seq)" class="ev-detail">
                  <pre>{{ JSON.stringify(e.data, null, 2) }}</pre>
                  <p v-if="e.sourceSeqs?.length" class="lineage-note">
                    血缘引用（sourceSeqs）指向事件：#{{ e.sourceSeqs.join(' #') }} —— 每个引用都可在上方事件流定位。
                  </p>
                </div>
              </div>
              <div v-if="view.conversation.events.length === 0" class="empty">暂无事件</div>
            </div>
          </section>
        </template>
        <div v-else class="empty big">本库尚无对话事件（先发一条对话消息）</div>
      </template>

      <!-- 工作流链路 -->
      <template v-else>
        <!-- F5：当前目标 / 任务清单（goal/todo 重放快照） -->
        <section v-if="view.goals.length > 0 || view.todos.length > 0" class="sec">
          <h2 class="sec-title">当前状态（goal / todo）</h2>
          <div class="goal-list">
            <div v-for="g in view.goals" :key="g.id" class="goal-row">
              <span class="goal-state" :data-state="g.state">{{ goalStateLabel(g.state) }}</span>
              <span class="goal-title">{{ g.title }}</span>
              <span class="goal-meta">
                轮次 {{ g.roundsStarted }}{{ g.maxGoalRounds !== undefined ? '/' + g.maxGoalRounds : '' }}
                <template v-if="g.blockedReason"> · {{ g.blockedReason }}</template>
              </span>
            </div>
          </div>
          <div v-if="view.todos.length > 0" class="todo-list">
            <span v-for="(t, i) in view.todos" :key="i" class="todo-item" :data-state="t.state">
              {{ t.state === 'completed' ? '✓' : t.state === 'in_progress' ? '◐' : '○' }} {{ t.text }}
            </span>
          </div>
        </section>

        <section class="sec">
          <h2 class="sec-title">工作流事件（{{ view.workflowEvents.length }}）</h2>
          <div class="ev-list">
            <div v-for="e in view.workflowEvents" :key="e.seq" class="ev-row">
              <button class="ev-toggle" @click="toggle(e.seq)">
                <ChevronRight v-if="!expanded.has(e.seq)" :size="13" />
                <ChevronDown v-else :size="13" />
              </button>
              <span class="ev-seq">#{{ e.seq }}</span>
              <span class="ev-type">{{ typeLabel(e.type) }}</span>
              <span class="ev-summary">{{ dataSummary(e) }}</span>
              <div v-if="expanded.has(e.seq)" class="ev-detail">
                <pre>{{ JSON.stringify(e.data, null, 2) }}</pre>
              </div>
            </div>
            <div v-if="view.workflowEvents.length === 0" class="empty">暂无工作流事件（运行一次 AI 写作后可见）</div>
          </div>
        </section>
      </template>
    </template>

    <div v-else-if="loading" class="empty big">加载中…</div>
  </div>
</template>

<style scoped>
.audit-scroll {
  max-width: 980px;
  margin: 0 auto;
  padding: var(--size-4-4) var(--size-4-4) var(--size-4-6);
}
.audit-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--size-4-4);
  flex-wrap: wrap;
  gap: var(--size-4-3);
}
.head-left {
  display: flex;
  align-items: center;
  gap: var(--size-4-3);
  flex-wrap: wrap;
}
.audit-title {
  font-size: 1.35rem;
  margin: 0;
}
.shadow-hint {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-dim);
  font-size: 0.8rem;
}
.reload-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  cursor: pointer;
  font-size: 0.82rem;
}
.reload-btn:disabled { opacity: 0.5; cursor: default; }
.spin { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.audit-err {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--danger, #d35400);
  margin-bottom: var(--size-4-3);
}
.tabbar {
  display: flex;
  gap: 6px;
  margin-bottom: var(--size-4-4);
}
.tabbar button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text-dim);
  cursor: pointer;
  font-size: 0.85rem;
}
.tabbar button.on {
  background: var(--accent);
  color: var(--accent-contrast, #fff);
}
.sec { margin-bottom: var(--size-4-5); }
.sec-title {
  display: flex;
  align-items: center;
  gap: var(--size-4-3);
  font-size: 1rem;
  margin: 0 0 var(--size-4-3);
  flex-wrap: wrap;
}
.seg {
  display: inline-flex;
  gap: 4px;
  margin-left: auto;
}
.seg button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 0.75rem;
}
.seg button.on {
  background: var(--accent);
  color: var(--accent-contrast, #fff);
  border-color: transparent;
}
.diff-list, .ev-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.diff-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  font-size: 0.82rem;
}
.diff-row.shadowed {
  opacity: 0.55;
  background: var(--bg);
}
.seq, .ev-seq {
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  min-width: 2.4em;
}
.role {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  text-transform: capitalize;
  font-size: 0.72rem;
}
.kind { color: var(--text-dim); font-size: 0.72rem; }
.preview { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.shadowed-mark {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--danger, #d35400);
  font-size: 0.7rem;
}
.ev-row {
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-elev);
  padding: 4px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.82rem;
  flex-wrap: wrap;
}
.ev-toggle {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-dim);
  display: inline-flex;
  padding: 0;
}
.ev-seq.shadowed { color: var(--danger, #d35400); }
.ev-type {
  font-family: var(--font-mono);
  color: var(--accent);
  font-size: 0.74rem;
}
.ev-type.shadowed { color: var(--text-dim); text-decoration: line-through; }
.ev-op {
  font-size: 0.68rem;
  padding: 1px 6px;
  border-radius: 5px;
  border: 1px solid var(--border);
}
.ev-op.replace { color: var(--danger, #d35400); border-color: var(--danger, #d35400); }
.ev-summary { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); }
.ev-shadow, .ev-lineage {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 0.7rem;
  color: var(--text-dim);
}
.ev-shadow { color: var(--danger, #d35400); }
.ev-detail {
  flex-basis: 100%;
  padding: 6px 0 4px;
}
.ev-detail pre {
  margin: 0;
  max-height: 200px;
  overflow: auto;
  font-size: 0.72rem;
  background: var(--bg);
  border-radius: 6px;
  padding: 8px;
  white-space: pre-wrap;
  word-break: break-all;
}
.lineage-note { font-size: 0.72rem; color: var(--text-dim); margin: 4px 0 0; }
.empty { color: var(--text-dim); font-size: 0.82rem; padding: 8px; }
.empty.big { padding: 40px; text-align: center; }

/* F5：当前 goal/todo 面板 */
.goal-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: var(--size-4-3);
}
.goal-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  font-size: 0.82rem;
  flex-wrap: wrap;
}
.goal-state {
  font-size: 0.72rem;
  padding: 1px 8px;
  border-radius: 9px;
  border: 1px solid var(--border);
  color: var(--text-dim);
  white-space: nowrap;
}
.goal-state[data-state='active'] { color: var(--accent); border-color: var(--accent); }
.goal-state[data-state='blocked'] { color: var(--danger, #d35400); border-color: var(--danger, #d35400); }
.goal-state[data-state='complete'] { color: var(--color-green, #3e9e51); border-color: var(--color-green, #3e9e51); }
.goal-title { font-weight: 600; }
.goal-meta { color: var(--text-dim); font-size: 0.75rem; }
.todo-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.todo-item {
  font-size: 0.78rem;
  padding: 3px 10px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
}
.todo-item[data-state='completed'] { color: var(--text-dim); }
.todo-item[data-state='in_progress'] { border-color: var(--accent); }
</style>
