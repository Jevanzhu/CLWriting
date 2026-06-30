<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { useWorkbenchLog } from '../composables/useWorkbenchLog'
import { useHint } from '../composables/useHint'
import {
  approveReview,
  generateOutline,
  getConfig,
  getDraftPrompt,
  getState,
  interruptBook,
  runCli,
  runReview,
  saveDraft as saveDraftApi,
  spawnRole,
} from '../api/books'

/** driver 事件(松类型,按 type 分支取字段) */
interface DriverEvent {
  type: string
  [k: string]: unknown
}

const route = useRoute()
const name = computed(() => (typeof route.params.name === 'string' ? route.params.name : ''))

// 八阶段骨架(C.3 全接:细纲/确认/备料/写稿/机检/三审/定稿)
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
const activeStage = ref('draft')
const stageIndex = computed(() => stages.findIndex((s) => s.id === activeStage.value))

const chapter = ref(1)
const running = ref(false)
const outlineRunning = ref(false)
const draftMode = ref(false)
const cliRunning = ref(false)
const reviewRunning = ref(false)
const textOut = ref('')
// 事件流走共享状态（useWorkbenchLog），右栏 EventStream 实时联动
const { log } = useWorkbenchLog()
const { hint } = useHint()
const saved = ref<{ path: string; words: number } | null>(null)
const outlineSaved = ref<{ path: string; words: number } | null>(null)
const checkReport = ref('') // 机检报告(check stdout)
const reviewReport = ref('') // 审稿单(review report 全文)
const verdictApproved = ref(false)
// 6.8① enter 自动定位:顶部状态卡(当前态 + 人话)
const stateInfo = ref<{ stateName: string; humanMsg: string } | null>(null)
// 6.8② 自动推进开关(默认开;确定性步→确定性步自动,AI/人工步前停)
const autoAdvance = ref(true)
// 6.8③ draft 中断:中断后保留已生成,可弃稿/改指令重写
const interrupted = ref(false)
let es: EventSource | null = null

function ts(): string {
  return new Date().toLocaleTimeString('zh-CN')
}

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
    handleEvent(ev)
  }
}

function handleEvent(ev: DriverEvent): void {
  const t = ts()
  switch (ev.type) {
    case 'init':
      log.value.push({ t, type: 'init', text: `会话就绪 · 角色 ${((ev.agents as string[]) ?? []).join('/')}` })
      break
    case 'text':
      textOut.value += String(ev.text ?? '')
      break
    case 'tool_use':
      log.value.push({ t, type: 'tool', text: `🔧 ${ev.tool}` })
      break
    case 'usage':
      log.value.push({ t, type: 'usage', text: `成本 $${ev.cost} · ${ev.tokens} tokens` })
      break
    case 'review-progress':
      // 6.8④ 三审逐角进度回流
      log.value.push({
        t,
        type: 'spawn',
        text: `${ev.phase === 'start' ? '🔍' : '✓'} ${String(ev.label ?? '')}审${ev.phase === 'start' ? '中…' : '完'}`,
      })
      break
    case 'interrupted':
      // 6.8③ draft 中断:保留已生成,等作者弃稿/重写
      running.value = false
      draftMode.value = false
      interrupted.value = true
      log.value.push({ t, type: 'error', text: `⏹ 已中断(${String(ev.reason ?? '')})——正文已保留,可弃稿或改指令重写` })
      break
    case 'done':
      running.value = false
      log.value.push({ t, type: 'done', text: `完成(${ev.reason})` })
      if (draftMode.value) void saveDraft()
      break
    case 'error':
      running.value = false
      draftMode.value = false
      log.value.push({ t, type: 'error', text: `错误:${ev.message}` })
      break
  }
}

/** CLI 确定性步:confirm/prepare/check/finalize。返回是否成功(供自动推进判断) */
async function runCliStep(step: 'confirm' | 'prepare' | 'check' | 'finalize'): Promise<boolean> {
  if (cliRunning.value || running.value || outlineRunning.value || reviewRunning.value || !name.value) return false
  cliRunning.value = true
  activeStage.value = step
  interrupted.value = false
  log.value.push({ t: ts(), type: 'spawn', text: `${step} 第 ${chapter.value} ${kind.value === 'short' ? '篇' : '章'}…` })
  let stepOk = false
  try {
    const d = await runCli(name.value, { step, chapter: chapter.value })
    const out = String(d.stdout ?? '').trim()
    const err = String(d.stderr || d.stdout || '').trim()
    if (d.ok) {
      stepOk = true
      if (step === 'check') {
        checkReport.value = out
        log.value.push({ t: ts(), type: 'saved', text: `机检 ✓(见机检报告)` })
      } else if (step === 'finalize') {
        log.value.push({ t: ts(), type: 'saved', text: `定稿 ✓ ${out.slice(0, 80)}` })
      } else {
        log.value.push({ t: ts(), type: 'saved', text: `${step} ✓ ${out.slice(0, 80)}` })
      }
    } else {
      if (step === 'check') checkReport.value = err
      log.value.push({ t: ts(), type: 'error', text: `${step} 失败:${err.slice(0, 120)}` })
    }
  } catch (e) {
    log.value.push({ t: ts(), type: 'error', text: e instanceof Error ? e.message : String(e) })
  }
  cliRunning.value = false
  // 6.8② 自动推进:confirm done → prepare(确定性→确定性);prepare/check 后是 AI 步停;finalize 末步停
  if (stepOk && autoAdvance.value && step === 'confirm') {
    log.value.push({ t: ts(), type: 'spawn', text: `→ 自动备料` })
    void runCliStep('prepare')
  }
  return stepOk
}

/** outline 生成:POST /outline(后端组 prompt + spawnRole('outline')禁工具 + 落盘 细纲) */
async function outlineGen(): Promise<void> {
  if (outlineRunning.value || running.value || !name.value) return
  outlineRunning.value = true
  outlineSaved.value = null
  activeStage.value = 'outline'
  log.value.push({ t: ts(), type: 'spawn', text: `生成第 ${chapter.value} ${kind.value === 'short' ? '篇篇纲' : '章细纲'}…` })
  try {
    const d = await generateOutline(name.value, chapter.value)
    outlineSaved.value = d
    log.value.push({ t: ts(), type: 'saved', text: `${kind.value === 'short' ? '篇纲' : '细纲'}已生成 ${d.path}(${d.words} 字)` })
  } catch (e) {
    log.value.push({ t: ts(), type: 'error', text: e instanceof Error ? e.message : String(e) })
  }
  outlineRunning.value = false
}

/** draft 写稿:组 prompt → spawnRole(writer)→ 事件流收 text → done 后 saveDraft 落盘 */
async function draftWrite(): Promise<void> {
  if (running.value || !name.value) return
  draftMode.value = true
  interrupted.value = false
  saved.value = null
  textOut.value = ''
  running.value = true
  activeStage.value = 'draft'
  // 拉后端组的 draft prompt(细纲+备料,方案 6.6)
  let prompt = ''
  try {
    prompt = await getDraftPrompt(name.value, chapter.value)
  } catch (e) {
    running.value = false
    draftMode.value = false
    log.value.push({ t: ts(), type: 'error', text: `拉 draft-prompt 失败:${e instanceof Error ? e.message : String(e)}` })
    return
  }
  if (!prompt.includes('本章细纲')) {
    running.value = false
    draftMode.value = false
    log.value.push({ t: ts(), type: 'error', text: 'draft 缺细纲——请先「生成细纲→确认→备料」再写稿' })
    return
  }
  log.value.push({ t: ts(), type: 'spawn', text: `spawnRole(writer)·第 ${chapter.value} ${kind.value === 'short' ? '篇(含篇纲)' : '章(含细纲+备料)'}` })
  try {
    await spawnRole(name.value, { role: 'writer', prompt, mode: 'spawnRole' })
  } catch (e) {
    running.value = false
    draftMode.value = false
    log.value.push({ t: ts(), type: 'error', text: e instanceof Error ? e.message : String(e) })
  }
}

/** 6.8③ 中断当前写稿:POST /interrupt → driver kill 子进程 + 推 interrupted */
async function interruptWrite(): Promise<void> {
  if (!name.value) return
  try {
    await interruptBook(name.value)
  } catch {
    /* interrupted 事件会经 SSE 到达,前端自行收尾 */
  }
}

/** 6.8③ 弃稿:清空已生成正文 */
function discardDraft(): void {
  textOut.value = ''
  interrupted.value = false
  saved.value = null
  log.value.push({ t: ts(), type: 'error', text: '已弃稿(清空正文)' })
}

/** 三审:POST /review(run→spawnRole×3 reader/editor/continuity→collect)→ 审稿单 */
async function reviewRun(): Promise<void> {
  if (reviewRunning.value || running.value || cliRunning.value || outlineRunning.value || !name.value) return
  reviewRunning.value = true
  reviewReport.value = ''
  verdictApproved.value = false
  activeStage.value = 'review'
  log.value.push({ t: ts(), type: 'spawn', text: `三审第 ${chapter.value} ${kind.value === 'short' ? '篇' : '章'}(run→镜头审→collect)…` })
  try {
    const d = await runReview(name.value, chapter.value)
    reviewReport.value = d.report ?? ''
    log.value.push({ t: ts(), type: 'saved', text: `三审 ✓ 视角:${(d.lenses ?? []).join('/')}(见审稿单)` })
  } catch (e) {
    log.value.push({ t: ts(), type: 'error', text: e instanceof Error ? e.message : String(e) })
  }
  reviewRunning.value = false
}

/** 裁决通过:POST /review-verdict {approved:true} → finalize 可放行 */
async function verdictApprove(): Promise<void> {
  if (!name.value || !reviewReport.value) return
  try {
    await approveReview(name.value)
    verdictApproved.value = true
    log.value.push({ t: ts(), type: 'saved', text: `裁决:通过(可定稿)` })
    hint('裁决通过 · 可定稿')
    // 6.8② 自动推进:裁决通过 → 定稿(人工 done → 确定性步)
    if (autoAdvance.value) {
      log.value.push({ t: ts(), type: 'spawn', text: `→ 自动定稿` })
      void runCliStep('finalize')
    }
  } catch (e) {
    log.value.push({ t: ts(), type: 'error', text: e instanceof Error ? e.message : String(e) })
  }
}

/** done 后落盘:driver text → 工作区/草稿-1.md */
async function saveDraft(): Promise<void> {
  const content = textOut.value.trim()
  if (!content) {
    draftMode.value = false
    return
  }
  try {
    const d = await saveDraftApi(name.value, { chapter: chapter.value, content })
    saved.value = d
    log.value.push({ t: ts(), type: 'saved', text: `已保存 ${d.path}(${d.words} 字)` })
    // 6.8② 自动推进:draft 落盘 → 机检(AI done → 确定性步)
    if (autoAdvance.value) {
      log.value.push({ t: ts(), type: 'spawn', text: `→ 自动机检` })
      void runCliStep('check')
    }
  } catch (e) {
    log.value.push({ t: ts(), type: 'error', text: e instanceof Error ? e.message : String(e) })
  }
  draftMode.value = false
}

/** 自动推进开关切换：即时反馈（对齐 mockup showHint） */
function onAutoToggle(): void {
  hint('自动推进 ' + (autoAdvance.value ? '已开' : '已关'))
}

const kind = ref<'long' | 'short'>('long')
async function loadKind(): Promise<void> {
  try {
    const config = await getConfig(name.value)
    kind.value = (config.kind ?? 'long') === 'short' ? 'short' : 'long'
  } catch {
    /* ignore */
  }
}

/** 6.8① enter 自动定位:拉 /state → 顶部状态卡 + 自动填章号 */
async function loadState(): Promise<void> {
  if (!name.value) return
  try {
    const d = await getState(name.value)
    stateInfo.value = { stateName: d.stateName ?? '', humanMsg: d.humanMsg ?? '' }
    if (typeof d.nextChapter === 'number' && d.nextChapter > 0) chapter.value = d.nextChapter
  } catch {
    /* 状态卡可选,失败不阻塞 */
  }
}

onMounted(() => {
  if (name.value) {
    connect(name.value)
    void loadKind()
    void loadState()
  }
})
watch(name, (n) => {
  if (n) {
    connect(n)
    void loadState()
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

      <!-- 八阶段骨架 -->
      <nav class="stages">
        <div
          v-for="(s, i) in stages"
          :key="s.id"
          class="stage"
          :class="{ done: stageIndex > i, active: s.id === activeStage }"
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
          <span class="interrupt-tip">写稿已中断，正文已保留（{{ textOut.length }} 字）。</span>
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
