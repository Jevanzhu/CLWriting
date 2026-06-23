<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import BookTabs from '../components/BookTabs.vue'

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

const chapter = ref(1)
const running = ref(false)
const outlineRunning = ref(false)
const draftMode = ref(false)
const cliRunning = ref(false)
const reviewRunning = ref(false)
const textOut = ref('')
const log = ref<{ t: string; type: string; text: string }[]>([])
const saved = ref<{ path: string; words: number } | null>(null)
const outlineSaved = ref<{ path: string; words: number } | null>(null)
const checkReport = ref('') // 机检报告(check stdout)
const reviewReport = ref('') // 审稿单(review report 全文)
const verdictApproved = ref(false)
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

/** CLI 确定性步:confirm/prepare/check/finalize。check 存机检报告,余入事件流 */
async function runCliStep(step: 'confirm' | 'prepare' | 'check' | 'finalize'): Promise<void> {
  if (cliRunning.value || running.value || outlineRunning.value || reviewRunning.value || !name.value) return
  cliRunning.value = true
  activeStage.value = step
  log.value.push({ t: ts(), type: 'spawn', text: `${step} 第 ${chapter.value} ${kind.value === 'short' ? '篇' : '章'}…` })
  try {
    const r = await fetch(`/api/books/${encodeURIComponent(name.value)}/cli`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ step, chapter: chapter.value }),
    })
    const d = (await r.json()) as { ok?: boolean; stdout?: string; stderr?: string }
    const out = String(d.stdout ?? '').trim()
    const err = String(d.stderr || d.stdout || '').trim()
    if (d.ok) {
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
}

/** outline 生成:POST /outline(后端组 prompt + spawnRole('outline')禁工具 + 落盘 细纲) */
async function outlineGen(): Promise<void> {
  if (outlineRunning.value || running.value || !name.value) return
  outlineRunning.value = true
  outlineSaved.value = null
  activeStage.value = 'outline'
  log.value.push({ t: ts(), type: 'spawn', text: `生成第 ${chapter.value} ${kind.value === 'short' ? '篇篇纲' : '章细纲'}…` })
  try {
    const r = await fetch(`/api/books/${encodeURIComponent(name.value)}/outline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chapter: chapter.value }),
    })
    const d = (await r.json()) as { ok?: boolean; path?: string; words?: number; error?: string }
    if (r.ok && d.ok) {
      outlineSaved.value = { path: d.path ?? '', words: d.words ?? 0 }
      log.value.push({ t: ts(), type: 'saved', text: `${kind.value === 'short' ? '篇纲' : '细纲'}已生成 ${d.path}(${d.words} 字)` })
    } else {
      log.value.push({ t: ts(), type: 'error', text: d.error ?? `HTTP ${r.status}` })
    }
  } catch (e) {
    log.value.push({ t: ts(), type: 'error', text: e instanceof Error ? e.message : String(e) })
  }
  outlineRunning.value = false
}

/** draft 写稿:组 prompt → spawnRole(writer)→ 事件流收 text → done 后 saveDraft 落盘 */
async function draftWrite(): Promise<void> {
  if (running.value || !name.value) return
  draftMode.value = true
  saved.value = null
  textOut.value = ''
  running.value = true
  activeStage.value = 'draft'
  // 拉后端组的 draft prompt(细纲+备料,方案 6.6)
  let prompt = ''
  try {
    const pr = await fetch(`/api/books/${encodeURIComponent(name.value)}/draft-prompt?chapter=${chapter.value}`)
    const pd = (await pr.json()) as { prompt?: string; error?: string }
    prompt = pd.prompt ?? ''
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
    const r = await fetch(`/api/books/${encodeURIComponent(name.value)}/spawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'writer', prompt, mode: 'spawnRole' }),
    })
    if (!r.ok) {
      running.value = false
      draftMode.value = false
      const e = (await r.json().catch(() => ({}))) as { error?: string }
      log.value.push({ t: ts(), type: 'error', text: e.error ?? `HTTP ${r.status}` })
    }
  } catch (e) {
    running.value = false
    draftMode.value = false
    log.value.push({ t: ts(), type: 'error', text: e instanceof Error ? e.message : String(e) })
  }
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
    const r = await fetch(`/api/books/${encodeURIComponent(name.value)}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chapter: chapter.value }),
    })
    const d = (await r.json()) as { ok?: boolean; lenses?: string[]; report?: string; error?: string }
    if (r.ok && d.ok) {
      reviewReport.value = d.report ?? ''
      log.value.push({ t: ts(), type: 'saved', text: `三审 ✓ 视角:${(d.lenses ?? []).join('/')}(见审稿单)` })
    } else {
      log.value.push({ t: ts(), type: 'error', text: d.error ?? `HTTP ${r.status}` })
    }
  } catch (e) {
    log.value.push({ t: ts(), type: 'error', text: e instanceof Error ? e.message : String(e) })
  }
  reviewRunning.value = false
}

/** 裁决通过:POST /review-verdict {approved:true} → finalize 可放行 */
async function verdictApprove(): Promise<void> {
  if (!name.value || !reviewReport.value) return
  try {
    const r = await fetch(`/api/books/${encodeURIComponent(name.value)}/review-verdict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    })
    const d = (await r.json()) as { ok?: boolean; approved?: boolean; error?: string }
    if (r.ok && d.ok) {
      verdictApproved.value = true
      log.value.push({ t: ts(), type: 'saved', text: `裁决:通过(可定稿)` })
    } else {
      log.value.push({ t: ts(), type: 'error', text: d.error ?? `HTTP ${r.status}` })
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
    const r = await fetch(`/api/books/${encodeURIComponent(name.value)}/draft-save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chapter: chapter.value, content }),
    })
    const d = (await r.json()) as { ok?: boolean; path?: string; words?: number; error?: string }
    if (r.ok && d.ok) {
      saved.value = { path: d.path ?? '', words: d.words ?? 0 }
      log.value.push({ t: ts(), type: 'saved', text: `已保存 ${d.path}(${d.words} 字)` })
    } else {
      log.value.push({ t: ts(), type: 'error', text: d.error ?? `HTTP ${r.status}` })
    }
  } catch (e) {
    log.value.push({ t: ts(), type: 'error', text: e instanceof Error ? e.message : String(e) })
  }
  draftMode.value = false
}

const kind = ref<'long' | 'short'>('long')
async function loadKind(): Promise<void> {
  try {
    const r = await fetch(`/api/books/${encodeURIComponent(name.value)}/config`)
    const d = (await r.json()) as { config?: { kind?: string } }
    kind.value = (d.config?.kind ?? 'long') === 'short' ? 'short' : 'long'
  } catch {
    /* ignore */
  }
}

onMounted(() => {
  if (name.value) {
    connect(name.value)
    void loadKind()
  }
})
watch(name, (n) => {
  if (n) connect(n)
})
onUnmounted(() => es?.close())
</script>

<template>
  <section class="wb-page">
    <BookTabs :name="name" active="workbench" />

    <div class="cc-banner">
      ⚡ 八阶段全接(细纲→确认→备料→写稿→机检→三审→定稿)。AI 步(细纲/写稿/三审)经 claude
      CLI,确定性步(确认/备料/机检/定稿)经 clwriting CLI。
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

    <!-- 控制区:七按钮(进入隐含在选章)-->
    <article class="card ctrl">
      <div class="ctrl-row">
        <label>{{ kind === 'short' ? '篇号' : '章号' }}
          <input v-model.number="chapter" type="number" min="1" :disabled="running || outlineRunning || reviewRunning" />
        </label>
        <button class="btn-outline" :disabled="outlineRunning || running || cliRunning || reviewRunning" @click="outlineGen">
          {{ outlineRunning ? (kind === 'short' ? '篇纲中…' : '细纲中…') : (kind === 'short' ? '📋 篇纲' : '📋 细纲') }}
        </button>
        <button class="btn-cli" :disabled="cliRunning || running || outlineRunning || reviewRunning" @click="runCliStep('confirm')">✓ 确认</button>
        <button class="btn-cli" :disabled="cliRunning || running || outlineRunning || reviewRunning" @click="runCliStep('prepare')">📦 备料</button>
        <button class="btn-fire" :disabled="running || outlineRunning || cliRunning || reviewRunning" @click="draftWrite">
          {{ running ? '写稿中…' : `✍ 写第 ${chapter} ${kind === 'short' ? '篇' : '章'}` }}
        </button>
        <button class="btn-cli" :disabled="cliRunning || running || outlineRunning || reviewRunning" @click="runCliStep('check')">🔍 机检</button>
        <button class="btn-review" :disabled="reviewRunning || running || cliRunning || outlineRunning" @click="reviewRun">
          {{ reviewRunning ? '三审中…' : '📝 三审' }}
        </button>
        <button class="btn-cli" :disabled="cliRunning || running || outlineRunning || reviewRunning || !verdictApproved" @click="runCliStep('finalize')">✅ 定稿</button>
      </div>
      <p v-if="outlineSaved" class="saved-tip">📋 细纲已生成:<span class="mono">{{ outlineSaved.path }}</span>({{ outlineSaved.words }} 字)</p>
      <p v-if="saved" class="saved-tip">✅ 草稿已保存:<span class="mono">{{ saved.path }}</span>({{ saved.words }} 字)</p>
      <p v-if="verdictApproved" class="saved-tip">✓ 裁决通过,可定稿</p>
    </article>

    <!-- 正文输出 -->
    <article class="card">
      <h3 class="block-title">正文输出</h3>
      <pre class="text-out">{{ textOut || '(尚未生成)' }}</pre>
    </article>

    <!-- 机检报告 -->
    <article v-if="checkReport" class="card">
      <h3 class="block-title">机检报告</h3>
      <pre class="report-out">{{ checkReport }}</pre>
    </article>

    <!-- 审稿单 -->
    <article v-if="reviewReport" class="card">
      <h3 class="block-title">
        审稿单
        <button v-if="!verdictApproved" class="btn-approve" @click="verdictApprove">裁决通过 →</button>
      </h3>
      <pre class="report-out">{{ reviewReport }}</pre>
    </article>

    <!-- 事件流 -->
    <article class="card">
      <h3 class="block-title">事件流</h3>
      <ul class="log">
        <li v-for="(l, i) in log" :key="i" :class="`ev-${l.type}`">
          <span class="ev-time">{{ l.t }}</span>
          <span class="ev-type">{{ l.type }}</span>
          <span class="ev-text">{{ l.text }}</span>
        </li>
        <li v-if="!log.length" class="empty">等待事件…</li>
      </ul>
    </article>
  </section>
</template>

<style scoped>
.wb-page {
  max-width: 960px;
  margin: 0 auto;
}
.cc-banner {
  padding: 8px 12px;
  background: #dbeafe;
  color: #1e40af;
  border-radius: 6px;
  font-size: 13px;
  margin-bottom: 16px;
}
.card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 16px 20px;
}
.card + .card {
  margin-top: 16px;
}
.block-title {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 600;
  color: #6b7280;
  letter-spacing: 0.04em;
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 八阶段骨架 */
.stages {
  display: flex;
  gap: 6px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.stage {
  padding: 5px 12px;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
  font-size: 13px;
  color: #9ca3af;
  background: #fff;
}
.stage.active {
  background: #3b82f6;
  color: #fff;
  border-color: #3b82f6;
  font-weight: 600;
}

/* 控制区 */
.ctrl-row {
  display: flex;
  gap: 10px;
  align-items: flex-end;
  flex-wrap: wrap;
}
.ctrl-row label {
  display: grid;
  gap: 4px;
  font-size: 13px;
  color: #6b7280;
}
input[type='number'] {
  width: 80px;
  padding: 6px 8px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 14px;
}
.btn-outline {
  padding: 8px 14px;
  border: 1px solid #3b82f6;
  border-radius: 6px;
  background: #fff;
  color: #3b82f6;
  font-size: 14px;
  cursor: pointer;
}
.btn-outline:disabled {
  border-color: #d1d5db;
  color: #9ca3af;
  cursor: not-allowed;
}
.btn-cli {
  padding: 8px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  color: #374151;
  font-size: 14px;
  cursor: pointer;
}
.btn-cli:disabled {
  border-color: #e5e7eb;
  color: #9ca3af;
  cursor: not-allowed;
}
.btn-fire {
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  background: #3b82f6;
  color: #fff;
  font-size: 14px;
  cursor: pointer;
}
.btn-fire:disabled {
  background: #d1d5db;
  cursor: not-allowed;
}
.btn-review {
  padding: 8px 14px;
  border: 1px solid #7c3aed;
  border-radius: 6px;
  background: #fff;
  color: #7c3aed;
  font-size: 14px;
  cursor: pointer;
}
.btn-review:disabled {
  border-color: #d1d5db;
  color: #9ca3af;
  cursor: not-allowed;
}
.btn-approve {
  margin-left: auto;
  padding: 4px 12px;
  border: none;
  border-radius: 6px;
  background: #059669;
  color: #fff;
  font-size: 12px;
  cursor: pointer;
}
.saved-tip {
  margin: 12px 0 0;
  padding: 8px 12px;
  background: #d1fae5;
  color: #065f46;
  border-radius: 6px;
  font-size: 13px;
}
.mono {
  font-family: ui-monospace, monospace;
}

/* 输出 + 报告 + 事件流 */
.text-out,
.report-out {
  margin: 0;
  padding: 12px;
  background: #f9fafb;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.6;
  color: #111827;
  white-space: pre-wrap;
  max-height: 360px;
  overflow-y: auto;
}
.text-out {
  min-height: 48px;
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
  grid-template-columns: 72px 64px 1fr;
  gap: 8px;
  align-items: baseline;
  font-size: 13px;
  padding: 3px 0;
}
.log li.empty {
  color: #9ca3af;
  display: block;
}
.ev-time {
  color: #9ca3af;
  font-family: ui-monospace, monospace;
  font-size: 12px;
}
.ev-type {
  color: #6b7280;
  font-size: 12px;
}
.ev-init .ev-type,
.ev-done .ev-type {
  color: #059669;
}
.ev-saved .ev-type,
.ev-saved .ev-text {
  color: #065f46;
}
.ev-spawn .ev-type {
  color: #7c3aed;
}
.ev-error .ev-type,
.ev-error .ev-text {
  color: #dc2626;
}
.ev-text {
  color: #4b5563;
}
</style>
