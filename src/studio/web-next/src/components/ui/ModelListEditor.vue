<script setup lang="ts">
/**
 * 模型行编辑器（阶段 14 P9 §7.1，对齐 DSH 四字段 + ModelListEditor 探测交互）。
 * 每行：id（必填/唯一）+ name（可选）；行内展开 contextWindow/maxTokens（K/M 后缀，空 = 不声明）。
 * 「获取模型列表」按 dsh 语义探测端点——用表单当前值（含未保存的 Key，新增卡一趟完成），
 * 编辑卡 Key 留空则回退已存 id 凭据；成功即弹勾选窗（未配置的预勾、已配置的不勾），
 * 采纳按 id 去重追加（用户调过的行原样保留）；失败就地报错不打断手填。
 * 校验交给父层（validateModels 纯函数 + abort)；本组件可被 v-model 双向草稿。
 */
import { ref, computed } from 'vue'
import { Plus, Trash2, ChevronRight, RefreshCw, Loader2, X, Check } from 'lucide-vue-next'
import type { Protocol } from '../../api/providers'
import { fetchModels } from '../../api/providers'
import {
  parseCapacity,
  formatCapacity,
  type ModelRowDraft,
} from '../../shared/provider-format'

const props = withDefaults(defineProps<{
  /** 外部模型行草稿（受控：父层保存前也读这里） */
  modelValue: ModelRowDraft[]
  /** 探测目标（dsh ProbeTarget）：表单现值优先（含未保存 Key）；编辑卡可回退已存 id */
  probe: { id?: string; protocol: Protocol; baseUrl: string; apiKey: string }
  /** 是否禁用（如保存中） */
  disabled?: boolean
}>(), { disabled: false })

const emit = defineEmits<{
  'update:modelValue': [rows: ModelRowDraft[]]
}>()

// 本地行副本（v-model 由父层传初值；内部变更同步 emit）
// _key 为本地稳定行标识（ii-4）：行可增删，v-for 用索引 key 会在删中间行时让行内
// 输入态/展开态与数据错位——key 只活在组件内，sync 时剥除（不进 v-model 契约）。
type LocalRow = ModelRowDraft & { _key: number }
let keySeq = 0
const rows = ref<LocalRow[]>(props.modelValue.map((r) => ({ ...r, _key: ++keySeq })))

function sync(): void {
  emit('update:modelValue', rows.value.map(({ _key, ...rest }) => rest))
}

function addRow(): void {
  rows.value.push({ id: '', name: '', contextWindowText: '', maxTokensText: '', _key: ++keySeq })
  sync()
}

function removeRow(i: number): void {
  rows.value.splice(i, 1)
  sync()
}

/** 展开态（dsh：默认全折叠——id/名称就在行内可编，容量是例外才折叠；按 _key 记录，删行天然不错位） */
const expanded = ref<Set<number>>(new Set())
function toggleRow(key: number): void {
  const n = new Set(expanded.value)
  if (n.has(key)) n.delete(key)
  else n.add(key)
  expanded.value = n
}

function rowChanged(i: number, patch: Partial<ModelRowDraft>): void {
  rows.value[i] = { ...rows.value[i]!, ...patch }
  sync()
}

// ── 探测（dsh：ModelListEditor 自持 fetch，成功即弹勾选窗） ──
/** 实际探测体：表单现值（含未保存 Key）优先——新增卡一趟完成；无 Key 的编辑卡回退已存 id */
const probeBody = computed<Parameters<typeof fetchModels>[0] | null>(() => {
  const p = props.probe
  if (p.baseUrl && p.apiKey) return { protocol: p.protocol, baseUrl: p.baseUrl, apiKey: p.apiKey }
  if (p.id) return { id: p.id }
  return null
})
/** 不可探测时的按钮提示（dsh probeBlocked：理由就地说，不发注定失败的请求） */
const fetchHint = computed(() => {
  if (probeBody.value) return undefined
  return props.probe.baseUrl
    ? '填写 API Key 后可获取（编辑已有卡也可留空，用已存 Key）'
    : '填写 API 地址后可获取'
})

const busy = ref(false)
const failure = ref<string>()

async function fetchList(): Promise<void> {
  const body = probeBody.value
  if (!body || busy.value || props.disabled) return
  busy.value = true
  failure.value = undefined
  try {
    const r = await fetchModels(body)
    if (r.models.length === 0) {
      failure.value = '端点未返回任何模型'
      return
    }
    // dsh：已配置行不预勾——采纳永不改写用户调过的容量
    const known = new Set(rows.value.map((x) => x.id.trim()))
    candidates.value = r.models
    picked.value = new Set(r.models.filter((m) => !known.has(m)))
    showPicker.value = true
  } catch (e) {
    failure.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

// ── 候选弹窗 ──
const showPicker = ref(false)
const picked = ref<Set<string>>(new Set())
const candidates = ref<string[]>()

function togglePick(id: string): void {
  const n = new Set(picked.value)
  if (n.has(id)) n.delete(id)
  else n.add(id)
  picked.value = n
}

function closePicker(): void {
  showPicker.value = false
  picked.value = new Set()
}

function adoptPicked(): void {
  const existing = new Set(rows.value.map((r) => r.id.trim()))
  for (const id of picked.value) {
    if (id && !existing.has(id)) {
      rows.value.push({ id, name: '', contextWindowText: '', maxTokensText: '', _key: ++keySeq })
      existing.add(id)
    }
  }
  sync()
  closePicker()
}
</script>

<template>
  <div class="models-editor">
    <div class="models-header">
      <span class="models-title">模型行（可选——声明后覆盖该模型的容量）</span>
      <div class="models-actions">
        <button
          class="chip-btn"
          :disabled="disabled || busy || !probeBody"
          :data-tip="fetchHint"
          @click="fetchList"
        >
          <Loader2 v-if="busy" :size="13" class="spin" />
          <RefreshCw v-else :size="13" />
          {{ busy ? '获取中…' : '获取模型列表' }}
        </button>
      </div>
    </div>
    <p v-if="failure" class="key-error models-error">{{ failure }}</p>

    <div v-if="rows.length === 0" class="models-empty">
      尚未配置模型行。可手动添加，或点「获取模型列表」后从清单勾选。
    </div>

    <div v-for="(r, i) in rows" :key="r._key" class="model-entry">
      <div class="model-row">
        <input
          :value="r.id"
          type="text"
          placeholder="模型 id，如 gpt-5"
          aria-label="模型 id"
          class="compact-input row-input-id"
          :disabled="disabled"
          @input="rowChanged(i, { id: ($event.target as HTMLInputElement).value })"
        />
        <input
          :value="r.name"
          type="text"
          placeholder="显示名（可选）"
          aria-label="显示名"
          class="compact-input"
          :disabled="disabled"
          @input="rowChanged(i, { name: ($event.target as HTMLInputElement).value })"
        />
        <button
          class="row-icon-btn"
          :class="{ open: expanded.has(r._key) }"
          :aria-expanded="expanded.has(r._key)"
          data-tip="容量（上下文 / 输出上限）"
          :disabled="disabled"
          @click="toggleRow(r._key)"
        >
          <ChevronRight :size="14" />
        </button>
        <button class="row-icon-btn danger" :disabled="disabled" data-tip="删除此模型行" @click="removeRow(i)">
          <Trash2 :size="13" />
        </button>
      </div>
      <div v-if="expanded.has(r._key)" class="model-advanced">
        <div class="model-field">
          <label>上下文窗口</label>
          <input
            :value="r.contextWindowText"
            type="text"
            placeholder="256K"
            class="compact-input"
            :disabled="disabled"
            @input="rowChanged(i, { contextWindowText: ($event.target as HTMLInputElement).value })"
          />
          <span class="field-hint">空 = 默认 256K；支持 K/M</span>
        </div>
        <div class="model-field">
          <label>最大输出 token</label>
          <input
            :value="r.maxTokensText"
            type="text"
            placeholder="128K"
            class="compact-input"
            :disabled="disabled"
            @input="rowChanged(i, { maxTokensText: ($event.target as HTMLInputElement).value })"
          />
          <span class="field-hint">空 = 默认 128K；支持 K/M</span>
        </div>
      </div>
    </div>

    <button class="add-row-btn" :disabled="disabled" @click="addRow">
      <Plus :size="13" /> 添加模型行
    </button>

    <!-- 候选弹窗：从已拉取清单勾选 -->
    <Teleport to="body">
      <div v-if="showPicker" class="picker-mask" @click.self="closePicker">
        <div class="picker-pop">
          <div class="picker-head">
            <span>从模型清单选择</span>
            <button class="close-btn" @click="closePicker"><X :size="15" /></button>
          </div>
          <div class="picker-list">
            <label v-for="c in candidates ?? []" :key="c" class="picker-item">
              <input type="checkbox" :checked="picked.has(c)" @change="togglePick(c)" />
              <span>{{ c }}</span>
            </label>
          </div>
          <div class="picker-actions">
            <button class="cancel-btn" @click="closePicker">取消</button>
            <button class="save-btn" :disabled="picked.size === 0" @click="adoptPicked">
              <Check :size="14" /> 添加 {{ picked.size }} 个
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.models-editor {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
  padding: var(--size-4-2) 0 var(--size-4-1);
  border-top: 1px solid var(--background-modifier-border);
  margin-top: var(--size-4-2);
}
.models-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}
.models-title {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-muted);
}
.models-actions {
  display: flex;
  gap: 6px;
}
.chip-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  font-size: var(--font-size-xs);
  font-weight: 500;
  border: 1px solid var(--background-modifier-border);
  border-radius: 99px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.chip-btn:hover:not(:disabled) {
  color: var(--text-normal);
  border-color: var(--interactive-accent);
}
.chip-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.models-empty {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  padding: 4px 0;
}
/* 探测失败行（.key-error 主样式在 providers.css；此处只补间距） */
.models-error {
  margin: 0;
  padding: 0;
}
/* ── 模型行（dsh modelEntry/modelRow）：平铺输入行 + 展开容量 ── */
.model-entry {
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  padding: 6px;
}
.model-row {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 6px;
}
.row-input-id {
  font-family: var(--font-monospace);
}
/* 行内幽灵图标钮（与行卡 .mini-btn 同语言）：无标签方格，含义由输入框自带 */
.row-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  /* dsh iconButton 6px */
  border-radius: 6px;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), transform 120ms ease;
}
.row-icon-btn:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.row-icon-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.row-icon-btn.danger:hover:not(:disabled) {
  color: var(--dv-bad);
  background: color-mix(in srgb, var(--dv-bad) 10%, transparent);
}
/* 展开指示：右向箭头旋转 90° 朝下（dsh IconChevron） */
.row-icon-btn.open {
  transform: rotate(90deg);
  color: var(--text-muted);
}
.model-advanced {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px;
  padding: 8px 4px 2px;
}
.model-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.model-field label {
  font-size: var(--font-size-xxs);
  font-weight: 600;
  color: var(--text-muted);
}
.model-field label em {
  font-style: normal;
  color: var(--dv-bad);
  font-weight: 500;
}
/* 紧凑输入（行内展开体）：独立类名避免与共享 .text-input 的优先级 tie */
.compact-input {
  width: 100%;
  padding: 6px 10px;
  font-size: var(--font-size-s);
  color: var(--text-normal);
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.compact-input:focus {
  outline: none;
  border-color: var(--interactive-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive-accent) 16%, transparent);
}
.field-hint {
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
}
.add-row-btn {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 12px;
  font-size: var(--font-size-xs);
  font-weight: 500;
  border: 1px dashed var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.add-row-btn:hover:not(:disabled) {
  color: var(--text-normal);
  border-color: var(--interactive-accent);
}
/* ── 候选弹窗 ── */
.picker-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: clw-overlay var(--dur-fast) var(--ease-out);
}
.picker-pop {
  width: min(420px, 90vw);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  /* dsh Modal 的 24px 大圆角 */
  border-radius: var(--radius-xl);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.18);
  animation: clw-appear var(--dur-norm) var(--ease-out);
}
.picker-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--size-4-2) var(--size-4-3);
  font-weight: 600;
  font-size: var(--font-size-s);
  border-bottom: 1px solid var(--background-modifier-border);
}
.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.close-btn:hover {
  background: var(--background-modifier-hover);
}
.picker-list {
  flex: 1;
  overflow: auto;
  padding: var(--size-4-2);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.picker-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-m);
  cursor: pointer;
  font-size: var(--font-size-s);
  font-family: var(--font-monospace);
}
.picker-item input {
  accent-color: var(--interactive-accent);
}
.picker-item:hover {
  background: var(--background-modifier-hover);
}
.picker-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: var(--size-4-2) var(--size-4-3);
  border-top: 1px solid var(--background-modifier-border);
}
.cancel-btn {
  padding: 6px 14px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.save-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 14px;
  border: none;
  border-radius: var(--radius-m);
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  font-weight: 600;
  cursor: pointer;
}
.save-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.spin {
  animation: models-editor-spin 0.8s linear infinite;
}
@keyframes models-editor-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>