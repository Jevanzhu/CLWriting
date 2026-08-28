<script setup lang="ts">
import { ref, watch } from 'vue'
import { Trash2, RotateCcw, AlertCircle } from 'lucide-vue-next'
import { useTreeStore } from '../../stores/tree'
import { useUiStore } from '../../stores/ui'
import { listTrash, restoreTrash, purgeTrash, type TrashEntry } from '../../api/documents'
import { ApiError } from '../../api/client'
import { friendlyError } from '../../shared/error'

// 回收站面板：严格仿章节树叶子行样式（dot-slot + label + hover 操作按钮）。
const props = defineProps<{ bookName: string }>()
const tree = useTreeStore()
const ui = useUiStore()

const entries = ref<TrashEntry[]>([])
const err = ref<string | null>(null)

// M-10：回收站加载代守卫（words store reqGen 同款）——快速切书 A→B 时 A 的慢响应
// 不覆盖 B 的回收站列表（restore/purge 后的 load 同享守卫）
let loadGen = 0
async function load(): Promise<void> {
  const gen = ++loadGen
  if (!props.bookName) {
    entries.value = []
    return
  }
  err.value = null
  try {
    const list = await listTrash(props.bookName)
    if (gen !== loadGen) return
    entries.value = list
  } catch (e) {
    if (gen !== loadGen) return
    err.value = friendlyError(e)
  }
}
// R71-32（七十一轮）：恢复在途锁（acting 同款）——restore 此前无防重，双击第二笔
// 必 404（条目已被第一笔恢复），旧口径 catch 置 err 会把「实际已恢复成功」的整个
// 列表换成错误态；锁挡第二笔，迟到的 404 也按已恢复静默处理
const restoring = ref<string | null>(null)
async function restore(id: string): Promise<void> {
  if (restoring.value) return // 在途锁：双击第二笔直接忽略
  restoring.value = id
  try {
    await restoreTrash(props.bookName, id)
    await Promise.all([load(), tree.load(props.bookName)])
  } catch (e) {
    // 404/NOT_FOUND：条目已恢复（双击竞态）或已不在回收站——静默，load 刷新即对齐
    if (e instanceof ApiError && (e.status === 404 || e.code === 'NOT_FOUND')) return
    // R71-32：恢复失败收敛为 toast——列表数据本身无恙，不再整体覆盖成错误态
    ui.toast(friendlyError(e), 'error')
  } finally {
    restoring.value = null
  }
}
async function purge(id: string): Promise<void> {
  // FE-2（第七轮）：书名入口捕获（M-8 类收敛）——永久删除不可恢复，请求不能发到
  // 确认弹窗滞留期间切换后的书
  const book = props.bookName
  const ok = await ui.ask({
    title: '永久删除',
    message: '永久删除不可恢复，确认？',
    confirmText: '永久删除',
    danger: true,
  })
  if (!ok) return
  if (props.bookName !== book) return
  try {
    await purgeTrash(book, id)
    if (props.bookName === book) await load()
  } catch (e) {
    err.value = friendlyError(e)
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
