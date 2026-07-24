<script setup lang="ts">
// 文档编辑视图（细案 T1.2）：inline 标题（章名，只读）+ CM6 正文 + 保存态指示 + 30s 自动保存。
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useDocStore } from '../stores/doc'
import { useTreeStore } from '../stores/tree'
import CmHost from '../editor/CmHost.vue'

const props = defineProps<{ docId: string | null }>()
const doc = useDocStore()
const tree = useTreeStore()

const entry = computed(() => (props.docId ? doc.get(props.docId) : undefined))

// 持久化恢复缺口：刷新后 tabs 恢复但 doc Map 空 → 活动 tab 无 entry → 自动 open。
// 正常切 tab 不触发（entry 已在 Map，dirty 驻留不丢，决策 R6）。
watch(
  () => props.docId,
  async (id) => {
    if (id && !doc.get(id)) {
      const node = tree.byDocId.get(id)
      if (node) {
        try {
          await doc.open(node)
        } catch {
          /* 打开失败静默（tab 仍在，点别的即可） */
        }
      }
    }
  },
  { immediate: true },
)

// 30s 自动保存（origin='autosave'）：仅当前活动文档 dirty 时触发（细案 §7 数值）。
let timer: ReturnType<typeof setInterval> | null = null
function tick(): void {
  if (entry.value?.dirty && !entry.value.saving) {
    void doc.save(entry.value.docId, 'autosave')
  }
}
onMounted(() => {
  timer = setInterval(tick, 30_000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div v-if="!entry" class="editor-empty">选择左侧章节开始写作</div>
  <div v-else class="editor-view">
    <header class="doc-head">
      <input class="inline-title" :value="entry.name" readonly placeholder="未命名" />
      <span
        class="save-state"
        :class="{ dirty: entry.dirty, saving: entry.saving, err: !!entry.error }"
      >
        {{
          entry.saving
            ? '保存中…'
            : entry.error
              ? entry.error
              : entry.dirty
                ? '未保存（⌘S）'
                : entry.savedAt
                  ? '已保存'
                  : ''
        }}
      </span>
      <!-- 乐观锁冲突出路：重载（丢本地）/ 覆盖（丢远端），二选一解除冲突态 -->
      <template v-if="entry.conflict">
        <button class="conflict-btn" @click="doc.reloadFromRemote(entry.docId)">重载远端</button>
        <button class="conflict-btn danger" @click="doc.overwriteRemote(entry.docId)">
          覆盖远端
        </button>
      </template>
    </header>
    <div class="doc-body">
      <CmHost
        :model-value="entry.content"
        :mode="entry.mode"
        @update:model-value="doc.patch(entry.docId, $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.editor-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  font-size: 14px;
}
.editor-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.doc-head {
  flex-shrink: 0;
  display: flex;
  align-items: baseline;
  gap: var(--size-4-3);
  padding: var(--size-4-4) var(--size-4-6) var(--size-4-2);
  border-bottom: 1px solid var(--background-modifier-border);
}
.inline-title {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 22px;
  font-weight: 700;
  color: var(--text-normal);
  font-family: var(--font-ui);
}
.save-state {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-faint);
}
.save-state.dirty {
  color: var(--text-warning);
}
.save-state.saving {
  color: var(--text-muted);
}
.save-state.err {
  color: var(--text-error);
}
.conflict-btn {
  flex-shrink: 0;
  font-size: 12px;
  padding: 1px 8px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-secondary);
  color: var(--text-muted);
  cursor: pointer;
}
.conflict-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.conflict-btn.danger:hover {
  color: var(--text-error);
}
.doc-body {
  flex: 1;
  min-height: 0;
  padding: var(--size-4-4) var(--size-4-6);
  overflow: hidden;
}
</style>
