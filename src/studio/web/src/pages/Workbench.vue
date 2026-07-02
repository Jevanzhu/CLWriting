<script setup lang="ts">
import { watch, computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useWorkbenchStore } from '../stores/workbench'
import { useWorkbenchLog } from '../composables/useWorkbenchLog'

/** driver 事件（松类型，按 type 分支取字段） */
interface DriverEvent {
  type: string
  [k: string]: unknown
}

const route = useRoute()
const name = computed(() => (typeof route.params.name === 'string' ? route.params.name : ''))
const wb = useWorkbenchStore()
// 八阶段态走 store（storeToRefs 双向绑，chapter/autoAdvance 可 v-model）
const {
  activeStage,
  chapter,
  running,
  outlineRunning,
  cliRunning,
  reviewRunning,
  textOut,
  saved,
  outlineSaved,
  checkReport,
  reviewReport,
  verdictApproved,
  stateInfo,
  autoAdvance,
  interrupted,
  kind,
} = storeToRefs(wb)

// 事件流走共享状态（useWorkbenchLog），右栏 EventStream 实时联动
const { log } = useWorkbenchLog()

// 八阶段骨架（C.3 全接：细纲/确认/备料/写稿/机检/三审/定稿）
const stages = [
  { id: 'enter', label: '进入' },
  { id: 'outline', label: '细纲' },
  { id: 'confirm', label: '确认' },
  { id: 'prepare', label: '备料' },
  { id: 'draft', label: '写稿' },
  { id: 'check', label: '机检' },
  { id: 'review', label: '审稿' },
  { id: 'finalize', label: '定稿' },
]

// SSE EventSource（运行态通道，page 持有生命周期；onmessage 推 store.handleEvent）
let es: EventSource | null = null
function connect(n: string): void {
  es?.close()
  es = new EventSource(`/api/books/${encodeURIComponent(n)}/stream`)
  es.onmessage = (e) => {
    let ev: DriverEvent
    try {
      ev = JSON.parse(e.data)
    } catch {
      return
    }
    wb.handleEvent(ev)
  }
}

// 流程 actions（Pinia 已绑 this）
const { runCliStep, outlineGen, draftWrite, interruptWrite, discardDraft, reviewRun, verdictApprove } = wb

onMounted(() => {
  if (name.value) {
    void wb.enter(name.value) // 设 name + loadState
    void wb.loadKind()
    connect(name.value)
  }
})
watch(name, (n) => {
  if (n) {
    void wb.enter(n)
    connect(n)
  }
})
onUnmounted(() => es?.close())
</script>

<template>
  <section class="wb-page">
    <div class="panel-pad">
      <div class="panel-title">工作台</div>
      <div class="panel-sub">八阶段 · 细纲 → 确认 → 备料 → 写稿 → 机检 → 三审 → 定稿</div>

      <!-- 当前状态卡（enter 自动定位） -->
      <div v-if="stateInfo" class="state-card">
        <span class="state-tag">【{{ stateInfo.stateName }}】</span>
        <span class="state-msg">{{ stateInfo.humanMsg }}</span>
      </div>

      <div class="cc-banner">
        ⚡ AI 步（细纲 / 写稿 / 三审）经 claude CLI，确定性步（确认 / 备料 / 机检 / 定稿）经 clwriting CLI
      </div>

      <!-- 八阶段骨架 -->
      <nav class="stages">
        <span
          v-for="s in stages"
          :key="s.id"
          class="stage"
          :class="{ active: s.id === activeStage }"
        >{{ s.label }}</span>
      </nav>

      <!-- 控制区 -->
      <article class="card ctrl">
        <div class="ctrl-row">
          <label>{{ kind === 'short' ? '篇号' : '章号' }}
            <input v-model.number="chapter" type="number" min="1" :disabled="running || outlineRunning || reviewRunning" />
          </label>
          <button class="btn primary" :disabled="outlineRunning || running || cliRunning || reviewRunning" @click="outlineGen">
            {{ outlineRunning ? (kind === 'short' ? '篇纲中…' : '细纲中…') : (kind === 'short' ? '📋 篇纲' : '📋 细纲') }}
          </button>
          <button class="btn" :disabled="cliRunning || running || outlineRunning || reviewRunning" @click="runCliStep('confirm')">✓ 确认</button>
          <button class="btn" :disabled="cliRunning || running || outlineRunning || reviewRunning" @click="runCliStep('prepare')">📦 备料</button>
          <button class="btn primary" :disabled="running || outlineRunning || cliRunning || reviewRunning" @click="draftWrite">
            {{ running ? '写稿中…' : `✍ 写第 ${chapter} ${kind === 'short' ? '篇' : '章'}` }}
          </button>
          <button v-if="running" class="btn danger" @click="interruptWrite">⏹ 中断</button>
          <button class="btn" :disabled="cliRunning || running || outlineRunning || reviewRunning" @click="runCliStep('check')">🔍 机检</button>
          <button class="btn primary" :disabled="reviewRunning || running || cliRunning || outlineRunning" @click="reviewRun">
            {{ reviewRunning ? '三审中…' : '📝 三审' }}
          </button>
          <button class="btn" :disabled="cliRunning || running || outlineRunning || reviewRunning || !verdictApproved" @click="runCliStep('finalize')">✅ 定稿</button>
          <label class="auto-toggle" title="确定性步 done 后自动推进下一步（AI / 人工步前停）">
            <input type="checkbox" v-model="autoAdvance" /> 自动推进
          </label>
        </div>
        <!-- 中断后：弃稿 / 改指令重写 -->
        <div v-if="interrupted" class="interrupt-bar">
          <span class="interrupt-tip">写稿已中断，正文已保留（{{ textOut.length }} 字）。</span>
          <button class="btn" @click="discardDraft">🗑 弃稿</button>
          <button class="btn primary" @click="draftWrite">🔄 改指令重写</button>
        </div>
        <p v-if="outlineSaved" class="saved-tip">📋 细纲已生成：<span class="mono">{{ outlineSaved.path }}</span>（{{ outlineSaved.words }} 字）</p>
        <p v-if="saved" class="saved-tip">✅ 草稿已保存：<span class="mono">{{ saved.path }}</span>（{{ saved.words }} 字）</p>
        <p v-if="verdictApproved" class="saved-tip">✓ 裁决通过，可定稿</p>
      </article>

      <!-- 正文输出 -->
      <article class="card">
        <div class="card-title">正文输出</div>
        <pre class="text-out">{{ textOut || '（尚未生成）' }}</pre>
      </article>

      <!-- 机检报告 -->
      <article v-if="checkReport" class="card">
        <div class="card-title">机检报告</div>
        <pre class="report-out">{{ checkReport }}</pre>
      </article>

      <!-- 审稿单 -->
      <article v-if="reviewReport" class="card">
        <div class="card-title">
          <span>审稿单</span>
          <button v-if="!verdictApproved" class="btn primary" style="font-size:11px;padding:3px 10px" @click="verdictApprove">裁决通过 →</button>
        </div>
        <pre class="report-out">{{ reviewReport }}</pre>
      </article>

      <!-- 事件流 -->
      <article class="card">
        <div class="card-title">事件流</div>
        <ul class="log">
          <li v-for="(l, i) in log" :key="i" :class="`ev-${l.type}`">
            <span class="ev-time">{{ l.t }}</span>
            <span class="ev-type">{{ l.type }}</span>
            <span class="ev-text">{{ l.text }}</span>
          </li>
          <li v-if="!log.length" class="empty">等待事件…</li>
        </ul>
      </article>
    </div>
  </section>
</template>

<style scoped>
.wb-page {
  margin: 0 auto;
}
.state-card {
  padding: 10px 14px;
  background: var(--ok-bg);
  border: 1px solid var(--ok-bg);
  border-radius: 7px;
  font-size: 13px;
  color: var(--ink-cyan);
  line-height: 1.6;
  margin-bottom: 12px;
}
.state-tag {
  font-weight: 700;
  margin-right: 6px;
}
.cc-banner {
  padding: 8px 12px;
  background: var(--active-bg);
  color: var(--ink-cyan);
  border-radius: 7px;
  font-size: 12px;
  line-height: 1.6;
  margin-bottom: 14px;
}
.stages {
  display: flex;
  gap: 6px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.stage {
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 14px;
  font-size: 12px;
  color: var(--text-3);
  background: var(--panel);
}
.stage.active {
  background: var(--ink-cyan);
  color: var(--panel);
  border-color: var(--ink-cyan);
  font-weight: 600;
}
.ctrl-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  flex-wrap: wrap;
}
.ctrl-row label {
  display: grid;
  gap: 4px;
  font-size: 12px;
  color: var(--text-2);
}
.ctrl-row input[type='number'] {
  width: 72px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  background: var(--paper);
  color: var(--ink);
  outline: none;
}
.auto-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
  white-space: nowrap;
}
.auto-toggle input {
  cursor: pointer;
  accent-color: var(--ink-cyan);
}
.saved-tip {
  margin: 12px 0 0;
  padding: 8px 12px;
  background: var(--ok-bg);
  color: var(--ink-cyan);
  border-radius: 6px;
  font-size: 12px;
}
.interrupt-bar {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-top: 12px;
  padding: 8px 12px;
  background: var(--danger-bg);
  border: 1px solid var(--cinnabar);
  border-radius: 6px;
  flex-wrap: wrap;
}
.interrupt-tip {
  font-size: 13px;
  color: var(--cinnabar);
}
.mono {
  font-family: ui-monospace, monospace;
}
.text-out,
.report-out {
  margin: 0;
  padding: 12px;
  background: var(--paper);
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--ink);
  white-space: pre-wrap;
  max-height: 360px;
  overflow-y: auto;
}
.text-out {
  min-height: 48px;
  font-family: 'STKaiti', 'KaiTi', '楷体', serif;
}
.log {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 4px;
  max-height: 220px;
  overflow-y: auto;
}
.log li {
  display: grid;
  grid-template-columns: 64px 56px 1fr;
  gap: 8px;
  align-items: baseline;
  font-size: 12px;
  padding: 3px 0;
}
.log li.empty {
  color: var(--text-3);
  display: block;
}
.ev-time {
  color: var(--text-3);
  font-family: ui-monospace, monospace;
}
.ev-type {
  color: var(--text-2);
}
.ev-init .ev-type,
.ev-done .ev-type {
  color: var(--ink-cyan);
}
.ev-saved .ev-type,
.ev-saved .ev-text {
  color: var(--ink-cyan);
}
.ev-spawn .ev-type {
  color: var(--ochre);
}
.ev-error .ev-type,
.ev-error .ev-text {
  color: var(--cinnabar);
}
.ev-text {
  color: var(--text-2);
}
</style>
