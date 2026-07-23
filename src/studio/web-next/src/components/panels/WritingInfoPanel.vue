<script setup lang="ts">
// 写作信息面板（细案 T2.2）：实时字数（剥 frontmatter）/ 目标进度 / 6 态 / 保存态 / 回滚入口。
import { ref, computed, watch } from 'vue'
import { useDocStore } from '../../stores/doc'
import { useWorkspaceStore } from '../../stores/workspace'
import { useTreeStore } from '../../stores/tree'
import { getConfig, revert, type BookConfig } from '../../api/books'
import { countWords } from '../../shared/words'

const props = defineProps<{ bookName: string }>()
const doc = useDocStore()
const ws = useWorkspaceStore()
const tree = useTreeStore()

const entry = computed(() => (ws.activeDocId ? doc.get(ws.activeDocId) : undefined))
const node = computed(() => (ws.activeDocId ? tree.byDocId.get(ws.activeDocId) : undefined))

const config = ref<BookConfig>({})
const err = ref<string | null>(null)
watch(
  () => props.bookName,
  async (n) => {
    if (!n) return
    try {
      config.value = await getConfig(n)
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e)
    }
  },
  { immediate: true },
)

// 剥 frontmatter（--- ... ---）取正文 body，再计字数（与导出口径同函数）
function stripFm(c: string): string {
  const m = c.match(/^---\n[\s\S]*?\n---\n?/)
  return m ? c.slice(m[0].length) : c
}
const words = computed(() => (entry.value ? countWords(stripFm(entry.value.content)) : 0))
const target = computed(() => config.value.book?.target_words ?? 0)
const progress = computed(() =>
  target.value ? Math.min(100, Math.round((words.value / target.value) * 100)) : 0,
)

const STATUS_LABEL: Record<string, string> = {
  idea: '构想',
  draft: '草稿',
  revision: '修订',
  final: '定稿',
  published: '已发布',
  archived: '已归档',
}

async function onRevert(): Promise<void> {
  const input = window.prompt('回滚到第几章？（后续章节内容将丢弃，可从 git 备份 ref 找回）')
  if (!input) return
  const chapter = Number(input)
  if (!Number.isFinite(chapter) || chapter < 1) return
  if (!confirm(`确认回滚到第 ${chapter} 章？此操作不可撤销（内容进 git 备份）。`)) return
  try {
    await revert(props.bookName, chapter)
    await tree.load(props.bookName)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}
</script>

<template>
  <div class="info-panel">
    <div class="side-title">写作信息</div>
    <div v-if="!entry" class="side-hint">未打开文档</div>
    <template v-else>
      <div class="row">
        <span class="label">字数</span>
        <span class="value">{{ words.toLocaleString() }}</span>
      </div>
      <div v-if="target" class="progress-wrap">
        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: progress + '%' }"></div>
        </div>
        <span class="progress-text">{{ progress }}% / {{ target.toLocaleString() }}</span>
      </div>
      <div v-else class="row">
        <span class="label">目标</span>
        <span class="muted">未设</span>
      </div>
      <div class="row">
        <span class="label">状态</span>
        <span class="value">{{ STATUS_LABEL[node?.status ?? ''] ?? '—' }}</span>
      </div>
      <div class="row">
        <span class="label">保存</span>
        <span
          class="value"
          :class="{ dirty: entry.dirty, err: !!entry.error }"
        >
          {{
            entry.saving
              ? '保存中…'
              : entry.error
                ? entry.error
                : entry.dirty
                  ? '未保存'
                  : entry.savedAt
                    ? '已保存'
                    : '—'
          }}
        </span>
      </div>
    </template>
    <button class="revert-btn" @click="onRevert">回滚到第 N 章…</button>
    <div v-if="err" class="side-hint err">{{ err }}</div>
  </div>
</template>

<style scoped>
.info-panel {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
}
.side-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.side-hint {
  font-size: 12px;
  color: var(--text-faint);
}
.side-hint.err {
  color: var(--text-error);
}
.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
}
.label {
  color: var(--text-muted);
}
.value {
  color: var(--text-normal);
  font-variant-numeric: tabular-nums;
}
.value.dirty {
  color: var(--text-warning);
}
.value.err {
  color: var(--text-error);
}
.muted {
  color: var(--text-faint);
}
.progress-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.progress-bar {
  height: 4px;
  background: var(--background-modifier-border);
  border-radius: 2px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: var(--interactive-accent);
  transition: width 0.2s ease;
}
.progress-text {
  font-size: 11px;
  color: var(--text-faint);
}
.revert-btn {
  margin-top: var(--size-4-2);
  padding: 6px 10px;
  font-size: 12px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-muted);
  cursor: pointer;
  text-align: left;
}
.revert-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-error);
}
</style>
