<script setup lang="ts">
// 文风条目库卡（StyleView 拆分 P2-5 ② 条目库段）：筛选 + 新增表单 + 条目卡片网格 + 批量收割入口。
import { computed, ref } from 'vue'
import { LibraryBig, GraduationCap, Plus, X, Check, Trash2 } from 'lucide-vue-next'
import { useStyleStore } from '../../stores/style'
import { useUiStore } from '../../stores/ui'
import { useWorkspaceStore } from '../../stores/workspace'
import { friendlyError } from '../../shared/error'
import EmptyState from '../ui/EmptyState.vue'
import type { EntryKindFE } from '../../api/style'

const style = useStyleStore()
const ui = useUiStore()
const ws = useWorkspaceStore()

const ENTRY_KINDS: EntryKindFE[] = ['样章', '手法', '反例', '禁词']

const kindFilter = ref<EntryKindFE | 'all'>('all')
const sceneFilter = ref<string>('all')
const sourceFilter = ref<string>('all')

const scenes = computed(() => [...new Set(style.entries.map((e) => e.场景))])
const sources = computed(() => [...new Set(style.entries.map((e) => e.来源))])
const filteredEntries = computed(() =>
  style.entries.filter(
    (e) =>
      (kindFilter.value === 'all' || e.类型 === kindFilter.value) &&
      (sceneFilter.value === 'all' || e.场景 === sceneFilter.value) &&
      (sourceFilter.value === 'all' || e.来源 === sourceFilter.value),
  ),
)

// 新增表单（源4 作者手动直达入库）
const adding = ref(false)
const draft = ref<{ 类型: EntryKindFE; 场景: string; 说明: string; 正文: string }>({
  类型: '手法',
  场景: '',
  说明: '',
  正文: '',
})
async function submitAdd(): Promise<void> {
  if (!draft.value.正文.trim()) {
    ui.toast('正文不能为空', 'error')
    return
  }
  try {
    await style.add({
      类型: draft.value.类型,
      正文: draft.value.正文.trim(),
      ...(draft.value.场景.trim() ? { 场景: draft.value.场景.trim() } : {}),
      ...(draft.value.说明.trim() ? { 说明: draft.value.说明.trim() } : {}),
    })
    ui.toast('已存入条目库', 'success')
    adding.value = false
    draft.value = { 类型: '手法', 场景: '', 说明: '', 正文: '' }
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  }
}
async function onRemove(path: string, text: string): Promise<void> {
  // FE-3（第七轮）：书名入口捕获（M-8 类收敛）——store.remove 在调用时刻取书名，
  // 弹窗滞留切书后旧书条目路径会发到新书（条目路径两书可同名），或 clear() 后空书名裸抛
  const book = style.bookName
  const ok = await ui.ask({
    title: '删除条目',
    message: `删除「${text.slice(0, 24)}${text.length > 24 ? '…' : ''}」？此操作不可撤销。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  if (style.bookName !== book) return
  try {
    await style.remove(path)
    ui.toast('已删除', 'success')
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  }
}
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <LibraryBig :size="14" /> <span>条目库</span>
      <span class="head-note">{{ style.entries.length }}条 · 供AI参考的文风知识</span>
      <span v-if="style.entryErrors > 0" class="head-warn">{{ style.entryErrors }}个文件损坏</span>
      <div class="head-actions">
        <button
          class="btn-ghost"
          data-tip="批量收割：扫定稿正文挑样章/金句"
          data-tip-dir="bottom"
          @click="ws.setActiveView('learn')"
        >
          <GraduationCap :size="13" /> 批量收割
        </button>
        <button class="btn-primary" @click="adding = !adding">
          <Plus :size="13" /> 新增
        </button>
      </div>
    </div>

    <div v-if="adding" class="add-form">
      <div class="af-row">
        <select v-model="draft.类型" class="af-select">
          <option v-for="k in ENTRY_KINDS" :key="k" :value="k">{{ k }}</option>
        </select>
        <input v-model="draft.场景" class="af-input" placeholder="场景（留空=通用）" />
        <input v-model="draft.说明" class="af-input af-grow" placeholder="说明（可选，样章的技法指令/禁词的替换方向）" />
      </div>
      <textarea
        v-model="draft.正文"
        class="af-textarea"
        rows="3"
        :placeholder="draft.类型 === '禁词' ? '要禁用的词或短语' : '条目正文'"
      ></textarea>
      <div class="af-actions">
        <button class="btn-ghost" @click="adding = false"><X :size="13" /> 取消</button>
        <button class="btn-primary" @click="submitAdd"><Check :size="13" /> 存入条目库</button>
      </div>
    </div>

    <div v-if="style.entries.length > 0" class="filters">
      <div class="f-group">
        <button class="f-chip" :class="{ on: kindFilter === 'all' }" @click="kindFilter = 'all'">全部</button>
        <button
          v-for="k in ENTRY_KINDS"
          :key="k"
          class="f-chip"
          :class="{ on: kindFilter === k }"
          @click="kindFilter = kindFilter === k ? 'all' : k"
        >
          {{ k }} {{ style.kindCounts[k] }}
        </button>
      </div>
      <div v-if="scenes.length > 1" class="f-group">
        <button class="f-chip" :class="{ on: sceneFilter === 'all' }" @click="sceneFilter = 'all'">全部场景</button>
        <button
          v-for="s in scenes"
          :key="s"
          class="f-chip"
          :class="{ on: sceneFilter === s }"
          @click="sceneFilter = sceneFilter === s ? 'all' : s"
        >
          {{ s }}
        </button>
      </div>
      <div v-if="sources.length > 1" class="f-group">
        <button class="f-chip" :class="{ on: sourceFilter === 'all' }" @click="sourceFilter = 'all'">全部来源</button>
        <button
          v-for="s in sources"
          :key="s"
          class="f-chip"
          :class="{ on: sourceFilter === s }"
          @click="sourceFilter = sourceFilter === s ? 'all' : s"
        >
          {{ s }}
        </button>
      </div>
    </div>

    <div v-if="filteredEntries.length > 0" class="entry-grid">
      <div v-for="e in filteredEntries" :key="e._path" class="entry-card">
        <div class="ec-top">
          <span class="kind-badge" :data-kind="e.类型">{{ e.类型 }}</span>
          <span class="ec-scene">{{ e.场景 }}</span>
          <button class="ec-del" data-tip="删除" data-tip-dir="bottom" @click="onRemove(e._path, e.正文)">
            <Trash2 :size="13" />
          </button>
        </div>
        <div v-if="e.说明" class="ec-note">{{ e.说明 }}</div>
        <div class="ec-text">{{ e.正文 }}</div>
        <div class="ec-foot">
          <span class="src-dot">{{ e.来源 }}</span>
          <span v-if="e.出处" class="ec-origin">{{ e.出处 }}</span>
          <span v-if="e.标签?.length" class="ec-tags">{{ e.标签.join(' · ') }}</span>
        </div>
      </div>
    </div>
    <EmptyState
      v-else
      :icon="LibraryBig"
      :title="style.entries.length === 0 ? '条目库为空' : '无匹配条目'"
      :text="style.entries.length === 0 ? '确认候选、批量收割或手动新增，都会存入这里' : '换个筛选条件试试'"
    />
  </section>
</template>

<style scoped>
/* ══ 面板基础（对齐 OverviewView 卡片语言）══ */
.panel {
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  padding: 18px 20px;
  animation: clw-fade-up var(--dur-fast) var(--ease-out) both;
}

.head-warn {
  font-size: var(--font-size-xs);
  font-weight: 400;
  color: var(--text-warning);
}
.head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ══ 通用按钮 ══ */
.btn-ghost,
.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
  padding: 4px 10px;
  border-radius: var(--radius-s);
  cursor: pointer;
  border: 1px solid var(--background-modifier-border);
  background: transparent;
  color: var(--text-muted);
  white-space: nowrap;
}
.btn-ghost:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.btn-primary {
  border-color: transparent;
  background: var(--interactive-accent);
  color: var(--text-on-accent);
}
.btn-primary:hover:not(:disabled) {
  background: var(--interactive-accent-hover);
}

/* ══ ② 条目库 ══ */
.add-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  margin-bottom: 14px;
  border: 1px dashed var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: var(--background-secondary);
}
.af-row {
  display: flex;
  gap: 8px;
}
.af-select,
.af-input,
.af-textarea {
  font-size: var(--font-size-s);
  padding: 5px 9px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  outline: none;
}
.af-select:focus,
.af-input:focus,
.af-textarea:focus {
  border-color: var(--interactive-accent);
}
.af-grow {
  flex: 1;
}
.af-textarea {
  resize: vertical;
  font-family: inherit;
  line-height: 1.7;
}
.af-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.filters {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}
.f-group {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.f-chip {
  font-size: var(--font-size-xs);
  padding: 2px 10px;
  border-radius: 99px;
  border: 1px solid var(--background-modifier-border);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.f-chip:hover {
  color: var(--text-normal);
  background: var(--background-modifier-hover);
}
.f-chip.on {
  color: var(--text-accent);
  border-color: var(--text-accent);
  background: color-mix(in srgb, var(--text-accent) 8%, transparent);
}

.entry-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
}
.entry-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: var(--background-secondary);
}
.ec-top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ec-scene {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.ec-del {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  padding: 2px;
  border-radius: var(--radius-s);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.entry-card:hover .ec-del {
  opacity: 1;
}
.ec-del:hover {
  color: var(--text-error);
  background: var(--background-modifier-hover);
}
.ec-note {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.ec-text {
  font-size: var(--font-size-s);
  color: var(--text-normal);
  line-height: 1.7;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.ec-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: auto;
}
.ec-origin,
.ec-tags {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}

/* 类型徽标（样章紫/手法绿/反例橙/禁词红） */
.kind-badge {
  font-size: var(--font-size-xxs);
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 99px;
  flex-shrink: 0;
}
.kind-badge[data-kind='样章'] {
  color: var(--text-accent);
  background: color-mix(in srgb, var(--text-accent) 12%, transparent);
}
.kind-badge[data-kind='手法'] {
  color: var(--dv-good);
  background: color-mix(in srgb, var(--dv-good) 12%, transparent);
}
.kind-badge[data-kind='反例'] {
  color: var(--dv-warn);
  background: color-mix(in srgb, var(--dv-warn) 12%, transparent);
}
.kind-badge[data-kind='禁词'] {
  color: var(--text-error);
  background: color-mix(in srgb, var(--text-error) 12%, transparent);
}
.src-dot {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.src-dot::before {
  content: '◦ ';
}

</style>
