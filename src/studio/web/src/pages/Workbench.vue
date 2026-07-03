<script setup lang="ts">
// 工作台：两模式 tab ——「开书设定」（分步 + 对话 + 整理到步）/「写章」（八阶段）。
// SSE EventSource 由 page 持有；onmessage 按 mode 分发：setup→onboard, write→workbench。
// 新书从 BookNew 跳来带 ?setup=1，默认进设定模式。
import { watch, computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useWorkbenchStore } from '../stores/workbench'
import { useOnboardStore } from '../stores/onboard'
import { useHint } from '../composables/useHint'
import { serverOnline } from '../composables/useHeartbeat'
import OnboardChat from '../components/OnboardChat.vue'

/** driver 事件（松类型，按 type 分支取字段） */
interface DriverEvent {
  type: string
  [k: string]: unknown
}

const route = useRoute()
const name = computed(() => (typeof route.params.name === 'string' ? route.params.name : ''))
const wb = useWorkbenchStore()
const ob = useOnboardStore()

/** 工作区模式：setup（开书设定）/ write（写章八阶段）。?setup=1 初始 setup */
const mode = ref<'setup' | 'write'>(route.query.setup === '1' ? 'setup' : 'write')

// 写章态（八阶段）
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
// 设定态（分步 + 对话）
const {
  steps: onboardSteps,
  messages,
  chatRunning,
  converging: onboardConverging,
  error: onboardError,
  savedMsg: onboardSaved,
} = storeToRefs(ob)

const { hint } = useHint()

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

// 写章 actions
const { runCliStep, outlineGen, draftWrite, interruptWrite, discardDraft, reviewRun } = wb
// 设定 actions
const { onboardRun, onboardSave, sendChat, interruptChat, convergeToStep } = ob

/** 裁决通过 → 定稿 */
async function verdictApprove(): Promise<void> {
  await wb.verdictApprove()
  if (verdictApproved.value) hint('裁决通过 · 可定稿')
}

/** 自动推进开关切换 */
function onAutoToggle(): void {
  hint('自动推进 ' + (autoAdvance.value ? '已开' : '已关'))
}

function switchMode(m: 'setup' | 'write'): void {
  mode.value = m
}

// SSE EventSource（page 持有生命周期；onmessage 按 mode 分发）
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
    // setup 模式事件→设定对话；write 模式→写章流式
    if (mode.value === 'setup') ob.handleChatEvent(ev)
    else wb.handleEvent(ev)
  }
}

onMounted(() => {
  if (name.value) {
    void wb.enter(name.value) // 设 name + loadState
    void wb.loadKind() // 加载 kind（触发下方 watch → ob.enter）
    connect(name.value)
  }
})
watch(name, (n) => {
  if (n) {
    void wb.enter(n)
    connect(n)
  }
})
// kind 加载后初始化设定 steps（长篇 9 / 短篇 5）
watch(kind, (k) => {
  if (name.value) ob.enter(name.value, k)
})
// ?setup=1 变化时同步 mode
watch(
  () => route.query.setup,
  (s) => {
    if (s === '1') mode.value = 'setup'
  },
)
// 左栏 TaskList 点章 → route.query.chapter 同步中栏章号（仅 write 模式）
watch(
  () => route.query.chapter,
  (c) => {
    if (mode.value !== 'write') return
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
        <h1 class="bento-title">
          工作台
          <span v-if="mode === 'write'">· 第 {{ chapter }} {{ kind === 'short' ? '篇' : '章' }}</span>
        </h1>
        <div class="bento-sub">
          <span class="meta-chip">{{ name || '（未选书）' }}</span>
          <!-- 模式 tab -->
          <div class="wb-mode-tabs">
            <button :class="{ active: mode === 'setup' }" @click="switchMode('setup')">📝 开书设定</button>
            <button :class="{ active: mode === 'write' }" @click="switchMode('write')">✍ 写章</button>
          </div>
        </div>
      </div>

      <!-- CLI 断连错误卡（两模式共用） -->
      <div v-if="!serverOnline" class="state-card" style="border-color: var(--cinnabar); background: var(--cinnabar-7)">
        <span class="state-tag" style="color: var(--cinnabar)">🔌【CLI 断连】</span>
        <span class="state-msg">Claude CLI 连接中断，工作台流程暂停</span>
      </div>

      <!-- ============ setup 模式：开书设定 ============ -->
      <template v-if="mode === 'setup'">
        <div class="setup-hint panel-sub">
          💡 每步可「⚡生成」（AI 据题材产）或先在下方对话讨论再「📐据讨论整理」；产出可编辑后「💾保存」落盘。
        </div>

        <!-- 分步设定 -->
        <div
          v-for="s in onboardSteps"
          :key="s.key"
          class="card nb-step"
          :class="{ skipped: s.skipped }"
        >
          <div class="step-head">
            <span class="step-label">{{ s.label }}</span>
            <span class="tag" :class="s.result ? 'green' : s.skipped ? 'gray' : ''">
              {{ s.skipped ? '已跳过' : s.result ? '已生成' : '待处理' }}
            </span>
            <div class="step-ops">
              <button class="btn" :disabled="s.running" @click="onboardRun(s.key)">
                {{ s.running ? '生成中…' : s.result ? '🔄 重生成' : '⚡ 生成' }}
              </button>
              <button
                v-if="messages.length"
                class="btn"
                :disabled="s.running || onboardConverging"
                @click="convergeToStep(s.key)"
              >
                📐 据讨论整理
              </button>
              <button v-if="!s.result && !s.skipped" class="btn" @click="s.skipped = true">⏭ 跳过</button>
              <button v-else-if="s.skipped" class="btn" @click="s.skipped = false">恢复</button>
            </div>
          </div>
          <template v-if="s.result">
            <textarea v-model="s.result.content" class="result-edit" rows="6"></textarea>
            <div class="step-foot">
              <span class="result-path">{{ s.result.path }} · {{ s.result.words }} 字</span>
              <button class="btn primary" @click="onboardSave(s)">💾 保存</button>
            </div>
          </template>
        </div>

        <!-- 对话式（讨论 → 整理到上方各步） -->
        <div class="card" style="padding: 14px 16px">
          <div class="card-title">💬 设定对话</div>
          <OnboardChat
            :messages="messages"
            :running="chatRunning"
            @send="sendChat"
            @interrupt="interruptChat"
          />
        </div>

        <p v-if="onboardError" class="nb-msg nb-err">{{ onboardError }}</p>
        <p v-if="onboardSaved" class="nb-msg nb-ok">{{ onboardSaved }}</p>

        <div class="btn-row" style="justify-content: flex-end; margin-top: 8px">
          <button class="btn primary" @click="switchMode('write')">完成设定 → 去写章</button>
        </div>
      </template>

      <!-- ============ write 模式：八阶段写章 ============ -->
      <template v-else>
        <!-- 当前状态卡（enter 自动定位） -->
        <div v-if="stateInfo" class="state-card">
          <span class="state-tag">【{{ stateInfo.stateName }}】</span>
          <span class="state-msg">{{ stateInfo.humanMsg }}</span>
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
            <label
              >{{ kind === 'short' ? '篇号' : '章号' }}
              <input
                v-model.number="chapter"
                type="number"
                min="1"
                :disabled="running || outlineRunning || reviewRunning"
            /></label>
            <button
              class="btn-cli"
              :disabled="outlineRunning || running || cliRunning || reviewRunning"
              @click="outlineGen"
            >
              {{ outlineRunning ? (kind === 'short' ? '篇纲中…' : '细纲中…') : kind === 'short' ? '📋 篇纲' : '📋 细纲' }}
            </button>
            <button
              class="btn-cli"
              :disabled="cliRunning || running || outlineRunning || reviewRunning"
              @click="runCliStep('confirm')"
            >
              ✓ 确认
            </button>
            <button
              class="btn-cli"
              :disabled="cliRunning || running || outlineRunning || reviewRunning"
              @click="runCliStep('prepare')"
            >
              📦 备料
            </button>
            <button
              class="btn-fire"
              :disabled="running || outlineRunning || cliRunning || reviewRunning"
              @click="draftWrite"
            >
              {{ running ? '写稿中…' : `✍ 写第 ${chapter} ${kind === 'short' ? '篇' : '章'}` }}
            </button>
            <button v-if="running" class="btn-stop" @click="interruptWrite">⏹ 中断</button>
            <button
              class="btn-cli"
              :disabled="cliRunning || running || outlineRunning || reviewRunning"
              @click="runCliStep('check')"
            >
              🔍 机检
            </button>
            <button
              class="btn-review"
              :disabled="reviewRunning || running || cliRunning || outlineRunning"
              @click="reviewRun"
            >
              {{ reviewRunning ? '三审中…' : '📝 三审' }}
            </button>
            <button
              class="btn-cli"
              :class="{ disabled: !verdictApproved }"
              :disabled="cliRunning || running || outlineRunning || reviewRunning || !verdictApproved"
              @click="runCliStep('finalize')"
            >
              ✅ 定稿
            </button>
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
          <pre class="wb-out" :class="{ empty: !textOut }">{{
            textOut || '（尚未生成 · 点「写稿」流式生成正文）'
          }}</pre>
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
            <button
              v-else
              class="btn primary"
              style="font-size: 11px; padding: 3px 10px"
              @click="verdictApprove"
            >
              裁决通过 →
            </button>
          </div>
          <pre class="report">{{ reviewReport }}</pre>
        </article>
      </template>
    </div>
  </section>
</template>

<style scoped>
/* 对齐 mockup：wb-out 用 <pre>，UA 默认 margin 归零 */
.wb-out {
  margin: 0;
}
.wb-mode-tabs {
  display: inline-flex;
  gap: 4px;
  margin-left: auto;
}
.wb-mode-tabs button {
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid var(--border, #ccc);
  background: var(--panel, #fff);
  color: var(--ink, #666);
  cursor: pointer;
  font-size: 13px;
}
.wb-mode-tabs button.active {
  background: var(--cinnabar, #c0392b);
  color: #fff;
  border-color: var(--cinnabar, #c0392b);
}
.setup-hint {
  font-size: 13px;
  margin-bottom: 12px;
  line-height: 1.6;
}
.nb-msg {
  font-size: 13px;
  margin: 10px 0;
}
.nb-ok {
  color: var(--ink-cyan, #2a7);
}
.nb-err {
  color: var(--cinnabar, #c0392b);
}
</style>
