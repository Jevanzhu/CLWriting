<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import CodeEditor from '../components/CodeEditor.vue'
import BookTabs from '../components/BookTabs.vue'

interface BookConfigLoose {
  spec_version: number
  kind?: 'long' | 'short'
  host?: 'cc' | 'codex'
  book: { title: string; genre: string; volume_size?: number; target_words?: number }
  leads: { enabled: string[]; thresholds?: Record<string, number> }
  budget: { calls_per_chapter: number; input_per_chapter?: number; summary_chapter_max?: number; summary_volume_max?: number }
  style: { injection: 'light' | 'heavy' }
  auto: { confirm_outline: boolean; batch_size: number }
  growth: { realm_span_max?: number }
  [k: string]: unknown
}

const route = useRoute()
const name = computed(() => (typeof route.params.name === 'string' ? route.params.name : ''))
const config = ref<BookConfigLoose | null>(null)
const loading = ref(true)
const saving = ref(false)
const savedMsg = ref('')
const error = ref('')

const styleContent = ref('')
const styleOriginal = ref('')
const styleMissing = ref(false)
const styleSaving = ref(false)

const EXTENDED_LEADS = ['局线', '设定线', '成长线', '关系债']

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const r = await fetch(`/api/books/${encodeURIComponent(name.value)}/config`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const d = (await r.json()) as { config: BookConfigLoose }
    config.value = d.config
    const r2 = await fetch(`/api/books/${encodeURIComponent(name.value)}/file?file=${encodeURIComponent('文风/文风铁律.md')}`)
    if (r2.ok) {
      const d2 = (await r2.json()) as { content: string }
      styleContent.value = d2.content
      styleOriginal.value = d2.content
      styleMissing.value = false
    } else {
      styleMissing.value = true
      styleContent.value = ''
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function toggleLead(l: string): void {
  if (!config.value) return
  const arr = config.value.leads.enabled
  const i = arr.indexOf(l)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(l)
}

async function saveConfig(): Promise<void> {
  if (!config.value || saving.value) return
  saving.value = true
  error.value = ''
  try {
    const r = await fetch(`/api/books/${encodeURIComponent(name.value)}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: config.value }),
    })
    const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    if (!r.ok || !d.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
    savedMsg.value = '配置已保存'
    setTimeout(() => (savedMsg.value = ''), 2000)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

async function saveStyle(): Promise<void> {
  if (styleSaving.value || styleMissing.value) return
  styleSaving.value = true
  error.value = ''
  try {
    const r = await fetch(`/api/books/${encodeURIComponent(name.value)}/file?file=${encodeURIComponent('文风/文风铁律.md')}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: styleContent.value }),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    styleOriginal.value = styleContent.value
    savedMsg.value = '文风铁律已保存'
    setTimeout(() => (savedMsg.value = ''), 2000)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    styleSaving.value = false
  }
}

const styleDirty = computed(() => styleContent.value !== styleOriginal.value)

onMounted(load)
</script>

<template>
  <section class="cfg-page">
    <BookTabs :name="name" active="config" />
    <p v-if="loading" class="hint">加载中…</p>
    <p v-else-if="error && !config" class="error">{{ error }}</p>
    <template v-else-if="config">
      <article class="card">
        <h3>配置 · book.yaml</h3>
        <div class="form">
          <label class="field">书名 <input v-model="config.book.title" /></label>
          <label class="field">题材 <input v-model="config.book.genre" placeholder="玄幻/悬疑/言情…" /></label>
          <label class="field">目标字数(book.target_words) <input type="number" v-model.number="config.book.target_words" placeholder="如：300000" /></label>
          <div class="field">
            <span class="lbl">类型</span>
            <div class="seg">
              <button type="button" :class="{ active: (config.kind ?? 'long') === 'long' }" @click="config.kind = 'long'">长篇</button>
              <button type="button" :class="{ active: config.kind === 'short' }" @click="config.kind = 'short'">短篇集</button>
            </div>
          </div>
          <div v-if="(config.kind ?? 'long') === 'long'" class="field">
            <span class="lbl">扩展账本类</span>
            <div class="leads">
              <label v-for="l in EXTENDED_LEADS" :key="l" class="lead">
                <input type="checkbox" :checked="config.leads.enabled.includes(l)" @change="toggleLead(l)" /> {{ l }}
              </label>
            </div>
          </div>
          <label class="field">每章调用上限(budget.calls_per_chapter) <input type="number" v-model.number="config.budget.calls_per_chapter" /></label>
          <div class="field">
            <span class="lbl">文风注入(style.injection)</span>
            <div class="seg">
              <button type="button" :class="{ active: config.style.injection === 'light' }" @click="config.style.injection = 'light'">light</button>
              <button type="button" :class="{ active: config.style.injection === 'heavy' }" @click="config.style.injection = 'heavy'">heavy</button>
            </div>
          </div>
          <label class="field check">
            <input type="checkbox" v-model="config.auto.confirm_outline" /> 自动确认细纲(auto.confirm_outline)
          </label>
          <label class="field">批量大小(auto.batch_size) <input type="number" v-model.number="config.auto.batch_size" /></label>
          <label class="field">跃迁跨度上限(growth.realm_span_max) <input type="number" v-model.number="config.growth.realm_span_max" /></label>
          <p v-if="error" class="error">{{ error }}</p>
          <div class="actions">
            <span v-if="savedMsg" class="saved">{{ savedMsg }}</span>
            <button class="btn-primary" :disabled="saving" @click="saveConfig">{{ saving ? '保存中…' : '保存配置' }}</button>
          </div>
        </div>
      </article>

      <article class="card">
        <h3>文风铁律 · 文风/文风铁律.md</h3>
        <p v-if="styleMissing" class="hint">这本书没有 文风/文风铁律.md(可在编辑器创建后回来编辑)。</p>
        <template v-else>
          <CodeEditor :model-value="styleContent" mode="md" @update:model-value="styleContent = $event" />
          <div class="actions">
            <button class="btn-primary" :disabled="!styleDirty || styleSaving" @click="saveStyle">{{ styleSaving ? '保存中…' : '保存文风铁律' }}</button>
          </div>
        </template>
      </article>
    </template>
  </section>
</template>

<style scoped>
.cfg-page {
  max-width: 880px;
  margin: 0 auto;
  text-align: left;
}
.card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 16px 20px;
  margin-bottom: 16px;
}
.card h3 {
  margin: 0 0 14px;
  font-size: 15px;
}
.form {
  display: grid;
  gap: 14px;
}
.field {
  display: grid;
  gap: 4px;
  font-size: 13px;
  color: #374151;
}
.field .lbl {
  color: #374151;
}
.field input:not([type='checkbox']) {
  padding: 6px 10px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 14px;
}
.field.check {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.seg {
  display: inline-flex;
  gap: 8px;
}
.seg button {
  padding: 5px 14px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  font-size: 13px;
}
.seg button.active {
  border-color: #3b82f6;
  background: #eff6ff;
  color: #3b82f6;
  font-weight: 600;
}
.leads {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.lead {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 14px;
  cursor: pointer;
}
.actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
}
.btn-primary {
  padding: 7px 20px;
  border: none;
  border-radius: 6px;
  background: #3b82f6;
  color: #fff;
  cursor: pointer;
  font-size: 13px;
}
.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.saved {
  color: #059669;
  font-size: 13px;
}
.error {
  color: #dc2626;
  font-size: 13px;
}
.hint {
  color: #6b7280;
  font-size: 13px;
  padding: 16px 0;
}
</style>
