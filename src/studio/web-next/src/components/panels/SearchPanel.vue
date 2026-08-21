<script setup lang="ts">
import { ref } from 'vue'
import { useTreeStore } from '../../stores/tree'
import { useDocStore } from '../../stores/doc'
import { useWorkspaceStore } from '../../stores/workspace'
import { search, type SearchHit } from '../../api/search'
import { friendlyError } from '../../shared/error'

// 全书搜索面板（细案 T1.7）：q + scope 下拉 → 结果列表（path + 命中行）→ 点击开 tab。
const props = defineProps<{ bookName: string }>()
const tree = useTreeStore()
const doc = useDocStore()
const ws = useWorkspaceStore()

const q = ref('')
const scope = ref('all')
const results = ref<SearchHit[]>([])
const truncated = ref(false)
const loading = ref(false)
const err = ref<string | null>(null)

// scope 值传 API 不变（all/定稿/正文…）；label 全中文，避免作者看到英文「all」。
const SCOPES = [
  { v: 'all', label: '全部' },
  { v: '定稿', label: '定稿' },
  { v: '正文', label: '正文' },
  { v: '设定', label: '设定' },
  { v: '大纲', label: '大纲' },
  { v: '工作区', label: '工作区' },
]

let runGen = 0
async function run(): Promise<void> {
  // RB-FE-P2-6：连续搜索竞态——只渲染最后一次查询的结果，旧慢响应不覆盖新结果
  const gen = ++runGen
  if (!q.value.trim()) {
    results.value = []
    truncated.value = false
    return
  }
  loading.value = true
  err.value = null
  try {
    const r = await search(props.bookName, q.value, scope.value)
    if (gen !== runGen) return
    results.value = r.results
    truncated.value = !!r.truncated
  } catch (e) {
    if (gen !== runGen) return
    err.value = friendlyError(e)
  } finally {
    if (gen === runGen) loading.value = false
  }
}

async function open(path: string): Promise<void> {
  const node = tree.byPath.get(path)
  if (!node?.docId) return // 非树内可编辑文件忽略
  try {
    await doc.open(node)
    ws.openTab(node.docId)
  } catch (e) {
    // P5-前端（第七轮）：静默吞错收敛（对齐 ForeshadowPanel）——搜索结果点开失败
    // 原先零反馈，作者不知为何没反应
    err.value = friendlyError(e)
  }
}
</script>

<template>
  <div class="search-panel">
    <div class="side-title">搜索</div>
    <div class="search-input">
      <input
        v-model="q"
        placeholder="全书搜索…"
        @keyup.enter="run"
      />
      <select v-model="scope" @change="run">
        <option v-for="s in SCOPES" :key="s.v" :value="s.v">{{ s.label }}</option>
      </select>
    </div>
    <div v-if="loading" class="hint">搜索中…</div>
    <div v-else-if="err" class="hint err">{{ err }}</div>
    <template v-else>
      <div v-if="truncated" class="hint">结果过多，请缩小搜索范围</div>
      <div v-if="q && !results.length" class="hint">无匹配</div>
      <div class="results">
        <div v-for="hit in results" :key="hit.path" class="result" @click="open(hit.path)">
          <div class="result-path">{{ hit.path }}</div>
          <div
            v-for="(m, i) in hit.matches.slice(0, 3)"
            :key="i"
            class="result-line"
          >
            <span class="ln">{{ m.line }}</span>
            <span class="text">{{ m.text }}</span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.search-panel {
  padding: var(--size-4-2) 0;
  height: 100%;
  display: flex;
  flex-direction: column;
}
.side-title {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0 var(--size-4-3) var(--size-4-2);
}
.search-input {
  display: flex;
  gap: var(--size-4-1);
  padding: 0 var(--size-4-3) var(--size-4-2);
}
.search-input input {
  flex: 1;
  min-width: 0;
  height: 26px;
  font-size: var(--font-size-s);
  padding: 0 var(--size-4-2);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  outline: none;
}
.search-input input:focus {
  border-color: var(--interactive-accent);
}
.search-input select {
  height: 26px;
  font-size: var(--font-size-s);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
}
.hint {
  padding: 8px var(--size-4-3);
  font-size: var(--font-size-s);
  color: var(--text-faint);
}
.hint.err {
  color: var(--text-error);
}
.results {
  flex: 1;
  overflow: auto;
  padding: 0 var(--size-4-2);
}
.result {
  padding: var(--size-4-2) var(--size-4-2);
  border-radius: var(--radius-s);
  cursor: pointer;
}
.result:hover {
  background: var(--background-modifier-hover);
}
.result-path {
  font-size: var(--font-size-s);
  color: var(--text-normal);
  margin-bottom: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.result-line {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  display: flex;
  gap: var(--size-4-1);
  overflow: hidden;
}
.result-line .ln {
  color: var(--text-faint);
  flex-shrink: 0;
}
.result-line .text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
