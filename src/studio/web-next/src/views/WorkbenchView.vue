<script setup lang="ts">
// 工作台写作模式（细案 T3.2）：状态卡（/state）+ spawn/interrupt + 事件流（workbench.log）。
// rebook/hand/cli 任务列表/草稿保存留后续（T3.2 扩展 / T3.3）。
import { ref, watch, computed } from 'vue'
import { useWorkbenchStore } from '../stores/workbench'
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

const props = defineProps<{ bookName: string }>()
const wb = useWorkbenchStore()
const ui = useUiStore()

const state = ref<BookState | null>(null)
const prompt = ref('')
const err = ref<string | null>(null)

// cli 八阶段（细案 §2.1 step 枚举）：确定性 CLI 步骤，POST /cli {step}
const CLI_STEPS = ['prepare', 'confirm', 'check', 'finalize', 'enter', 'hand', 'rebook'] as const
const cliRunning = ref<string | null>(null)
const cliReport = ref('')
const draftSaved = ref<{ path?: string; words: number } | null>(null)

const chapter = computed(() => state.value?.nextChapter ?? 1)
const draftWords = computed(() => wb.textOut.length)

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
    ui.toast(`${step} 完成`, r.ok ? 'success' : 'error')
    void refreshState()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
    ui.toast(err.value, 'error')
  } finally {
    cliRunning.value = null
  }
}

// 草稿保存：done 后把生成正文 textOut 存为当前章草稿
async function onSaveDraft(): Promise<void> {
  if (!wb.textOut.trim()) {
    ui.toast('无正文可存', 'error')
    return
  }
  try {
    await saveDraft(props.bookName, chapter.value, wb.textOut)
    draftSaved.value = { words: wb.textOut.length }
    ui.toast(`第 ${chapter.value} 章草稿已存`, 'success')
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
    <!-- 状态卡 -->
    <section class="card">
      <div class="card-head">
        <span class="state-tag">态 {{ state?.state ?? '—' }} · {{ state?.stateName ?? '未知' }}</span>
        <span class="conn" :class="{ on: wb.connected }">
          {{ wb.connected ? 'SSE 已连' : 'SSE 连接中' }}
        </span>
      </div>
      <p class="human-msg">{{ state?.humanMsg ?? '读取状态中…' }}</p>
      <p v-if="state?.action" class="action">建议：{{ state.action }}</p>
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
        <button v-if="!wb.running" class="btn primary" @click="onSpawn">生成</button>
        <button v-else class="btn danger" @click="onInterrupt">中断</button>
      </div>
    </section>

    <!-- 事件流 -->
    <section class="card stream-card">
      <div class="card-head"><span>事件流</span><span class="muted">{{ wb.log.length }} 条</span></div>
      <div class="stream">
        <div v-if="!recent.length" class="empty">（无事件，点「生成」触发）</div>
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
    </section>

    <!-- CLI 八阶段任务 -->
    <section class="card">
      <div class="card-head"><span>八阶段任务（第 {{ chapter }} 章）</span></div>
      <div class="cli-grid">
        <button
          v-for="step in CLI_STEPS"
          :key="step"
          class="cli-btn"
          :disabled="!!cliRunning"
          @click="onCli(step)"
        >
          {{ cliRunning === step ? `${step}…` : step }}
        </button>
      </div>
      <pre v-if="cliReport" class="cli-report">{{ cliReport }}</pre>
    </section>

    <!-- 草稿保存 -->
    <section class="card">
      <div class="card-head">
        <span>生成正文</span>
        <span class="muted">{{ draftWords }} 字</span>
      </div>
      <pre class="draft-preview">{{ wb.textOut || '（无正文）' }}</pre>
      <button class="btn primary" :disabled="!wb.textOut.trim()" @click="onSaveDraft">
        存为第 {{ chapter }} 章草稿
      </button>
      <span v-if="draftSaved" class="muted">✓ {{ draftSaved.words }} 字已存</span>
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
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-normal);
  margin-bottom: var(--size-4-2);
}
.state-tag {
  color: var(--text-accent);
}
.conn {
  font-size: 11px;
  color: var(--text-faint);
}
.conn.on {
  color: var(--text-success);
}
.human-msg {
  font-size: 13px;
  color: var(--text-normal);
  line-height: 1.7;
  white-space: pre-wrap;
}
.action {
  font-size: 12px;
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
  font-size: 13px;
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
  font-size: 13px;
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
  font-size: 11px;
  font-weight: 400;
  color: var(--text-faint);
}
.stream-card {
  flex: 1;
  min-height: 200px;
  display: flex;
  flex-direction: column;
}
.stream {
  flex: 1;
  overflow: auto;
  font-family: var(--font-monospace);
  font-size: 12px;
}
.empty {
  color: var(--text-faint);
  padding: var(--size-4-3);
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
  font-size: 12px;
  color: var(--text-error);
}
.cli-grid {
  display: flex;
  flex-wrap: wrap;
  gap: var(--size-4-2);
}
.cli-btn {
  padding: 5px 12px;
  font-size: 12px;
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
  font-size: 11px;
  color: var(--text-muted);
  background: var(--background-primary);
  border-radius: var(--radius-s);
  white-space: pre-wrap;
  max-height: 200px;
  overflow: auto;
}
.draft-preview {
  margin: var(--size-4-2) 0;
  padding: var(--size-4-3);
  font-family: var(--prose-font);
  font-size: var(--prose-size);
  line-height: var(--prose-lh);
  color: var(--text-normal);
  background: var(--background-primary);
  border-radius: var(--radius-s);
  white-space: pre-wrap;
  max-height: 300px;
  overflow: auto;
}
</style>
