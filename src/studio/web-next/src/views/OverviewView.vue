<script setup lang="ts">
// 总览视图（细案 T4.1）：GET /overview 渲染 身份/进度/状态机/卷纲/写作热力。
// 长短篇按 kind 分流；卷纲点击 → 章节树寻 docId 开 tab（与编辑 tab 并存）。
import { ref, computed, onMounted } from 'vue'
import { getOverview, type OverviewResult } from '../api/overview'
import { useUiStore } from '../stores/ui'
import { useTreeStore } from '../stores/tree'
import { useWorkspaceStore } from '../stores/workspace'

const props = defineProps<{ bookName: string }>()
const ui = useUiStore()
const tree = useTreeStore()
const ws = useWorkspaceStore()

const data = ref<OverviewResult | null>(null)
const loading = ref(true)
const err = ref<string | null>(null)

async function load(): Promise<void> {
  loading.value = true
  err.value = null
  try {
    data.value = await getOverview(props.bookName)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)

const kind = computed<'long' | 'short'>(() => data.value?.identity.kind ?? 'long')
// 热力色深归一：最大计数映射满色
const maxCount = computed(() => Math.max(1, ...(data.value?.timeline ?? []).map((t) => t.count)))

function openVolume(path: string): void {
  const node = tree.byPath.get(path)
  if (node?.docId) ws.openTab(node.docId)
  else ui.toast('未在章节树中找到该卷纲', 'error')
}
</script>

<template>
  <div class="overview-scroll">
    <div v-if="loading" class="placeholder">载入总览…</div>
    <div v-else-if="err" class="err-block">
      总览载入失败：{{ err }}
      <button class="btn" @click="load">重试</button>
    </div>

    <div v-else-if="data" class="overview">
      <!-- 身份 -->
      <section class="card">
        <h1 class="book-title">{{ data.identity.title || data.identity.name }}</h1>
        <div class="meta-grid">
          <div><label>书名</label><span>{{ data.identity.name }}</span></div>
          <div><label>类型</label><span>{{ kind === 'long' ? '长篇' : '短篇' }}</span></div>
          <div><label>流派</label><span>{{ data.identity.genre || '—' }}</span></div>
          <div><label>宿主</label><span>{{ data.identity.host }}</span></div>
          <div v-if="data.identity.created_at">
            <label>创建</label><span>{{ data.identity.created_at.slice(0, 10) }}</span>
          </div>
        </div>
      </section>

      <!-- 进度 -->
      <section class="card">
        <div class="card-head">进度</div>
        <div class="progress-row">
          <span class="big">{{ data.progress.chapters }}</span>
          <span class="unit">{{ kind === 'long' ? '章' : '篇' }}</span>
          <span v-if="kind === 'long'" class="words">
            {{ data.progress.words.toLocaleString() }} 字
          </span>
        </div>
        <div v-if="data.progress.percent !== undefined" class="progress-bar">
          <div class="bar-track">
            <div class="bar-fill" :style="{ width: data.progress.percent + '%' }"></div>
          </div>
          <span class="bar-label">
            {{ data.progress.percent }}% · {{ data.progress.words.toLocaleString() }} /
            {{ data.progress.targetWords?.toLocaleString() }} 字
          </span>
        </div>
      </section>

      <!-- 状态机 -->
      <section class="card">
        <div class="card-head">状态机</div>
        <div class="state-row">
          <span class="state-badge">{{ data.state.state }}</span>
          <span class="state-name">{{ data.state.name }}</span>
        </div>
        <div v-if="data.state.detail.error" class="err-inline">{{ data.state.detail.error }}</div>
      </section>

      <!-- 卷纲（长篇） -->
      <section v-if="kind === 'long' && data.volumes.length" class="card">
        <div class="card-head">卷纲（{{ data.volumes.length }}）</div>
        <ul class="vol-list">
          <li v-for="v in data.volumes" :key="v.path">
            <button class="vol-btn" @click="openVolume(v.path)">{{ v.name }}</button>
          </li>
        </ul>
      </section>

      <!-- 写作热力 -->
      <section v-if="data.timeline.length" class="card">
        <div class="card-head">写作热力（{{ data.timeline.length }} 日有产出）</div>
        <div class="heat-strip">
          <span
            v-for="t in data.timeline"
            :key="t.date"
            class="heat-cell"
            :style="{ opacity: 0.2 + 0.8 * (t.count / maxCount) }"
            :title="`${t.date} · ${t.count} 章`"
          ></span>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.overview-scroll {
  height: 100%;
  overflow: auto;
  padding: var(--size-4-4) var(--size-4-6);
}
.overview {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
  max-width: 720px;
  margin: 0 auto;
}
.card {
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  padding: var(--size-4-3) var(--size-4-4);
}
.card-head {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: var(--size-4-2);
  letter-spacing: 0.04em;
}
.book-title {
  margin: 0 0 var(--size-4-3);
  font-size: 20px;
  font-weight: 600;
  color: var(--text-normal);
  line-height: 1.3;
}
.meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: var(--size-4-2) var(--size-4-4);
}
.meta-grid div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.meta-grid label {
  font-size: 11px;
  color: var(--text-faint);
}
.meta-grid span {
  font-size: 13px;
  color: var(--text-normal);
}
.progress-row {
  display: flex;
  align-items: baseline;
  gap: var(--size-4-2);
}
.big {
  font-size: 28px;
  font-weight: 600;
  color: var(--text-accent);
  line-height: 1;
}
.unit {
  font-size: 13px;
  color: var(--text-muted);
}
.words {
  font-size: 13px;
  color: var(--text-muted);
  margin-left: var(--size-4-2);
}
.progress-bar {
  margin-top: var(--size-4-3);
}
.bar-track {
  height: 6px;
  background: var(--background-modifier-border);
  border-radius: var(--radius-s);
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  background: var(--interactive-accent);
  border-radius: var(--radius-s);
  transition: width 0.3s;
}
.bar-label {
  display: block;
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-faint);
}
.state-row {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
}
.state-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-on-accent);
  background: var(--interactive-accent);
  border-radius: var(--radius-s);
}
.state-name {
  font-size: 14px;
  color: var(--text-normal);
}
.err-inline {
  margin-top: var(--size-4-2);
  font-size: 12px;
  color: var(--text-error);
}
.vol-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.vol-btn {
  width: 100%;
  text-align: left;
  padding: 6px var(--size-4-2);
  font-size: 13px;
  border: none;
  background: transparent;
  color: var(--text-normal);
  border-radius: var(--radius-s);
  cursor: pointer;
}
.vol-btn:hover {
  background: var(--background-modifier-hover);
}
.heat-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}
.heat-cell {
  width: 12px;
  height: 12px;
  border-radius: 2px;
  background: var(--interactive-accent);
}
.placeholder {
  padding: var(--size-4-6);
  text-align: center;
  color: var(--text-faint);
  font-size: 13px;
}
.err-block {
  padding: var(--size-4-4);
  text-align: center;
  color: var(--text-error);
  font-size: 13px;
}
.btn {
  margin-left: var(--size-4-2);
  padding: 4px 12px;
  font-size: 12px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  cursor: pointer;
}
</style>
