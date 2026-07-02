<script setup lang="ts">
import { watch, computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useWorkbenchStore } from '../stores/workbench'
import { useWorkbenchLog } from '../composables/useWorkbenchLog'
import { useHint } from '../composables/useHint'
import { serverOnline } from '../composables/useHeartbeat'

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
const stageIndex = computed(() => stages.findIndex((s) => s.id === activeStage.value))
const { hint } = useHint()

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

// 流程 actions（Pinia 已绑 this）；handleEvent/runCliStep/outlineGen/draftWrite/interruptWrite/discardDraft/reviewRun/saveDraft/loadKind/loadState 已内聚进 store
const { runCliStep, outlineGen, draftWrite, interruptWrite, discardDraft, reviewRun } = wb

/** 裁决通过 → 定稿（store action + hint 反馈） */
async function verdictApprove(): Promise<void> {
  await wb.verdictApprove()
  if (verdictApproved.value) hint('裁决通过 · 可定稿')
}

/** 自动推进开关切换：即时反馈（对齐 mockup showHint） */
function onAutoToggle(): void {
  hint('自动推进 ' + (autoAdvance.value ? '已开' : '已关'))
}

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
// 左栏 TaskList 点章 → route.query.chapter 同步中栏章号
watch(
  () => route.query.chapter,
  (c) => {
    if (typeof c === 'string') {
      const n = Number(c)
      if (Number.isFinite(n) && n > 0 && n !== chapter.value) chapter.value = n
    }
  },
)
onUnmounted(() => es?.close())
</script>

<template>
  <section class="wb-page">
    <div class="bento-wrap">
      <div class="bento-head">
        <h1 class="bento-title">工作台 · 第 {{ chapter }} {{ kind === 'short' ? '篇' : '章' }}</h1>
        <div class="bento-sub">
          <span class="meta-chip">{{ name || '（未选书）' }}</span>
          <span class="meta-chip">八阶段全接</span>
          <span class="meta-chip">AI 步经 Claude CLI</span>
          <span class="meta-chip">确定性步经 clwriting CLI</span>
        </div>
      </div>

      <!-- 当前状态卡（enter 自动定位） -->
      <div v-if="stateInfo" class="state-card">
        <span class="state-tag">【{{ stateInfo.stateName }}】</span>
        <span class="state-msg">{{ stateInfo.humanMsg }}</span>
      </div>
      <!-- CLI 断连错误卡（对齐 mockup state-error：🔌 + 重试提示） -->
      <div v-if="!serverOnline" class="state-card" style="border-color:var(--cinnabar);background:var(--cinnabar-7)">
        <span class="state-tag" style="color:var(--cinnabar)">🔌【CLI 断连】</span>
        <span class="state-msg">Claude CLI 连接中断，工作台流程暂停</span>
      </div>

      <!-- 八阶段骨架 -->
      <nav class="stages">
        <div
          v-for="(s, i) in stages"
          :key="s.id"
          class="stage"
          :class="{ done: stageIndex > i, active: s.id === activeStage }"
          @click="activeStage = s.id"
        >
          <div class="s-node">{{ stageIndex > i ? '✓' : s.label.charAt(0) }}</div>
          <div class="s-line"></div>
          <div class="s-label">{{ s.label }}</div>
        </div>
      </nav>

      <!-- 控制区 -->
      <article class="card ctrl">
        <div class="ctrl-row">
          <label>{{ kind === 'short' ? '篇号' : '章号' }}
            <input v-model.number="chapter" type="number" min="1" :disabled="running || outlineRunning || reviewRunning" />
          </label>
          <button class="btn-cli" :disabled="outlineRunning || running || cliRunning || reviewRunning" @click="outlineGen">
            {{ outlineRunning ? (kind === 'short' ? '篇纲中…' : '细纲中…') : (kind === 'short' ? '📋 篇纲' : '📋 细纲') }}
          </button>
          <button class="btn-cli" :disabled="cliRunning || running || outlineRunning || reviewRunning" @click="runCliStep('confirm')">✓ 确认</button>
          <button class="btn-cli" :disabled="cliRunning || running || outlineRunning || reviewRunning" @click="runCliStep('prepare')">📦 备料</button>
          <button class="btn-fire" :disabled="running || outlineRunning || cliRunning || reviewRunning" @click="draftWrite">
            {{ running ? '写稿中…' : `✍ 写第 ${chapter} ${kind === 'short' ? '篇' : '章'}` }}
          </button>
          <button v-if="running" class="btn-stop" @click="interruptWrite">⏹ 中断</button>
          <button class="btn-cli" :disabled="cliRunning || running || outlineRunning || reviewRunning" @click="runCliStep('check')">🔍 机检</button>
          <button class="btn-review" :disabled="reviewRunning || running || cliRunning || outlineRunning" @click="reviewRun">
            {{ reviewRunning ? '三审中…' : '📝 三审' }}
          </button>
          <button
            class="btn-cli"
            :class="{ disabled: !verdictApproved }"
            :disabled="cliRunning || running || outlineRunning || reviewRunning || !verdictApproved"
            @click="runCliStep('finalize')"
          >✅ 定稿</button>
          <label class="auto-toggle" title="确定性步 done 后自动推进下一步（AI / 人工步前停）">
            <input type="checkbox" v-model="autoAdvance" @change="onAutoToggle" /> 自动推进
          </label>
        </div>
        <!-- 中断后：弃稿 / 改指令重写 -->
        <div v-if="interrupted" class="interrupt-bar">
          <span class="interrupt-tip">写稿已中断，正文已保留（{{ textOut.length }} 字）</span>
          <button class="btn" @click="discardDraft">🗑 弃稿</button>
          <button class="btn primary" @click="draftWrite">🔄 改指令重写</button>
        </div>
      </article>

      <!-- 正文输出 -->
      <article class="card">
        <div class="card-title">正文输出 <span v-if="running" class="wb-live">● 流式</span></div>
        <pre class="wb-out" :class="{ empty: !textOut }">{{ textOut || '（尚未生成 · 点「写稿」流式生成正文）' }}</pre>
      </article>

      <!-- 机检报告 -->
      <article v-if="checkReport" class="card">
        <div class="card-title">🔍 机检报告</div>
        <pre class="report">{{ checkReport }}</pre>
      </article>

      <!-- 审稿单 -->
      <article v-if="reviewReport" class="card">
        <div class="card-title">
          📝 审稿单
          <span v-if="verdictApproved" class="tag green">已裁决通过</span>
          <button v-else class="btn primary" style="font-size: 11px; padding: 3px 10px" @click="verdictApprove">裁决通过 →</button>
        </div>
        <pre class="report">{{ reviewReport }}</pre>
      </article>
    </div>
  </section>
</template>

<style scoped>
/* 对齐 mockup：mockup 的 .wb-out 是 <div>（无默认 margin），
   Vue 用 <pre> 承载正文，UA 默认 margin-block:1em 会多出上下间距，这里归零。 */
.wb-out {
  margin: 0;
}
</style>
