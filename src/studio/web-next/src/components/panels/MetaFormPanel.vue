<script setup lang="ts">
// 结构化元数据表单（块3.1）：按当前文档 path 切字段集（章纲/卷纲/总纲），
// 解析 fm 填值 → 编辑 → 保存落 fm（op=fm，不联动文件名）+ 静默刷新 doc content。
import { ref, computed, watch } from 'vue'
import { Tag } from 'lucide-vue-next'
import { useDocStore } from '../../stores/doc'
import { useWorkspaceStore } from '../../stores/workspace'
import { useUiStore } from '../../stores/ui'
import { usePrefsStore } from '../../stores/prefs'
import { parseFmFields, formKindOf } from '../../shared/words'
import { updateDocMeta } from '../../api/documents'
import { getConfig } from '../../api/books'
import { friendlyError } from '../../shared/error'

type FieldDef = {
  key: string
  label: string
  type: 'select' | 'text' | 'number' | 'textarea'
  options?: string[]
  placeholder?: string
}

const TITLE: Record<string, string> = {
  chapter: '章节',
  'piece-body': '短篇',
  'chapter-outline': '章纲',
  'volume-outline': '卷纲',
  synopsis: '总纲',
  character: '角色',
  worldview: '世界观',
  item: '物品',
  foreshadow: '伏笔',
}

const FIELD_DEFS: Record<string, FieldDef[]> = {
  // 章节（写作/正文）：fm 元数据走右栏；标题/章号不在表单（标题走顶部 inline-title 联动 rename，章号建章定）
  // 目标情绪/核心反转 为通用可选字段（ChapterMeta 统一后长短篇均可用，短篇写稿必填）
  chapter: [
    { key: '目标情绪', label: '目标情绪', type: 'text', placeholder: '本章要落地的核心情绪' },
    { key: '核心反转', label: '核心反转', type: 'textarea', placeholder: '单章反转点（有反转的章填）' },
    { key: '字数目标', label: '字数目标', type: 'number' },
  ],
  'piece-body': [
    // 目标情绪/核心反转（短篇目标函数）+ 钩子/情绪/场景（连续故事可选，对齐 chapter-outline）
    { key: '目标情绪', label: '目标情绪', type: 'text' },
    { key: '核心反转', label: '核心反转', type: 'text' },
    { key: '钩子类型', label: '钩子类型', type: 'select', options: ['', '危机钩', '悬念钩', '渴望钩', '情绪钩', '选择钩'] },
    { key: '钩子强弱', label: '钩子强弱', type: 'select', options: ['', '强', '中', '弱'] },
    { key: '情绪定位', label: '情绪定位', type: 'select', options: ['', '压抑', '铺垫', '小爽', '大爽', '转折'] },
    { key: '场景', label: '场景', type: 'select', options: ['', '战斗', '对话', '抒情', '叙事铺陈', '爽点高潮'] },
    { key: '字数目标', label: '字数目标', type: 'number' },
  ],
  'chapter-outline': [
    { key: '钩子类型', label: '钩子类型', type: 'select', options: ['', '危机钩', '悬念钩', '渴望钩', '情绪钩', '选择钩'] },
    { key: '钩子强弱', label: '钩子强弱', type: 'select', options: ['', '强', '中', '弱'] },
    { key: '情绪定位', label: '情绪定位', type: 'select', options: ['', '压抑', '铺垫', '小爽', '大爽', '转折'] },
    { key: '场景', label: '场景', type: 'select', options: ['', '战斗', '对话', '抒情', '叙事铺陈', '爽点高潮'] },
    { key: '目标情绪', label: '目标情绪', type: 'text', placeholder: '本章要落地的核心情绪' },
    { key: '核心反转', label: '核心反转', type: 'textarea', placeholder: '单章反转点：铺垫→反转→收尾' },
    { key: '时间锚点', label: '时间锚点', type: 'text' },
    { key: '字数目标', label: '字数目标', type: 'number' },
  ],
  'volume-outline': [
    { key: '卷名', label: '卷名', type: 'text' },
    { key: '字数目标', label: '字数目标', type: 'number' },
    { key: '起止章号', label: '起止章号', type: 'text', placeholder: '如 1-30' },
    { key: '情绪基调', label: '情绪基调', type: 'select', options: ['', '压抑', '铺垫', '小爽', '大爽', '转折'] },
    { key: '卷主线', label: '卷主线', type: 'textarea' },
  ],
  synopsis: [
    { key: '题材', label: '题材', type: 'text' },
    { key: '字数目标', label: '字数目标', type: 'number' },
    { key: '主题', label: '主题', type: 'text' },
    { key: '基调', label: '基调', type: 'text' },
    { key: '核心冲突', label: '核心冲突', type: 'textarea' },
  ],
  character: [
    { key: '姓名', label: '姓名', type: 'text' },
    { key: '别称', label: '别称', type: 'text' },
    { key: '身份', label: '身份', type: 'text' },
    { key: '外貌', label: '外貌', type: 'textarea' },
    { key: '性格', label: '性格', type: 'textarea' },
    { key: '能力', label: '能力', type: 'textarea' },
    { key: '背景', label: '背景', type: 'textarea' },
    { key: '出场', label: '出场', type: 'text' },
    { key: '关系', label: '关系', type: 'textarea' },
  ],
  worldview: [
    { key: '世界名称', label: '世界名称', type: 'text' },
    { key: '时代', label: '时代', type: 'text' },
    { key: '地理', label: '地理', type: 'textarea' },
    { key: '力量体系', label: '力量体系', type: 'textarea' },
    { key: '核心规则', label: '核心规则', type: 'textarea' },
  ],
  item: [
    { key: '名称', label: '名称', type: 'text' },
    { key: '品级', label: '品级', type: 'text' },
    { key: '类型', label: '类型', type: 'text' },
    { key: '效果', label: '效果', type: 'textarea' },
    { key: '来源', label: '来源', type: 'text' },
    { key: '持有者', label: '持有者', type: 'text' },
    { key: '备注', label: '备注', type: 'textarea' },
  ],
  foreshadow: [
    { key: '标题', label: '标题', type: 'text' },
    { key: '状态', label: '状态', type: 'select', options: ['未回收', '已回收', '已废弃'] },
    { key: '重要性', label: '重要性', type: 'select', options: ['高', '中', '低'] },
    { key: '关联词', label: '关联词', type: 'text', placeholder: '逗号分隔，如：玉佩,祖父遗物' },
    { key: '埋设章号', label: '埋设章号', type: 'number' },
    { key: '回收章号', label: '回收章号', type: 'number' },
  ],
}

const props = defineProps<{ bookName: string }>()
const doc = useDocStore()
const ws = useWorkspaceStore()
const ui = useUiStore()
// 每章字数的全局默认托底（书级未设时生效；ref 初值 0=未设，服务端合并同链）
const prefs = usePrefsStore()

const entry = computed(() => (ws.activeDocId ? doc.get(ws.activeDocId) : undefined))
// 短篇正文（role=piece-body）与长篇正文 path 相同（写作/正文/），
// formKindOf 按 path 返回 'chapter'；短篇表单由 role 覆写为 'piece-body'。
const kind = computed(() => {
  if (!entry.value) return null
  if (entry.value.role === 'piece-body') return 'piece-body'
  return formKindOf(entry.value.path)
})
const defs = computed<FieldDef[]>(() => (kind.value ? (FIELD_DEFS[kind.value] ?? []) : []))

const fields = ref<Record<string, string>>({})

watch(
  // R65-52（E-4）：doc store 对 content 是原位变更（refresh/静默同步改 e.content、对象引用
  // 不换）——单 watch entry 引用时 AI 写回/refresh 后表单不重解析，停留在旧值。源加 content
  [entry, () => entry.value?.content],
  ([e]) => {
    if (!e || !kind.value) {
      fields.value = {}
      return
    }
    const parsed = parseFmFields(e.content)
    const out: Record<string, string> = {}
    for (const f of FIELD_DEFS[kind.value] ?? []) out[f.key] = parsed[f.key] ?? ''
    fields.value = out
  },
  { immediate: true },
)

// ── 正文标签（AI 判定 → fm，只读展示）──
// 长篇 chapter：钩子/情绪/场景（AI 判定只读）；短篇 piece-body 标签已移入 FIELD_DEFS 可编辑
const TAG_FIELDS_BY_KIND: Record<string, Array<{ key: string; label: string }>> = {
  chapter: [
    { key: '时间锚点', label: '时间锚点' },
    { key: '钩子类型', label: '钩子类型' },
    { key: '钩子强弱', label: '钩子强弱' },
    { key: '情绪定位', label: '情绪定位' },
    { key: '场景', label: '场景' },
  ],
}
const tagFields = computed(() => (kind.value ? TAG_FIELDS_BY_KIND[kind.value] ?? [] : []))
const tagValues = computed<Record<string, string>>(() => {
  if (!entry.value) return {}
  const parsed = parseFmFields(entry.value.content)
  const out: Record<string, string> = {}
  for (const f of tagFields.value) out[f.key] = parsed[f.key] ?? ''
  return out
})

// 每章字数目标（书级 chapter_target_words ?? 全局默认；0=未设）—— 字数目标字段的 placeholder
const globalChapterTarget = ref<number | undefined>(undefined)
// M-11：代守卫——快速切书 A→B 时 A 的 getConfig 慢响应不把 A 的字数目标落到 B 的 placeholder
let targetGen = 0
watch(
  () => props.bookName,
  async (n) => {
    const gen = ++targetGen
    if (!n) return
    try {
      const v = (await getConfig(n)).book?.chapter_target_words ?? prefs.defaultChapterTargetWords
      if (gen !== targetGen) return
      globalChapterTarget.value = v
    } catch {
      /* 用默认 */
    }
  },
  { immediate: true },
)

const saving = ref(false)
async function onSave(): Promise<void> {
  // 低级项（第六轮）：上下文入口捕获——保存期间（两个 await 窗口）activeDocId/书名可能
  // 已切走，await 后重读会 refresh 他 doc（refresh 内部按当前书名拼路径，旧 docId + 新书
  // 名 = 错文件）、「已保存」提示打在别的书上
  const book = props.bookName
  const docId = ws.activeDocId
  if (!entry.value || !docId || !kind.value) return
  saving.value = true
  try {
    const meta: Record<string, unknown> = {}
    for (const f of FIELD_DEFS[kind.value] ?? []) {
      const v = fields.value[f.key] ?? ''
      if (v === '') continue
      // 多行值由 stringifyFlat 用块标量 key: | 存储（fm 多行已根治）
      meta[f.key] = f.type === 'number' ? Number(v) : v
    }
    // CC-P2-15：refresh 自带本地正文保护（dirty 时只取服务端 fm、正文保留本地），
    // 此前在此手动 patch 回 body 的守卫已下沉到 doc store
    await updateDocMeta(book, docId, meta)
    if (ws.activeDocId === docId && props.bookName === book) await doc.refresh(docId)
    if (props.bookName === book) ui.toast('已保存', 'success')
  } catch (err) {
    ui.toast(friendlyError(err), 'error')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="meta-form-panel">
    <div v-if="!entry" class="side-hint">未打开文档</div>
    <div v-else class="info-card">
      <!-- 正文标签（只读展示；长篇 chapter 钩子/情绪/场景，短篇 piece-body 目标情绪/核心反转） -->
      <div v-if="tagFields.length" class="tag-block">
        <div class="card-title"><Tag :size="14" />{{ kind === 'piece-body' ? '短篇标签' : '章节标签' }}<span class="ai-tag">AI 判定</span></div>
        <div class="tag-grid" :class="{ 'single-col': tagFields.length <= 2 }">
          <div v-for="f in tagFields" :key="f.key" class="tag-cell">
            <span class="tag-cell-label">{{ f.label }}</span>
            <span v-if="tagValues[f.key]" class="tag-cell-val">{{ tagValues[f.key] }}</span>
            <span v-else class="tag-cell-empty">—</span>
          </div>
        </div>
      </div>
      <!-- 结构化字段（可编辑：章纲/卷纲/总纲/设定） -->
      <div v-for="f in defs" :key="f.key" class="field">
        <label class="field-label">{{ f.label }}</label>
        <select v-if="f.type === 'select'" v-model="fields[f.key]" class="field-input">
          <option v-for="opt in f.options" :key="opt" :value="opt">{{ opt || '（未选）' }}</option>
        </select>
        <textarea
          v-else-if="f.type === 'textarea'"
          v-model="fields[f.key]"
          class="field-input area"
          rows="3"
        />
        <input
          v-else
          v-model="fields[f.key]"
          :type="f.type"
          :placeholder="f.key === '字数目标' && globalChapterTarget ? globalChapterTarget.toLocaleString() : f.placeholder"
          class="field-input"
        />
      </div>
      <button class="save-btn" :disabled="saving" @click="onSave">
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.meta-form-panel {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
}
.side-hint {
  font-size: var(--font-size-s);
  color: var(--text-faint);
}
/* 通用卡片（无外层边框——由 SidebarRight .info-stack 统一卡片；border-top 分隔统计区与表单区） */
.info-card {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
  margin-top: var(--size-4-3);
  padding-top: var(--size-4-3);
  border-top: 1px solid var(--background-modifier-border);
}
.card-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-normal);
}
.ai-tag {
  font-size: var(--font-size-xs);
  font-weight: 400;
  color: var(--text-faint);
  margin-left: 2px;
}
/* 章节标签区（卡片内分块，border-bottom 分隔） */
.tag-block {
  padding-bottom: var(--size-4-3);
  border-bottom: 1px solid var(--background-modifier-border);
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
}
/* 表单字段 */
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field-label {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  font-weight: 500;
}
.field-input {
  padding: 5px 8px;
  font-size: var(--font-size-s);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-secondary);
  color: var(--text-normal);
  font-family: inherit;
  transition: border-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}
.field-input:focus {
  outline: none;
  border-color: var(--interactive-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive-accent) 18%, transparent);
}
.field-input.area {
  resize: vertical;
  min-height: 60px;
  line-height: 1.6;
}
select.field-input {
  cursor: pointer;
}
/* 章节标签网格 */
.tag-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--size-4-2) var(--size-4-3);
}
/* 短篇标签（≤2 项）单列展示 */
.tag-grid.single-col {
  grid-template-columns: 1fr;
}
.tag-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.tag-cell-label {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.tag-cell-val {
  font-size: var(--font-size-s);
  padding: 2px 10px;
  border-radius: var(--radius-s);
  color: var(--text-accent);
  background: color-mix(in srgb, var(--text-accent) 12%, transparent);
  align-self: flex-start;
}
.tag-cell-empty {
  font-size: var(--font-size-s);
  padding: 2px 10px;
  border-radius: var(--radius-s);
  color: var(--text-faint);
  background: var(--background-modifier-hover);
  align-self: flex-start;
}
/* 保存按钮 */
.save-btn {
  align-self: flex-end;
  padding: 5px 16px;
  font-size: var(--font-size-s);
  border: none;
  border-radius: var(--radius-s);
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.save-btn:hover:not(:disabled) {
  background: var(--interactive-accent-hover);
}
.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
