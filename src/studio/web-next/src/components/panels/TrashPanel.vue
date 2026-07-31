<script setup lang="ts">
import { ref, watch } from 'vue'
import { Trash2, RotateCcw, AlertCircle } from 'lucide-vue-next'
import { useTreeStore } from '../../stores/tree'
import { useUiStore } from '../../stores/ui'
import { listTrash, restoreTrash, purgeTrash, type TrashEntry } from '../../api/documents'

// 回收站面板：严格仿章节树叶子行样式（dot-slot + label + hover 操作按钮）。
const props = defineProps<{ bookName: string }>()
const tree = useTreeStore()
const ui = useUiStore()

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
  const ok = await ui.ask({
    title: '永久删除',
    message: '永久删除不可恢复，确认？',
    confirmText: '永久删除',
    danger: true,
  })
  if (!ok) return
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
    <!-- 空状态 -->
    <div v-if="err" class="empty-state err">
      <AlertCircle :size="20" />
      <span>{{ err }}</span>
    </div>
    <div v-else-if="!entries.length" class="empty-state">
      <Trash2 :size="20" />
      <span>回收站为空</span>
    </div>
    <!-- 列表（严格仿章节树叶子行：dot-slot + label 27px 行高） -->
    <div v-else class="tree-list">
      <div v-for="e in entries" :key="e.id" class="tree-item" :title="e.originalPath ?? e.path">
        <span class="dot-slot">
          <span class="dot dot-gray"></span>
        </span>
        <span class="label">{{ basename(e.originalPath ?? e.path) }}</span>
        <div class="item-actions">
          <button class="action-btn" data-tip="恢复" data-tip-dir="right" @click="restore(e.id)">
            <RotateCcw :size="13" />
          </button>
          <button class="action-btn danger" data-tip="永久删除" data-tip-dir="right" @click="purge(e.id)">
            <Trash2 :size="13" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.trash-panel {
  padding: var(--size-4-1) 0;
  min-height: 100%;
}
/* 空状态 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--size-4-2);
  padding: var(--size-4-6) var(--size-4-2);
  color: var(--text-faint);
  font-size: var(--font-size-s);
  text-align: center;
}
.empty-state.err {
  color: var(--text-error);
}
.tree-list {
  padding: 0 var(--size-4-1);
}
/* ── 严格仿 ChapterTreeItem 叶子行 ── */
.tree-item {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 27px;
  padding-left: 22px;
  padding-right: 8px;
  font-size: var(--font-size-m);
  color: var(--text-normal);
  cursor: default;
  border-radius: var(--radius-s);
  user-select: none;
  transition: background var(--dur-fast) var(--ease-out);
}
.tree-item:hover {
  background: var(--background-modifier-hover);
}
.dot-slot {
  width: 14px;
  display: flex;
  justify-content: center;
  flex-shrink: 0;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.dot-gray {
  background: var(--text-faint);
}
.label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 操作按钮：默认隐藏，hover 行时显形（仿 HistoryPanel restore-btn） */
.item-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.tree-item:hover .item-actions {
  opacity: 1;
}
.action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.action-btn:hover {
  color: var(--text-accent);
  background: var(--background-modifier-hover);
}
.action-btn.danger:hover {
  color: var(--text-error);
}
</style>
