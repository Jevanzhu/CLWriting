<script setup lang="ts">
import { ref, watch } from 'vue'
import { useTreeStore } from '../../stores/tree'
import { listTrash, restoreTrash, purgeTrash, type TrashEntry } from '../../api/documents'

// 回收站面板（细案 T1.7）：列表 + 恢复 / 永久删（二次确认）。恢复后刷新树。
const props = defineProps<{ bookName: string }>()
const tree = useTreeStore()

const entries = ref<TrashEntry[]>([])
const err = ref<string | null>(null)

async function load(): Promise<void> {
  if (!props.bookName) {
    entries.value = []
    return
  }
  err.value = null
  try {
    entries.value = await listTrash(props.bookName)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}
async function restore(id: string): Promise<void> {
  try {
    await restoreTrash(props.bookName, id)
    await Promise.all([load(), tree.load(props.bookName)])
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}
async function purge(id: string): Promise<void> {
  if (!confirm('永久删除不可恢复，确认？')) return
  try {
    await purgeTrash(props.bookName, id)
    await load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}

function basename(path: string): string {
  const seg = path.split('/').pop() ?? path
  return seg.replace(/\.md$/, '')
}

watch(() => props.bookName, () => load(), { immediate: true })
</script>

<template>
  <div class="trash-panel">
    <div class="side-title">回收站</div>
    <div v-if="err" class="hint err">{{ err }}</div>
    <div v-else-if="!entries.length" class="hint">回收站为空</div>
    <div v-else class="entries">
      <div v-for="e in entries" :key="e.id" class="entry">
        <span class="entry-name">{{ basename(e.originalPath ?? e.path) }}</span>
        <div class="entry-actions">
          <button class="btn" @click="restore(e.id)">恢复</button>
          <button class="btn danger" @click="purge(e.id)">永久删</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.trash-panel {
  padding: var(--size-4-2) 0;
}
.side-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0 var(--size-4-3) var(--size-4-2);
}
.hint {
  padding: 8px var(--size-4-3);
  font-size: 12px;
  color: var(--text-faint);
}
.hint.err {
  color: var(--text-error);
}
.entries {
  padding: 0 var(--size-4-2);
}
.entry {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  padding: var(--size-4-1) var(--size-4-2);
  border-radius: var(--radius-s);
}
.entry:hover {
  background: var(--background-modifier-hover);
}
.entry-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.entry-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.btn {
  font-size: 11px;
  padding: 2px 8px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-muted);
  cursor: pointer;
}
.btn:hover {
  background: var(--background-modifier-hover);
}
.btn.danger {
  color: var(--text-error);
}
</style>
