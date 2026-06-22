<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import BookTabs from '../components/BookTabs.vue'

/** driver 事件(松类型,前端按 type 分支取字段) */
interface DriverEvent {
  type: string
  [k: string]: unknown
}

const route = useRoute()
const name = computed(() => (typeof route.params.name === 'string' ? route.params.name : ''))

const roles = ['writer', 'continuity-review', 'editor-review', 'reader-review']
const role = ref('writer')
const prompt = ref('写第 1 章开头约 300 字(测试 mock driver 事件流)')
const mode = ref<'spawnRole' | 'send'>('spawnRole')
const running = ref(false)
const textOut = ref('')
const log = ref<{ t: string; type: string; text: string }[]>([])
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
    handleEvent(ev)
  }
  // EventSource 自动重连,onerror 静默
}

function handleEvent(ev: DriverEvent): void {
  const t = new Date().toLocaleTimeString('zh-CN')
  switch (ev.type) {
    case 'init':
      log.value.push({ t, type: 'init', text: `会话就绪 · 角色 ${((ev.agents as string[]) ?? []).join('/')}` })
      break
    case 'text':
      textOut.value += String(ev.text ?? '')
      break
    case 'role_spawn':
      log.value.push({ t, type: 'spawn', text: `spawn ${ev.role}` })
      break
    case 'tool_use':
      log.value.push({ t, type: 'tool', text: `🔧 ${ev.tool}` })
      break
    case 'tool_result':
      log.value.push({ t, type: 'result', text: '工具结果' })
      break
    case 'usage':
      log.value.push({ t, type: 'usage', text: `成本 $${ev.cost} · ${ev.tokens} tokens` })
      break
    case 'done':
      running.value = false
      log.value.push({ t, type: 'done', text: `完成(${ev.reason})` })
      break
    case 'error':
      running.value = false
      log.value.push({ t, type: 'error', text: `错误:${ev.message}` })
      break
    default:
      log.value.push({ t, type: ev.type, text: JSON.stringify(ev).slice(0, 80) })
  }
}

async function fire(): Promise<void> {
  if (running.value || !name.value) return
  running.value = true
  textOut.value = ''
  try {
    const r = await fetch(`/api/books/${encodeURIComponent(name.value)}/spawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: role.value, prompt: prompt.value, mode: mode.value }),
    })
    if (!r.ok) {
      running.value = false
      const e = (await r.json().catch(() => ({}))) as { error?: string }
      log.value.push({ t: new Date().toLocaleTimeString('zh-CN'), type: 'error', text: e.error ?? `HTTP ${r.status}` })
    }
  } catch (e) {
    running.value = false
    log.value.push({
      t: new Date().toLocaleTimeString('zh-CN'),
      type: 'error',
      text: e instanceof Error ? e.message : String(e),
    })
  }
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

    <div class="mock-banner">⚡ mock driver(批1):无 CLI / 无认证,事件流为模拟。真 driver(批2)接 claude CLI。</div>

    <!-- 触发控制 -->
    <article class="card ctrl">
      <div class="ctrl-row">
        <label>角色
          <select v-model="role">
            <option v-for="r in roles" :key="r" :value="r">{{ r }}</option>
          </select>
        </label>
        <label>模式
          <select v-model="mode">
            <option value="spawnRole">spawnRole(干净上下文)</option>
            <option value="send">send(主 agent 软触发)</option>
          </select>
        </label>
      </div>
      <textarea v-model="prompt" rows="2" class="prompt-input" placeholder="prompt"></textarea>
      <button class="btn-fire" :disabled="running" @click="fire">
        {{ running ? '生成中…' : `${mode === 'send' ? 'send' : `spawnRole(${role})`} →` }}
      </button>
    </article>

    <!-- 文本输出 -->
    <article class="card">
      <h3 class="block-title">输出</h3>
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
        <li v-if="!log.length" class="empty">等待事件…(init 应已到)</li>
      </ul>
    </article>
  </section>
</template>

<style scoped>
.wb-page {
  max-width: 960px;
  margin: 0 auto;
}
.mock-banner {
  padding: 8px 12px;
  background: #fef3c7;
  color: #92400e;
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

.ctrl-row {
  display: flex;
  gap: 20px;
  margin-bottom: 12px;
}
.ctrl-row label {
  display: grid;
  gap: 4px;
  font-size: 13px;
  color: #6b7280;
}
select {
  padding: 5px 8px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 14px;
  background: #fff;
}
.prompt-input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 14px;
  font-family: inherit;
  resize: vertical;
  margin-bottom: 12px;
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
}

.log {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 4px;
  max-height: 260px;
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
.ev-init .ev-type {
  color: #059669;
}
.ev-done .ev-type {
  color: #059669;
  font-weight: 600;
}
.ev-error .ev-type,
.ev-error .ev-text {
  color: #dc2626;
}
.ev-spawn .ev-type {
  color: #7c3aed;
}
.ev-text {
  color: #4b5563;
}
</style>
