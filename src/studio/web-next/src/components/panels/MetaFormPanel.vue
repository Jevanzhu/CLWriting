<script setup lang="ts">
// 结构化元数据表单（块3.1）：按当前文档 path 切字段集（章纲/卷纲/总纲），
// 解析 fm 填值 → 编辑 → 保存落 fm（op=fm，不联动文件名）+ 静默刷新 doc content。
import { ref, computed, watch } from 'vue'
import { useDocStore } from '../../stores/doc'
import { useWorkspaceStore } from '../../stores/workspace'
import { useUiStore } from '../../stores/ui'
import { parseFmFields, formKindOf, stripFrontmatter, mergeFm } from '../../shared/words'
import { updateDocMeta } from '../../api/documents'

type FieldDef = {
  key: string
  label: string
  type: 'select' | 'text' | 'number' | 'textarea'
  options?: string[]
  placeholder?: string
}

const TITLE: Record<string, string> = {
  chapter: '章节',
  'chapter-outline': '章纲',
  'volume-outline': '卷纲',
  synopsis: '总纲',
  character: '角色',
  worldview: '世界观',
  item: '物品',
}

const FIELD_DEFS: Record<string, FieldDef[]> = {
  // 章节（定稿/正文）：fm 元数据走右栏；标题/章号不在表单（标题走顶部 inline-title 联动 rename，章号建章定）
  chapter: [
    { key: '时间锚点', label: '时间锚点', type: 'text' },
    { key: '字数目标', label: '字数目标', type: 'number' },
  ],
  'chapter-outline': [
    { key: '钩子类型', label: '钩子类型', type: 'select', options: ['', '危机钩', '悬念钩', '渴望钩', '情绪钩', '选择钩'] },
    { key: '钩子强弱', label: '钩子强弱', type: 'select', options: ['', '强', '中', '弱'] },
    { key: '情绪定位', label: '情绪定位', type: 'select', options: ['', '压抑', '铺垫', '小爽', '大爽', '转折'] },
    { key: '场景', label: '场景', type: 'select', options: ['', '战斗', '对话', '抒情', '叙事铺陈', '爽点高潮'] },
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
}

const props = defineProps<{ bookName: string }>()
const doc = useDocStore()
const ws = useWorkspaceStore()
const ui = useUiStore()

const entry = computed(() => (ws.activeDocId ? doc.get(ws.activeDocId) : undefined))
const kind = computed(() => (entry.value ? formKindOf(entry.value.path) : null))
const defs = computed<FieldDef[]>(() => (kind.value ? (FIELD_DEFS[kind.value] ?? []) : []))

const fields = ref<Record<string, string>>({})
watch(
  entry,
  (e) => {
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

const saving = ref(false)
async function onSave(): Promise<void> {
  if (!entry.value || !ws.activeDocId || !kind.value) return
  saving.value = true
  try {
    const meta: Record<string, unknown> = {}
    for (const f of FIELD_DEFS[kind.value] ?? []) {
      const v = fields.value[f.key] ?? ''
      if (v === '') continue
      // 多行值由 stringifyFlat 用块标量 key: | 存储（fm 多行已根治）
      meta[f.key] = f.type === 'number' ? Number(v) : v
    }
    // 保护编辑区未保存的 body：记本地 body → 写 fm → refresh 拉磁盘 → 本地 body 拼回（不覆盖正文改动）
    const localBody = stripFrontmatter(entry.value.content)
    await updateDocMeta(props.bookName, ws.activeDocId, meta)
    await doc.refresh(ws.activeDocId)
    const refreshed = doc.get(ws.activeDocId)
    if (refreshed && stripFrontmatter(refreshed.content) !== localBody) {
      doc.patch(ws.activeDocId, mergeFm(refreshed.content, localBody))
    }
    ui.toast('已保存', 'success')
  } catch (err) {
    ui.toast(err instanceof Error ? err.message : String(err), 'error')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="meta-form-panel">
    <div v-if="!entry" class="side-hint">未打开文档</div>
    <template v-else>
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
          :placeholder="f.placeholder"
          class="field-input"
        />
      </div>
      <button class="save-btn" :disabled="saving" @click="onSave">
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </template>
  </div>
</template>

<style scoped>
.meta-form-panel {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
}
.side-title {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.side-hint {
  font-size: var(--font-size-s);
  color: var(--text-faint);
}
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
  background: var(--background-primary);
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
.save-btn {
  margin-top: var(--size-4-1);
  padding: 6px 16px;
  font-size: var(--font-size-s);
  border: none;
  border-radius: var(--radius-s);
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  cursor: pointer;
  align-self: flex-start;
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
