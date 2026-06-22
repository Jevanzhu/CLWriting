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

// 八阶段骨架(C.1 draft 激活,余占位;C.2/C.3 补)
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
const draftMode = ref(false)
const textOut = ref('')
const log = ref<{ t: string; type: string; text: string }[]>([])
const saved = ref<{ path: string; words: number } | null>(null)
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

/** draft 写稿:组 prompt → spawnRole(writer)→ 事件流收 text → done 后 saveDraft 落盘 */
async function draftWrite(): Promise<void> {
  if (running.value || !name.value) return
  draftMode.value = true
  saved.value = null
  textOut.value = ''
  running.value = true
  activeStage.value = 'draft'
  // C.1 简化 prompt(无细纲/备料,归 C.2);writer 规则已在 .claude/agents/writer.md
  const prompt = `## 任务\n写第 ${chapter.value} 章正文(长篇,2000-4000 字,单章一主场景,章尾留钩)。\n\n## 要求\n按你的角色规则直接输出正文(纯文本,禁 MD 标题/格式,仅段落+空行),不要读任何文件、不要用任何工具。`
  log.value.push({ t: ts(), type: 'spawn', text: `spawnRole(writer)·第 ${chapter.value} 章` })
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

/** done 后落盘:driver text → 工作区/草稿-N.md */
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

onMounted(() => {
  if (name.value) connect(name.value)
})
watch(name, (n) => {
  if (n) connect(n)
})
onUnmounted(() => es?.close())
</script>

<template>
  <section class="wb-page">
    <BookTabs :name="name" active="workbench" />

    <div class="cc-banner">⚡ cc driver:经 claude CLI 生成(复用你的认证 / GLM 网关)。C.1:draft 写稿 + 落盘 工作区/草稿-N.md。</div>

    <!-- 八阶段骨架 -->
    <nav class="stages">
      <span
        v-for="s in stages"
        :key="s.id"
        class="stage"
        :class="{ active: s.id === activeStage }"
      >{{ s.label }}</span>
    </nav>

    <!-- draft 写稿 -->
    <article class="card ctrl">
      <div class="ctrl-row">
        <label>章号
          <input v-model.number="chapter" type="number" min="1" :disabled="running" />
        </label>
        <button class="btn-fire" :disabled="running" @click="draftWrite">
          {{ running ? '写稿中…' : `✍ 写第 ${chapter} 章 →` }}
        </button>
      </div>
      <p v-if="saved" class="saved-tip">✅ 已保存:<span class="mono">{{ saved.path }}</span>({{ saved.words }} 字)</p>
    </article>

    <!-- 正文输出 -->
    <article class="card">
      <h3 class="block-title">正文输出</h3>
      <pre class="text-out">{{ textOut || '(尚未生成)' }}</pre>
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

/* draft 控制 */
.ctrl-row {
  display: flex;
  gap: 16px;
  align-items: flex-end;
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
.btn-fire {
  padding: 8px 18px;
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

/* 输出 + 事件流 */
.text-out {
  margin: 0;
  padding: 12px;
  background: #f9fafb;
  border-radius: 6px;
  font-size: 14px;
  line-height: 1.6;
  color: #111827;
  white-space: pre-wrap;
  min-height: 48px;
  max-height: 360px;
  overflow-y: auto;
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
