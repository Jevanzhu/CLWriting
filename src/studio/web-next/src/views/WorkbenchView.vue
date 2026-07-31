<script setup lang="ts">
// 工作台写作模式：状态卡（人话）+ 生成/中断 + 正文预览（默认主区）+ 存草稿并编辑。
// 事件流 / 阶段任务 / CLI 报告收「高级」折叠区（M4 去机器味：作者看文章，调试功能全保留）。
import { ref, watch, computed } from 'vue'
import { Activity } from 'lucide-vue-next'
import { useWorkbenchStore } from '../stores/workbench'
import { useWorkspaceStore } from '../stores/workspace'
import { useTreeStore } from '../stores/tree'
import {
  getState,
  spawnRole,
  interrupt,
  runCli,
  saveDraft,
  type BookState,
  type CliResult,
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

// cli 八阶段（细案 §2.1 step 枚举）：确定性 CLI 步骤，POST /cli {step}
const CLI_STEPS = ['prepare', 'confirm', 'check', 'finalize', 'enter', 'hand', 'rebook'] as const
// 八阶段英文值 → 中文标签（值传 API 不变；英文值作 title 保留可调试性）
const STEP_LABELS: Record<string, string> = {
  prepare: '备料',
  confirm: '确认',
  check: '校对',
  finalize: '定稿',
  enter: '入书',
  hand: '手写',
  rebook: '重开',
}
// 态机 action（机器侧命令标识）→ 中文动作标签，避免对作者暴露 write-new-chapter 等英文。
// 新增 action 需同步补映射；未命中 fallback 原值兜底。
const ACTION_LABELS: Record<string, string> = {
  'git-health': '修复 git 问题',
  repair: '修复源文件',
  rebook: '补登手改',
  resume: '续写断点',
  'volume-review': '卷复盘',
  'health-check-periodic': '定期体检',
  'write-new-chapter': '开写新章',
  'write-new-chapter-hand': '手写起草',
  'pending-batch-review': '批量审稿',
  'pending-ai': 'AI 介入',
}
const cliRunning = ref<string | null>(null)
const cliReport = ref('')
const draftSaved = ref<{ path?: string; words: number } | null>(null)

const chapter = computed(() => state.value?.nextChapter ?? 1)
const draftWords = computed(() => wb.textOut.length)
// 建议动作中文标签（映射 action 枚举；未命中兜底原值）
const actionLabel = computed(() => {
  const a = state.value?.action
  return a ? (ACTION_LABELS[a] ?? a) : ''
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

async function onSpawn(): Promise<void> {
  err.value = null
  try {
    await spawnRole(props.bookName, { role: 'writer', prompt: prompt.value || undefined })
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

// CLI 八阶段步骤：prepare/confirm/check/finalize/enter/hand/rebook
async function onCli(step: string): Promise<void> {
  cliRunning.value = step
  cliReport.value = ''
  err.value = null
  try {
    const r: CliResult = await runCli(props.bookName, { step, chapter: chapter.value, yes: true })
    cliReport.value = r.stdout || r.stderr || `(exit ${r.code})`
    ui.toast(`${STEP_LABELS[step] ?? step} 完成`, r.ok ? 'success' : 'error')
    void refreshState()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
    ui.toast(err.value, 'error')
  } finally {
    cliRunning.value = null
  }
}

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
      AI 驱动不可用（claude CLI 未就绪），写作功能暂不可用。请确认 claude CLI 已安装并在 PATH。
    </div>
    <!-- 状态卡（M4：删态N编号，只留人话） -->
    <section class="card">
      <div class="card-head">
        <span class="state-tag">{{ state?.stateName ?? '未知' }}</span>
        <span class="conn" :class="{ on: wb.connected }">
          {{ wb.connected ? '已连接' : '连接中' }}
        </span>
      </div>
      <p class="human-msg">{{ state?.humanMsg ?? '读取状态中…' }}</p>
      <p v-if="actionLabel" class="action">建议：{{ actionLabel }}</p>
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
      </div>
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

    <!-- 高级（M4 默认收起）：事件流 + 阶段任务 + CLI 报告，调试功能一个不删 -->
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
        <div class="adv-block">
          <div class="adv-head"><span>阶段任务（第 {{ chapter }} 章）</span></div>
          <div class="cli-grid">
            <button
              v-for="step in CLI_STEPS"
              :key="step"
              class="cli-btn"
              :title="step"
              :disabled="!!cliRunning"
              @click="onCli(step)"
            >
              {{ cliRunning === step ? `${STEP_LABELS[step] ?? step}…` : STEP_LABELS[step] ?? step }}
            </button>
          </div>
          <pre v-if="cliReport" class="cli-report">{{ cliReport }}</pre>
        </div>
      </CollapseSection>
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
  color: var(--text-success);
}
.human-msg {
  font-size: var(--font-size-m);
  color: var(--text-normal);
  line-height: 1.7;
  white-space: pre-wrap;
}
.action {
  font-size: var(--font-size-s);
  color: var(--text-muted);
  margin-top: var(--size-4-2);
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
  color: var(--text-success);
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
.cli-grid {
  display: flex;
  flex-wrap: wrap;
  gap: var(--size-4-2);
}
.cli-btn {
  padding: 5px 12px;
  font-size: var(--font-size-s);
  font-family: var(--font-monospace);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-muted);
  cursor: pointer;
}
.cli-btn:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
  border-color: var(--interactive-accent);
}
.cli-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.cli-report {
  margin-top: var(--size-4-2);
  padding: var(--size-4-2);
  font-family: var(--font-monospace);
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  background: var(--background-primary);
  border-radius: var(--radius-s);
  white-space: pre-wrap;
  max-height: 200px;
  overflow: auto;
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
