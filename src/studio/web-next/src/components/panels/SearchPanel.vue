<script setup lang="ts">
import { ref } from 'vue'
import { useTreeStore } from '../../stores/tree'
import { useDocStore } from '../../stores/doc'
import { useWorkspaceStore } from '../../stores/workspace'
import { search, type SearchHit } from '../../api/search'

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

const SCOPES = ['all', '定稿', '正文', '设定', '大纲', '工作区']

async function run(): Promise<void> {
  if (!q.value.trim()) {
    results.value = []
    truncated.value = false
    return
  }
  loading.value = true
  err.value = null
  try {
    const r = await search(props.bookName, q.value, scope.value)
    results.value = r.results
    truncated.value = !!r.truncated
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function open(path: string): Promise<void> {
  const node = tree.byPath.get(path)
  if (!node?.docId) return // 非树内可编辑文件忽略
  try {
    await doc.open(node)
    ws.openTab(node.docId)
  } catch {
    /* 打开失败静默 */
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
        <option v-for="s in SCOPES" :key="s" :value="s">{{ s }}</option>
      </select>
    </div>
    <div v-if="loading" class="hint">搜索中…</div>
    <div v-else-if="err" class="hint err">{{ err }}</div>
    <template v-else>
      <div v-if="truncated" class="hint">结果已截断，请缩小范围</div>
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
  font-size: 11px;
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
  font-size: 12px;
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
  font-size: 12px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
}
.hint {
  padding: 8px var(--size-4-3);
  font-size: 12px;
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
  font-size: 12px;
  color: var(--text-normal);
  margin-bottom: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.result-line {
  font-size: 11px;
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
