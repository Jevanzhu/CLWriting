<script setup lang="ts">
// 写作信息面板：实时字数 / 目标进度 / 6 态 / 保存态。
// 无外层卡片（由 SidebarRight .info-stack 统一卡片容器包裹）。
import { ref, computed, watch } from 'vue'
import { useDocStore } from '../../stores/doc'
import { useWorkspaceStore } from '../../stores/workspace'
import { useTreeStore } from '../../stores/tree'
import { usePrefsStore } from '../../stores/prefs'
import { getConfig, type BookConfig } from '../../api/books'
import { countWords, stripFrontmatter, parseFmFields } from '../../shared/words'
import type { TreeNode } from '../../types/tree'
import { friendlyError } from '../../shared/error'

const props = defineProps<{ bookName: string }>()
const doc = useDocStore()
const ws = useWorkspaceStore()
const tree = useTreeStore()
// 每章字数的全局默认托底（书级未设时生效；ref 初值 0=未设，服务端合并同链）
const prefs = usePrefsStore()

const entry = computed(() => (ws.activeDocId ? doc.get(ws.activeDocId) : undefined))
const node = computed(() => (ws.activeDocId ? tree.byDocId.get(ws.activeDocId) : undefined))

const config = ref<BookConfig>({})
const err = ref<string | null>(null)
// M-11：代守卫（reqGen 同款）——本面板常驻右侧栏（不随切书重建），快速切书 A→B 时
// A 的慢响应不把 A 的字数目标/口径落到 B 的进度显示
let configGen = 0
watch(
  () => props.bookName,
  async (n) => {
    const gen = ++configGen
    if (!n) return
    try {
      const c = await getConfig(n)
      if (gen !== configGen) return
      config.value = c
    } catch (e) {
      if (gen !== configGen) return
      err.value = friendlyError(e)
    }
  },
  { immediate: true },
)

const words = computed(() => (entry.value ? countWords(stripFrontmatter(entry.value.content)) : 0))
const volumeWords = computed(() => {
  if (!node.value) return 0
  const m = node.value.path.match(/^写作\/正文\/([^/]+)\//)
  if (!m) return 0
  const volPrefix = `写作/正文/${m[1]}/`
  let sum = 0
  const walk = (ns: TreeNode[]) => {
    for (const n of ns) {
      if (!n.isDirectory && (n.role === 'chapter' || n.role === 'piece-body') && n.path.startsWith(volPrefix)) sum += n.wordCount ?? 0
      if (n.children.length) walk(n.children)
    }
  }
  walk(tree.raw)
  return sum
})
// 章级目标优先级：fm「字数目标」> 书级每章字数（book.yaml chapter_target_words）> 全局默认（0=未设，三级同语义）
const chapterTarget = computed(() => {
  if (entry.value) {
    const v = parseFmFields(entry.value.content)['字数目标']
    if (v) return Number(v)
  }
  return config.value.book?.chapter_target_words ?? prefs.defaultChapterTargetWords
})
const chapterProgress = computed(() =>
  chapterTarget.value ? Math.min(100, Math.round((words.value / chapterTarget.value) * 100)) : 0,
)

const STATUS_LABEL: Record<string, string> = {
  idea: '构想', draft: '草稿', revision: '修订',
  final: '定稿', published: '已发布', archived: '已归档',
}
const saveLabel = computed(() => {
  const e = entry.value
  if (!e) return '—'
  if (e.saving) return '保存中…'
  if (e.error) return e.error
  if (e.dirty) return '未保存'
  return e.savedAt ? '已保存' : '—'
})
</script>

<template>
  <div class="info-panel">
    <template v-if="ws.activeView === 'editor' && entry">
      <!-- 字数 + 进度（始终显示进度条；无目标时 0%） -->
      <div class="words-block">
        <div class="words-row">
          <span class="words-num">{{ words.toLocaleString() }}</span>
          <span v-if="chapterTarget" class="words-target">/ {{ chapterTarget.toLocaleString() }}</span>
          <span v-if="chapterTarget" class="words-pct">{{ chapterProgress }}%</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: chapterProgress + '%' }"></div>
        </div>
      </div>
      <!-- 元数据行 -->
      <div class="meta-grid">
        <div class="meta-cell">
          <span class="meta-label">状态</span>
          <span class="meta-val">{{ STATUS_LABEL[node?.status ?? ''] ?? '—' }}</span>
        </div>
        <div v-if="volumeWords" class="meta-cell">
          <span class="meta-label">本卷</span>
          <span class="meta-val">{{ volumeWords.toLocaleString() }}</span>
        </div>
        <div class="meta-cell">
          <span class="meta-label">保存</span>
          <span class="meta-val" :class="{ dirty: entry.dirty, err: !!entry.error }">{{ saveLabel }}</span>
        </div>
      </div>
    </template>
    <div v-else class="side-hint">
      {{ entry ? '切到编辑视图查看本章信息' : '未打开文档——左侧选章开始写作' }}
    </div>
    <div v-if="err" class="side-hint err">{{ err }}</div>
  </div>
</template>

<style scoped>
.info-panel {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
}
.side-hint {
  font-size: var(--font-size-s);
  color: var(--text-faint);
}
.side-hint.err {
  color: var(--text-error);
}
/* 字数 + 进度 */
.words-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.words-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.words-num {
  font-size: 22px;
  font-weight: 700;
  color: var(--text-normal);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.words-target {
  font-size: var(--font-size-s);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.words-pct {
  margin-left: auto;
  font-size: var(--font-size-s);
  color: var(--text-accent);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.progress-bar {
  height: 5px;
  background: var(--background-modifier-border);
  border-radius: 3px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: var(--interactive-accent);
  border-radius: 3px;
  transition: width var(--dur-norm) var(--ease-out);
}
/* 元数据网格 */
.meta-grid {
  display: flex;
  gap: var(--size-4-4);
}
.meta-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.meta-label {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.meta-val {
  font-size: var(--font-size-s);
  color: var(--text-normal);
  font-variant-numeric: tabular-nums;
}
.meta-val.dirty {
  color: var(--text-warning);
}
.meta-val.err {
  color: var(--text-error);
}
</style>
