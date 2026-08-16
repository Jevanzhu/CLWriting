<script setup lang="ts">
// F1-P5 审计视图：事件重放 + 遮蔽差异（模型可见 vs 人类可见）+ 工作流链路。
// 只读审计——展示「模型看到的 vs 人类看到的」差异，以及每本书的事件流与血缘引用。
// AA-P2-1：长书 >500 条事件分页续页——后端按 limit/offset 截断，前端「加载更多」累积追加
// 并显式提示「已显示 X / N」（此前无翻页入口，>500 条旧事件结构上永远不可见）。
import { ref, computed, onMounted } from 'vue'
import {
  ScrollText, Eye, EyeOff, GitBranch, RefreshCw, AlertCircle,
  User, Bot, Wrench, ChevronRight, ChevronDown, MoreHorizontal,
} from 'lucide-vue-next'
import { getAudit, clearAudit, type AuditConversationFE, type AuditEventFE, type AuditNodeFE, type GoalFE, type TodoFE } from '../api/audit'
import { friendlyError } from '../shared/error'

const props = defineProps<{ bookName: string }>()

const loading = ref(true)
const err = ref<string | null>(null)
/** 对话审计头部（投影/遮蔽差异；每页响应同源——foldSurface 全量计算，各页一致） */
const conversation = ref<AuditConversationFE | null>(null)
/** 累积的对话事件（跨页追加，按 seq 去重） */
const convoEvents = ref<AuditEventFE[]>([])
const convoTotal = ref(0)
const convoLoadingMore = ref(false)
/** 已载条数（= 下页 offset 起点） */
const convoOffset = ref(0)
/** 累积的工作流事件 */
const workflowEvents = ref<AuditEventFE[]>([])
const workflowTotal = ref(0)
const workflowLoadingMore = ref(false)
const workflowOffset = ref(0)
const goals = ref<GoalFE[]>([])
const todos = ref<TodoFE[]>([])
/** 事件重放展开的 seq 集合（点开看 data / 血缘） */
const expanded = ref<Set<number>>(new Set())
/** 差异视图模式：'model' | 'human' */
const diffMode = ref<'model' | 'human'>('model')
/** 工作流 tab：'convo' | 'workflow' */
const tab = ref<'convo' | 'workflow'>('convo')

/** 每页上限（与服务端 DEFAULT_PAGE_LIMIT 对齐） */
const PAGE_LIMIT = 500

const hasMoreConvo = computed(() => convoEvents.value.length < convoTotal.value)
const hasMoreWorkflow = computed(() => workflowEvents.value.length < workflowTotal.value)

async function load(): Promise<void> {
  loading.value = true
  err.value = null
  conversation.value = null
  convoEvents.value = []
  convoTotal.value = 0
  convoOffset.value = 0
  workflowEvents.value = []
  workflowTotal.value = 0
  workflowOffset.value = 0
  goals.value = []
  todos.value = []
  try {
    const v = await getAudit(props.bookName, { limit: PAGE_LIMIT, offset: 0 })
    conversation.value = v.conversation
    convoEvents.value = v.conversation?.events ?? []
    convoTotal.value = v.conversation?.eventsTotal ?? 0
    convoOffset.value = convoEvents.value.length
    workflowEvents.value = v.workflowEvents ?? []
    workflowTotal.value = v.workflowTotal ?? 0
    workflowOffset.value = workflowEvents.value.length
    goals.value = v.goals ?? []
    todos.value = v.todos ?? []
  } catch (e) {
    err.value = friendlyError(e)
  } finally {
    loading.value = false
  }
}

/** 追加下一页对话事件（offset = 已载条数；seq 去重防 sync/重复请求混入） */
async function loadMoreConvo(): Promise<void> {
  if (convoLoadingMore.value || !hasMoreConvo.value) return
  convoLoadingMore.value = true
  err.value = null
  try {
    const v = await getAudit(props.bookName, { limit: PAGE_LIMIT, offset: convoOffset.value })
    if (conversation.value === null) conversation.value = v.conversation
    const seen = new Set(convoEvents.value.map((e) => e.seq))
    const fresh = (v.conversation?.events ?? []).filter((e) => !seen.has(e.seq))
    convoEvents.value.push(...fresh)
    convoOffset.value = convoEvents.value.length
  } catch (e) {
    err.value = friendlyError(e)
  } finally {
    convoLoadingMore.value = false
  }
}

/** 追加下一页工作流事件（对称实现；长自愈批的链路事件也可能超 500） */
async function loadMoreWorkflow(): Promise<void> {
  if (workflowLoadingMore.value || !hasMoreWorkflow.value) return
  workflowLoadingMore.value = true
  err.value = null
  try {
    const v = await getAudit(props.bookName, { limit: PAGE_LIMIT, offset: workflowOffset.value })
    const seen = new Set(workflowEvents.value.map((e) => e.seq))
    const fresh = (v.workflowEvents ?? []).filter((e) => !seen.has(e.seq))
    workflowEvents.value.push(...fresh)
    workflowOffset.value = workflowEvents.value.length
  } catch (e) {
    err.value = friendlyError(e)
  } finally {
    workflowLoadingMore.value = false
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
  const c = conversation.value
  if (!c) return []
  return diffMode.value === 'model' ? c.modelVisible : c.humanVisible
})

// ── 事件保留定版（2026-08-16 拍板：全量保留 + 手动清理）──────────────
// 事件史默认 append-only 全量保留；此处是每书唯一清理入口，两步确认（销毁不可撤销）。
const clearing = ref(false)
const confirmClear = ref(false)

async function doClear(): Promise<void> {
  if (clearing.value) return
  clearing.value = true
  err.value = null
  try {
    await clearAudit(props.bookName)
    confirmClear.value = false
    await load()
  } catch (e) {
    err.value = friendlyError(e)
  } finally {
    clearing.value = false
  }
}
</script>

<template>
  <div class="audit-scroll">
    <header class="audit-head">
      <div class="head-left">
        <h1 class="audit-title">事件审计</h1>
        <span v-if="conversation" class="shadow-hint">
          <EyeOff :size="13" /> 遮蔽 {{ conversation.shadowedCount }} · 可见
          {{ conversation.modelVisible.length }} / 人类 {{ conversation.humanVisible.length }}
        </span>
        <span v-else-if="!loading && !err" class="shadow-hint">本库尚无对话事件</span>
      </div>
      <div class="head-actions">
        <!-- 事件保留定版：每书事件史清理入口（两步确认——销毁不可撤销） -->
        <button v-if="!confirmClear" class="reload-btn danger" :disabled="loading || clearing" @click="confirmClear = true">
          清除事件史…
        </button>
        <template v-else>
          <span class="clear-hint">清除本书全部事件（对话+工作流），不可撤销？</span>
          <button class="reload-btn danger" :disabled="clearing" @click="doClear">{{ clearing ? '清除中…' : '确认清除' }}</button>
          <button class="reload-btn" :disabled="clearing" @click="confirmClear = false">取消</button>
        </template>
        <button class="reload-btn" :disabled="loading" @click="load">
          <RefreshCw :size="14" :class="{ spin: loading }" /> 刷新
        </button>
      </div>
    </header>

    <p v-if="err" class="audit-err"><AlertCircle :size="14" /> {{ err }}</p>

    <template v-if="!loading">
      <!-- tab 切换 -->
      <div class="tabbar">
        <button :class="{ on: tab === 'convo' }" @click="tab = 'convo'">
          <ScrollText :size="14" /> 对话审计
          <span v-if="convoTotal > 0" class="tab-total">{{ convoEvents.length }}/{{ convoTotal }}</span>
        </button>
        <button :class="{ on: tab === 'workflow' }" @click="tab = 'workflow'">
          <GitBranch :size="14" /> 工作流链路（{{ workflowEvents.length }}{{ hasMoreWorkflow ? '/' + workflowTotal : '' }}）
        </button>
      </div>

      <!-- 对话审计：重放 + 遮蔽差异 -->
      <template v-if="tab === 'convo'">
        <template v-if="conversation">
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

          <!-- 事件重放（分页累积，含遮蔽标记 + 血缘） -->
          <section class="sec">
            <h2 class="sec-title">事件重放（{{ convoEvents.length }}{{ hasMoreConvo ? ' / 共 ' + convoTotal : '' }}）</h2>
            <div class="ev-list">
              <div v-for="e in convoEvents" :key="e.seq" class="ev-row">
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
              <div v-if="convoEvents.length === 0" class="empty">暂无事件</div>
            </div>
            <!-- AA-P2-1：截断提示 + 续页入口（长书 >500 条可见「已显示 X / N」并可翻到底） -->
            <div v-if="hasMoreConvo" class="pager">
              <span class="pager-hint">已显示 {{ convoEvents.length }} / {{ convoTotal }} 条，更多最早事件待加载</span>
              <button class="load-more" :disabled="convoLoadingMore" @click="loadMoreConvo">
                <MoreHorizontal :size="14" :class="{ spin: convoLoadingMore }" />
                {{ convoLoadingMore ? '加载中…' : '加载更多' }}
              </button>
            </div>
          </section>
        </template>
        <div v-else class="empty big">本库尚无对话事件（先发一条对话消息）</div>
      </template>

      <!-- 工作流链路 -->
      <template v-else>
        <!-- F5：当前目标 / 任务清单（goal/todo 重放快照） -->
        <section v-if="goals.length > 0 || todos.length > 0" class="sec">
          <h2 class="sec-title">当前状态（goal / todo）</h2>
          <div class="goal-list">
            <div v-for="g in goals" :key="g.id" class="goal-row">
              <span class="goal-state" :data-state="g.state">{{ goalStateLabel(g.state) }}</span>
              <span class="goal-title">{{ g.title }}</span>
              <span class="goal-meta">
                轮次 {{ g.roundsStarted }}{{ g.maxGoalRounds !== undefined ? '/' + g.maxGoalRounds : '' }}
                <template v-if="g.blockedReason"> · {{ g.blockedReason }}</template>
              </span>
            </div>
          </div>
          <div v-if="todos.length > 0" class="todo-list">
            <span v-for="(t, i) in todos" :key="i" class="todo-item" :data-state="t.state">
              {{ t.state === 'completed' ? '✓' : t.state === 'in_progress' ? '◐' : '○' }} {{ t.text }}
            </span>
          </div>
        </section>

        <section class="sec">
          <h2 class="sec-title">工作流事件（{{ workflowEvents.length }}{{ hasMoreWorkflow ? ' / 共 ' + workflowTotal : '' }}）</h2>
          <div class="ev-list">
            <div v-for="e in workflowEvents" :key="e.seq" class="ev-row">
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
            <div v-if="workflowEvents.length === 0" class="empty">暂无工作流事件（运行一次 AI 写作后可见）</div>
          </div>
          <div v-if="hasMoreWorkflow" class="pager">
            <span class="pager-hint">已显示 {{ workflowEvents.length }} / {{ workflowTotal }} 条，更多最早事件待加载</span>
            <button class="load-more" :disabled="workflowLoadingMore" @click="loadMoreWorkflow">
              <MoreHorizontal :size="14" :class="{ spin: workflowLoadingMore }" />
              {{ workflowLoadingMore ? '加载中…' : '加载更多' }}
            </button>
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
.head-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--size-4-2);
  flex-wrap: wrap;
}
/* 事件保留定版：销毁动作红色 + 确认提示 */
.reload-btn.danger { color: var(--text-error); border-color: var(--text-error); }
.clear-hint {
  color: var(--text-error);
  font-size: 0.8rem;
}
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
.tab-total {
  margin-left: 5px;
  font-size: 0.72rem;
  opacity: 0.85;
}
.sec { margin-bottom: var(--size-4-5); }
/* AA-P2-1：分页续页 */
.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--size-4-3);
  margin-top: var(--size-4-3);
  flex-wrap: wrap;
}
.pager-hint {
  color: var(--text-dim);
  font-size: 0.78rem;
}
.load-more {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  cursor: pointer;
  font-size: 0.8rem;
}
.load-more:disabled { opacity: 0.55; cursor: default; }
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
