<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BookTabs from '../components/BookTabs.vue'

interface Overview {
  identity: {
    name: string
    kind: 'long' | 'short'
    path: string
    created_at?: string
    title: string
    genre: string
    host: string
  }
  progress: { chapters: number; words: number }
  state: { state: number; name: string; detail: unknown }
  volumes: { name: string; path: string }[]
}

const route = useRoute()
const router = useRouter()
const name = computed(() => (typeof route.params.name === 'string' ? route.params.name : ''))
const data = ref<Overview | null>(null)
const loading = ref(true)
const error = ref('')

async function load(n: string): Promise<void> {
  loading.value = true
  error.value = ''
  data.value = null
  try {
    const r = await fetch(`/api/books/${encodeURIComponent(n)}/overview`)
    if (!r.ok) {
      const e = (await r.json().catch(() => ({}))) as { error?: string }
      throw new Error(e.error ?? `HTTP ${r.status}`)
    }
    data.value = (await r.json()) as Overview
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

watch(
  () => route.params.name,
  (n) => {
    if (typeof n === 'string') load(n)
  },
  { immediate: true },
)

function fmtDate(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN')
}

function hostLabel(host: string): string {
  return host === 'codex' ? 'Codex' : 'Claude Code (cc)'
}

/** 字数 → 万字（保留 1 位） */
function fmtWords(n: number): string {
  if (n <= 0) return '0'
  if (n < 10000) return `${n}`
  return `${(n / 10000).toFixed(1)} 万`
}

/** 状态机细节 → 人话提示（按态取关键字段） */
function stateHint(s: Overview['state']): string {
  const d = (s.detail ?? {}) as Record<string, unknown>
  switch (s.state) {
    case 7: {
      const next = d['nextChapter']
      return typeof next === 'number' ? `下一步起草第 ${next} 章` : '准备起草新章'
    }
    case 8:
      return '有章节待批量审稿'
    case 5:
      return '当前卷已写完,待开新卷'
    case 6:
      return '体检周期到期,建议先体检'
    case 4:
      return '工作区有未完成的内容'
    case 3: {
      const h = d['handEdits']
      return Array.isArray(h) ? `有 ${h.length} 处手改未入账(建议 finalize)` : '有手改未入账'
    }
    case 2:
      return '源文件解析有错,需修复'
    case 1: {
      const issues = d['issues']
      return Array.isArray(issues) && issues.length
        ? `git 健康检查发现 ${issues.length} 个问题`
        : 'git 仓库需要检查'
    }
    default:
      return ''
  }
}

/** 是否可继续写作(态 7 起草;态 5/8 也算可推进) */
function canWrite(s: Overview['state']): boolean {
  return s.state === 7 || s.state === 5 || s.state === 8
}

/** 继续写作 → 临时跳编辑 tab(工作台 AI 起草在 Step 2 上线) */
function onWrite(): void {
  router.push(`/books/${encodeURIComponent(name.value)}/edit`)
}
</script>

<template>
  <section class="book-detail">
    <BookTabs :name="name" active="overview" />
    <div class="detail-head">
      <button class="btn-back" @click="router.push('/')">← 返回书架</button>
    </div>

    <p v-if="loading" class="hint">加载中…</p>
    <p v-else-if="error" class="hint error">加载失败:{{ error }}</p>
    <template v-else-if="data">
      <!-- 身份卡 -->
      <article class="card identity-card">
        <h2 class="title">{{ data.identity.title }}</h2>
        <dl class="meta">
          <div><dt>题材</dt><dd>{{ data.identity.genre || '—' }}</dd></div>
          <div><dt>类型</dt><dd>{{ data.identity.kind === 'short' ? '短篇集' : '长篇' }}</dd></div>
          <div><dt>宿主</dt><dd>{{ hostLabel(data.identity.host) }}</dd></div>
          <div><dt>创建于</dt><dd>{{ fmtDate(data.identity.created_at) }}</dd></div>
          <div><dt>目录</dt><dd class="mono">{{ data.identity.path }}</dd></div>
        </dl>
      </article>

      <!-- 进度 + 状态机双栏 -->
      <div class="row">
        <!-- 进度卡 -->
        <article class="card progress-card">
          <h3 class="card-title">进度</h3>
          <div class="progress-figure">
            <span class="num">{{ data.progress.chapters }}</span>
            <span class="unit">{{ data.identity.kind === 'short' ? '篇' : '章' }}</span>
          </div>
          <p class="progress-words">已写 {{ fmtWords(data.progress.words) }} 字</p>
        </article>

        <!-- 状态机卡 -->
        <article class="card state-card">
          <h3 class="card-title">写作位置</h3>
          <div class="state-name" :class="`s${data.state.state}`">{{ data.state.name }}</div>
          <p class="state-hint">{{ stateHint(data.state) || '状态就绪' }}</p>
          <div class="write-entry">
            <button
              :class="['btn-write', { 'is-disabled': !canWrite(data.state) }]"
              :disabled="!canWrite(data.state)"
              @click="onWrite"
            >
              {{ canWrite(data.state) ? '继续写作 →' : '工作台 Step 2 上线' }}
            </button>
          </div>
        </article>
      </div>

      <!-- 卷结构(长篇) -->
      <article v-if="data.identity.kind === 'long'" class="card volumes-card">
        <h3 class="card-title">卷结构</h3>
        <ul v-if="data.volumes.length" class="vol-list">
          <li v-for="v in data.volumes" :key="v.path">{{ v.name }}</li>
        </ul>
        <p v-else class="hint">暂无卷纲(在「编辑」中维护 大纲/卷纲/*.md)</p>
      </article>
    </template>
  </section>
</template>

<style scoped>
.book-detail {
  max-width: 960px;
  margin: 0 auto;
}
.detail-head {
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

.card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 20px 24px;
}
.card + .card,
.card + .row,
.row + .card {
  margin-top: 16px;
}

.identity-card .title {
  margin: 0 0 18px;
  font-size: 20px;
}
.meta {
  margin: 0;
  display: grid;
  gap: 10px;
}
.meta > div {
  display: grid;
  grid-template-columns: 80px 1fr;
  align-items: baseline;
}
.meta dt {
  color: #6b7280;
  font-size: 13px;
}
.meta dd {
  margin: 0;
}
.meta .mono {
  font-family: ui-monospace, monospace;
  font-size: 13px;
  color: #4b5563;
}

.row {
  display: grid;
  grid-template-columns: 1fr 1.2fr;
  gap: 16px;
}

.card-title {
  margin: 0 0 14px;
  font-size: 13px;
  font-weight: 600;
  color: #6b7280;
  letter-spacing: 0.04em;
}

.progress-figure {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.progress-figure .num {
  font-size: 40px;
  font-weight: 700;
  line-height: 1;
  color: #111827;
}
.progress-figure .unit {
  font-size: 16px;
  color: #6b7280;
}
.progress-words {
  margin: 10px 0 0;
  color: #4b5563;
  font-size: 14px;
}

.state-name {
  font-size: 22px;
  font-weight: 700;
  color: #111827;
}
.state-name.s0 {
  color: #dc2626;
}
.state-hint {
  margin: 8px 0 16px;
  color: #4b5563;
  font-size: 14px;
  min-height: 20px;
}
.write-entry {
  margin-top: auto;
}
.btn-write {
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  background: #3b82f6;
  color: #fff;
  font-size: 14px;
  cursor: pointer;
}
.btn-write:disabled,
.btn-write.is-disabled {
  background: #d1d5db;
  color: #9ca3af;
  cursor: not-allowed;
}

.vol-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 8px;
}
.vol-list li {
  padding: 8px 12px;
  background: #f9fafb;
  border-radius: 6px;
  font-size: 14px;
}

.hint {
  color: #6b7280;
}
.hint.error {
  color: #dc2626;
}
</style>
