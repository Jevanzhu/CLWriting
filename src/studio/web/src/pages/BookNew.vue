<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const name = ref('')
const genre = ref('')
const kind = ref<'long' | 'short'>('long')
const leads = ref<string[]>([])
const submitting = ref(false)
const error = ref('')

const EXTENDED_LEADS = ['局线', '设定线', '成长线', '关系债']

function toggleLead(l: string): void {
  const i = leads.value.indexOf(l)
  if (i >= 0) leads.value.splice(i, 1)
  else leads.value.push(l)
}

async function submit(): Promise<void> {
  submitting.value = true
  error.value = ''
  try {
    const body: Record<string, unknown> = {
      name: name.value.trim(),
      genre: genre.value.trim(),
      kind: kind.value,
      host: 'cc',
    }
    // 长篇且用户勾选了扩展类才传；留空 → doInit 按题材自动推荐
    if (kind.value === 'long' && leads.value.length > 0) body.leads = leads.value
    const r = await fetch('/api/books', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = (await r.json().catch(() => ({}))) as { name?: string; error?: string }
    if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`)
    router.push(`/books/${encodeURIComponent(data.name ?? name.value.trim())}`)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    submitting.value = false
  }
}

const canSubmit = computed(() => name.value.trim().length > 0 && !submitting.value)
</script>

<template>
  <section class="book-new">
    <div class="head">
      <button class="btn-back" @click="router.push('/')">← 返回书架</button>
    </div>
    <h2>新建书籍</h2>

    <form class="form" @submit.prevent="submit">
      <div class="field">
        <label>书名 <span class="req">*</span></label>
        <input v-model="name" placeholder="如：我的世界" />
      </div>

      <div class="field">
        <label>题材</label>
        <input v-model="genre" placeholder="如：玄幻 / 悬疑 / 言情（驱动账本推荐）" />
      </div>

      <div class="field">
        <label>类型</label>
        <div class="seg">
          <button type="button" :class="{ active: kind === 'long' }" @click="kind = 'long'">长篇</button>
          <button type="button" :class="{ active: kind === 'short' }" @click="kind = 'short'">短篇集</button>
        </div>
      </div>

      <div v-if="kind === 'long'" class="field">
        <label>扩展账本类 <span class="tip">留空则按题材自动推荐</span></label>
        <div class="leads">
          <label v-for="l in EXTENDED_LEADS" :key="l" class="lead">
            <input type="checkbox" :checked="leads.includes(l)" @change="toggleLead(l)" /> {{ l }}
          </label>
        </div>
      </div>

      <div class="field">
        <label>AI 宿主</label>
        <div class="host">
          <span class="host-active">Claude Code (cc)</span>
          <span class="host-disabled" title="首版暂不支持（决策 22）">Codex（暂未支持）</span>
        </div>
      </div>

      <p v-if="error" class="error">{{ error }}</p>

      <div class="actions">
        <button type="submit" class="btn-primary" :disabled="!canSubmit">
          {{ submitting ? '创建中…' : '创建' }}
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.book-new {
  max-width: 640px;
  margin: 0 auto;
}
.head {
  margin-bottom: 16px;
}
.btn-back {
  padding: 6px 14px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  font-size: 14px;
}
.btn-back:hover {
  border-color: #3b82f6;
}
h2 {
  margin: 12px 0 20px;
  font-size: 16px;
}
.form {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 24px;
  display: grid;
  gap: 18px;
}
.field {
  display: grid;
  gap: 6px;
}
.field > label {
  font-size: 13px;
  color: #374151;
}
.req {
  color: #dc2626;
}
.tip {
  color: #9ca3af;
  font-weight: normal;
}
.field input:not([type='checkbox']) {
  padding: 8px 10px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 14px;
}
.field input:focus {
  outline: none;
  border-color: #3b82f6;
}
.seg {
  display: inline-flex;
  gap: 8px;
}
.seg button {
  padding: 6px 16px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
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
.host {
  display: flex;
  gap: 16px;
  font-size: 14px;
}
.host-active {
  color: #3b82f6;
  font-weight: 600;
}
.host-disabled {
  color: #d1d5db;
}
.error {
  color: #dc2626;
  font-size: 13px;
  margin: 0;
}
.actions {
  display: flex;
  justify-content: flex-end;
}
.btn-primary {
  padding: 8px 24px;
  border: none;
  border-radius: 6px;
  background: #3b82f6;
  color: #fff;
  cursor: pointer;
  font-size: 14px;
}
.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
