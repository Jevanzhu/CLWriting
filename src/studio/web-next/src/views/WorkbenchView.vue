<script setup lang="ts">
// 工作台写作模式：状态卡（人话）+ 生成/中断 + 正文预览（默认主区）+ 存草稿并编辑。
// 事件流 / 阶段任务 / CLI 报告收「高级」折叠区（M4 去机器味：作者看文章，调试功能全保留）。
import { ref, watch, computed } from 'vue'
import { Activity, CircleCheck, Sparkles, TriangleAlert } from 'lucide-vue-next'
import { useWorkbenchStore } from '../stores/workbench'
import { useWorkspaceStore } from '../stores/workspace'
import { useTreeStore } from '../stores/tree'
import {
  getState,
  spawnRole,
  interrupt,
  saveDraft,
  autoWrite,
  getDraftPrompt,
  generateOutline,
  type BookState,
} from '../api/stream'
import { useUiStore } from '../stores/ui'
import EmptyState from '../components/ui/EmptyState.vue'
import CollapseSection from '../components/ui/CollapseSection.vue'

const props = defineProps<{ bookName: string }>()
const wb = useWorkbenchStore()
const ui = useUiStore()
const ws = useWorkspaceStore()
const tree = useTreeStore()

const state = ref<BookState | null>(null)
const prompt = ref('')
const err = ref<string | null>(null)

// 态机 action → 可执行操作（每个建议动作都有 UI 按钮）。
// CLI 确定性步骤（hand/rebook/health/review-batch/enter）随 CLI 退场：对应 action 不再有按钮，
// 状态卡只展示 humanMsg；写章统一走「自动写章」或编辑器。
const ACTION_RUNS: Record<string, { label: string; run: () => void | Promise<void> }> = {
  'write-new-chapter':      { label: '开写新章', run: onSpawn },
  'volume-review':          { label: '卷复盘', run: onSpawn },
}
const draftSaved = ref<{ path?: string; words: number } | null>(null)

const chapter = computed(() => state.value?.nextChapter ?? 1)
const draftWords = computed(() => wb.textOut.length)
// 当前建议操作（resume 续写；post-commit-residue 幂等清理无按钮，靠 humanMsg 提示）
const currentAction = computed<{ label: string; run: () => void | Promise<void> } | null>(() => {
  const a = state.value?.action
  if (!a) return null
  if (a === 'resume') {
    return { label: '续写', run: onSpawn }
  }
  // repair 无确定性操作（humanMsg 已含错误列表，作者手修格式）
  if (a === 'repair') return null
  return ACTION_RUNS[a] ?? null
})

async function refreshState(): Promise<void> {
  try {
    state.value = await getState(props.bookName)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}
watch(
  () => props.bookName,
  () => refreshState(),
  { immediate: true },
)
// 生成结束（running false 跳变）刷新状态卡
watch(
  () => wb.running,
  (r, prev) => {
    if (prev && !r) void refreshState()
  },
)
// P1-1：全自动写章收工 → 草稿已由 self-heal 落盘，凭 healResult.docId 自动转编辑器。
// tool_use 模式下无逐字流，正文区恒空白，收工跳转是作者看到成品的唯一通道。
watch(
  () => wb.healResult,
  async (r) => {
    if (!r || (r.outcome !== 'pass' && r.outcome !== 'escalate')) return
    if (!r.docId) return
    try {
      await tree.load(props.bookName)
      ws.openTab(r.docId)
      ui.toast(r.outcome === 'pass' ? '已写完，已转到编辑器' : '已写完（剩红项待你定夺），已转到编辑器', 'success')
    } catch {
      /* 树刷新/打开失败不阻断（草稿已落盘，作者可从文章树手动找） */
    }
  },
)

async function onSpawn(): Promise<void> {
  err.value = null
  try {
    // P0-3：先拉写稿上下文（细纲 + 备料 + 设定注入），再拼输入框内容——
    // 原来仅发输入框文本（常为空串 → 只有 system prompt，产出与本书无关）
    const { prompt: ctx } = await getDraftPrompt(props.bookName, chapter.value)
    const userText = prompt.value.trim()
    const final = userText ? `${ctx}\n\n## 作者补充要求\n${userText}` : ctx
    await spawnRole(props.bookName, { role: 'writer', prompt: final })
    ui.toast('已触发生成', 'info')
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
    ui.toast(err.value, 'error')
  }
}
async function onInterrupt(): Promise<void> {
  try {
    await interrupt(props.bookName)
    ui.toast('已中断', 'info')
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}

// 全自动写章：AI 写稿→机检→红则自动重写→全绿或触顶交作者。进度经 SSE self_heal_* 事件回流。
async function onAutoWrite(): Promise<void> {
  err.value = null
  try {
    await autoWrite(props.bookName, chapter.value)
    ui.toast(`第 ${chapter.value} 章已开始全自动写稿`, 'info')
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
    ui.toast(err.value, 'error')
  }
}

// P1-3：AI 生成本章细纲（工作区/细纲.md）——全自动写章的语境来源，原来端点完整但 UI 不可达
async function onOutline(): Promise<void> {
  err.value = null
  try {
    await generateOutline(props.bookName, chapter.value)
    ui.toast(`第 ${chapter.value} 章细纲已生成`, 'success')
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
    ui.toast(err.value, 'error')
  }
}

// 自愈进度人话（阶段 + 第 N/M 次重写 + 剩余红项数）
const healText = computed(() => {
  const p = wb.healProgress
  if (wb.healPhase === 'rewriting' && p) {
    return `第 ${p.attempt}/${p.maxAttempts} 次重写（剩余红项 ${p.remaining.length} 条）`
  }
  if (wb.healPhase === 'drafting') return '正在写稿…'
  if (wb.healPhase === 'checking') return '机检中…'
  if (wb.healPhase === 'rewriting') return '正在重写…'
  return ''
})
const healDone = computed(() => wb.healResult)

// 存草稿并编辑（M3）：done 后把生成正文 textOut 存为当前章草稿 → 刷树 → 直接落进编辑器
async function onSaveDraft(): Promise<void> {
  if (!wb.textOut.trim()) {
    ui.toast('无正文可存', 'error')
    return
  }
  try {
    const r = await saveDraft(props.bookName, chapter.value, wb.textOut)
    draftSaved.value = { words: wb.textOut.length }
    // 树重拉后新草稿在「写作」组；openTab 切编辑器视图 + 激活文档
    await tree.load(props.bookName)
    ws.openTab(r.docId)
    ui.toast(`第 ${chapter.value} 章草稿已存，转到编辑`, 'success')
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
    ui.toast(err.value, 'error')
  }
}

// 事件流渲染：按 type 归类显示
function evLabel(ev: { type: string; [k: string]: unknown }): string {
  switch (ev.type) {
    case 'text':
      return String(ev.text ?? '')
    case 'tool_use':
      return `[工具] ${ev.tool}${ev.role ? ' (' + ev.role + ')' : ''}`
    case 'tool_result':
      return `[结果] ${ev.role ?? ''}`
    case 'role_spawn':
      return `[子角色] ${ev.role}`
    case 'usage':
      return `[用量] tokens=${ev.tokens} cost=${ev.cost}`
    case 'review-progress':
      return `[审稿] ${ev.lens} · ${ev.label} (${ev.phase})`
    case 'self_heal_phase':
      return `[自愈] 阶段 ${ev.phase}`
    case 'self_heal_reset':
      return '[自愈] 清正文缓冲（新一轮重写）'
    case 'self_heal_progress':
      return `[自愈] 第 ${ev.attempt}/${ev.maxAttempts} 次重写，剩余红项 ${(ev.remaining as string[] | undefined)?.length ?? 0}`
    case 'self_heal_result':
      return `[自愈] 终局 ${ev.outcome}`
    case 'done':
      return `[完成] reason=${ev.reason} usage=${ev.usage}`
    case 'error':
      return `[错误] ${ev.message}`
    case 'interrupted':
      return `[中断] ${ev.reason}`
    case 'init':
      return `[init] agents=${(ev.agents as string[] | undefined)?.join(',')}`
    default:
      return `[${ev.type}]`
  }
}
function evKind(ev: { type: string }): 'text' | 'meta' | 'done' | 'error' {
  if (ev.type === 'text') return 'text'
  if (ev.type === 'error' || ev.type === 'interrupted') return 'error'
  if (ev.type === 'done') return 'done'
  return 'meta'
}
const recent = computed(() => wb.log.slice(-200))
</script>

<template>
  <div class="workbench">
    <!-- G4：AI 不可达置灰提示 -->
    <div v-if="ui.aiAvailable === false" class="ai-warn">
      AI 服务暂不可用（未配置或连接失败），请在设置 → AI 中添加并启用供应商。
    </div>
    <!-- 状态卡（导航灯：当前在哪 + 该做什么 + 一键操作） -->
    <section class="card">
      <div class="card-head">
        <span class="state-tag">{{ state?.stateName ?? '未知' }}</span>
        <span class="conn" :class="{ on: wb.connected }">
          {{ wb.connected ? '已连接' : '连接中' }}
        </span>
      </div>
      <p class="human-msg">{{ state?.humanMsg ?? '读取状态中…' }}</p>
      <div v-if="currentAction" class="action-row">
        <span class="action-hint">建议下一步</span>
        <button
          class="btn mini primary"
          :disabled="wb.running"
          @click="currentAction.run"
        >{{ currentAction.label }}</button>
      </div>
    </section>

    <!-- 高级（流程可见：事件流） -->
    <section class="card">
      <CollapseSection title="高级" :default-open="false">
        <div class="adv-block">
          <div class="adv-head"><span>事件流</span><span class="muted">{{ wb.log.length }} 条</span></div>
          <div class="stream">
            <EmptyState v-if="!recent.length" :icon="Activity" text="无事件，点「生成」触发" size="compact" />
            <div
              v-for="(ev, i) in recent"
              :key="i"
              class="ev"
              :class="evKind(ev)"
            >
              <span class="ev-ts">{{ ev._ts }}</span>
              <span class="ev-text">{{ evLabel(ev) }}</span>
            </div>
          </div>
        </div>
      </CollapseSection>
    </section>

    <!-- 触发生成 -->
    <section class="card">
      <div class="spawn-row">
        <input
          v-model="prompt"
          class="prompt-input"
          placeholder="写作提示（可选，留空用角色默认）"
          :disabled="wb.running"
          @keyup.enter="!wb.running && onSpawn()"
        />
        <button v-if="!wb.running" class="btn primary" :disabled="ui.aiAvailable === false" @click="onSpawn">生成</button>
        <button v-else class="btn danger" @click="onInterrupt">中断</button>
        <button
          class="btn"
          :disabled="wb.running || ui.aiAvailable === false"
          title="AI 生成本章细纲（写稿前的语境准备，全自动写章可读）"
          @click="onOutline"
        >
          生成细纲
        </button>
        <button
          v-if="!wb.running"
          class="btn auto"
          :disabled="ui.aiAvailable === false"
          title="AI 写稿后自动机检，报红自动重写，全绿才交给你确认"
          @click="onAutoWrite"
        >
          <Sparkles :size="14" />
          全自动写章
        </button>
      </div>
    </section>

    <!-- 全自动写章：进度 + 终局（红项只在重试触顶后才流到作者） -->
    <section v-if="healText || healDone" class="card heal-card">
      <div v-if="healText" class="heal-row running">
        <span class="heal-dot" />
        <span>{{ healText }}</span>
      </div>
      <template v-if="healDone">
        <div v-if="healDone.outcome === 'pass'" class="heal-row ok">
          <CircleCheck :size="16" />
          <span>机检全绿，可以定稿了</span>
        </div>
        <div v-else-if="healDone.outcome === 'escalate'" class="heal-row warn">
          <TriangleAlert :size="16" />
          <div class="heal-detail">
            <div>AI 已重试到上限仍有红项，需要你来定夺</div>
            <ul class="heal-reds">
              <li v-for="(r, i) in healDone.reds ?? []" :key="i">{{ r }}</li>
            </ul>
          </div>
        </div>
        <div v-else-if="healDone.outcome === 'aborted'" class="heal-row">
          <span>已中断，草稿保留最后一次产出</span>
        </div>
        <div v-else class="heal-row warn">
          <TriangleAlert :size="16" />
          <span>{{ healDone.error ?? '写稿失败' }}</span>
        </div>
      </template>
    </section>

    <!-- 生成正文（M4 默认主区：作者看到的是文章，不是事件日志） -->
    <section class="card draft-card">
      <div class="card-head">
        <span>生成正文</span>
        <span class="muted">{{ draftWords }} 字</span>
      </div>
      <pre class="draft-preview">{{ wb.textOut || '（无正文，点「生成」开始）' }}</pre>
      <div class="draft-actions">
        <button class="btn primary" :disabled="!wb.textOut.trim()" @click="onSaveDraft">
          存草稿并编辑
        </button>
        <span v-if="draftSaved" class="muted">✓ {{ draftSaved.words }} 字已存</span>
      </div>
    </section>

    <div v-if="err" class="err-msg">{{ err }}</div>
  </div>
</template>

<style scoped>
.workbench {
  height: 100%;
  overflow: auto;
  padding: var(--size-4-4) var(--size-4-6);
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
  max-width: 820px;
  margin: 0 auto;
}
.card {
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  padding: var(--size-4-3);
  box-shadow: var(--shadow-s);
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: var(--font-size-m);
  font-weight: 600;
  color: var(--text-normal);
  margin-bottom: var(--size-4-2);
}
.state-tag {
  color: var(--text-accent);
}
.conn {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.conn.on {
  color: var(--dv-good);
}
.human-msg {
  font-size: var(--font-size-m);
  color: var(--text-normal);
  line-height: 1.7;
  white-space: pre-wrap;
}
.action-row {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  margin-top: var(--size-4-2);
}
.action-hint {
  font-size: var(--font-size-s);
  color: var(--text-faint);
}
.btn.mini {
  height: 28px;
  padding: 0 12px;
  font-size: var(--font-size-s);
}
.spawn-row {
  display: flex;
  gap: var(--size-4-2);
}
.prompt-input {
  flex: 1;
  height: 32px;
  font-size: var(--font-size-m);
  padding: 0 var(--size-4-2);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  outline: none;
}
.prompt-input:focus {
  border-color: var(--interactive-accent);
}
.btn {
  padding: 0 16px;
  height: 32px;
  font-size: var(--font-size-m);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  cursor: pointer;
}
.btn.primary {
  background: var(--interactive-accent);
  border-color: var(--interactive-accent);
  color: var(--text-on-accent);
}
.btn.primary:hover {
  background: var(--interactive-accent-hover);
}
.btn.danger {
  color: var(--text-error);
  border-color: var(--text-error);
}
/* 全自动写章：与「生成」同排的次级强调（accent 描边不抢主按钮） */
.btn.auto {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--interactive-accent);
  border-color: var(--interactive-accent);
}
.btn.auto:hover:not(:disabled) {
  background: var(--background-modifier-hover);
}
.btn.auto:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.heal-card {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
}
.heal-row {
  display: flex;
  align-items: flex-start;
  gap: var(--size-4-2);
  font-size: var(--font-size-s);
  color: var(--text-normal);
}
.heal-row.ok {
  color: var(--text-accent);
}
.heal-row.warn {
  color: var(--text-error);
}
.heal-row.running {
  color: var(--text-muted);
}
.heal-dot {
  width: 8px;
  height: 8px;
  margin-top: 4px;
  border-radius: 50%;
  background: var(--interactive-accent);
  animation: heal-pulse 1.4s ease-in-out infinite;
  flex-shrink: 0;
}
@keyframes heal-pulse {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}
.heal-detail {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.heal-reds {
  margin: 0;
  padding-left: 18px;
  color: var(--text-muted);
}
.heal-reds li {
  margin: 2px 0;
}
.muted {
  font-size: var(--font-size-xs);
  font-weight: 400;
  color: var(--text-faint);
}
.adv-block {
  margin-bottom: var(--size-4-3);
}
.adv-block:last-child {
  margin-bottom: 0;
}
.adv-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: var(--size-4-2);
}
.stream {
  max-height: 240px;
  overflow: auto;
  font-family: var(--font-monospace);
  font-size: var(--font-size-s);
}
.ev {
  padding: 2px 0;
  color: var(--text-muted);
  line-height: 1.6;
}
.ev.text {
  color: var(--text-normal);
  white-space: pre-wrap;
}
.ev.done {
  color: var(--dv-good);
}
.ev.error {
  color: var(--text-error);
}
.ev-ts {
  color: var(--text-faint);
  margin-right: var(--size-4-2);
}
.ev-text {
  word-break: break-all;
}
.err-msg {
  font-size: var(--font-size-s);
  color: var(--text-error);
}
.draft-card {
  flex: 1;
  min-height: 240px;
  display: flex;
  flex-direction: column;
}
.draft-preview {
  flex: 1;
  min-height: 120px;
  margin: var(--size-4-2) 0;
  padding: var(--size-4-3);
  font-family: var(--prose-font);
  font-size: var(--prose-size);
  line-height: var(--prose-lh);
  color: var(--text-normal);
  background: var(--background-primary);
  border-radius: var(--radius-s);
  white-space: pre-wrap;
  overflow: auto;
}
.draft-actions {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
}
.ai-warn {
  padding: 8px 12px;
  margin-bottom: var(--size-4-3);
  font-size: var(--font-size-s);
  color: var(--text-warning);
  background: var(--background-modifier-border);
  border-radius: var(--radius-s);
}
</style>
