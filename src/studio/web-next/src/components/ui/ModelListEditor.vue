<script setup lang="ts">
/**
 * 模型行编辑器（阶段 14 P9 §7.1，对齐 DSH 四字段 + ModelListEditor 探测交互）。
 * 每行：id（必填/唯一）+ name（可选）；行内展开 contextWindow/maxTokens（K/M 后缀，空 = 不声明）。
 * 「获取模型列表」按 dsh 语义探测端点——用表单当前值（含未保存的 Key，新增卡一趟完成），
 * 编辑卡 Key 留空则回退已存 id 凭据；成功即弹勾选窗（未配置的预勾、已配置的不勾），
 * 采纳按 id 去重追加（用户调过的行原样保留）；失败就地报错不打断手填。
 * 校验交给父层（validateModels 纯函数 + abort)；本组件可被 v-model 双向草稿。
 *
 * hh §八-16 拆分：行卡片 → ModelRow.vue，候选弹窗 → ModelPicker.vue（纯搬家，
 * DOM 结构不变）；本件留行状态/探测/采纳编排。
 */
import { ref, computed, watch } from 'vue'
import { Plus, RefreshCw, Loader2 } from 'lucide-vue-next'
import type { Protocol } from '../../api/providers'
import { fetchModels } from '../../api/providers'
import {
  type ModelRowDraft,
} from '../../shared/provider-format'
import ModelRow from './ModelRow.vue'
import ModelPicker from './ModelPicker.vue'

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

// R37-34（三十七轮批E）：外部 modelValue 变更（如恢复默认/父层整体重置草稿）须重建行
// 列表——原只在 setup 取初值，外部改 props 后行列表纹丝不动。与「最近一次 emit 的值」
// 逐行比较（lastEmitted 缓存）：自身 emit 经 v-model 回流的同值不重建，防行内编辑态
// （展开/输入焦点）被无谓的重建打断
let lastEmitted: ModelRowDraft[] | null = null
function sameRows(a: ModelRowDraft[], b: ModelRowDraft[]): boolean {
  return (
    a.length === b.length &&
    a.every((r, i) => {
      const o = b[i]!
      return (
        r.id === o.id &&
        r.name === o.name &&
        r.contextWindowText === o.contextWindowText &&
        r.maxTokensText === o.maxTokensText
      )
    })
  )
}
watch(
  () => props.modelValue,
  (v) => {
    if (lastEmitted && sameRows(v, lastEmitted)) return // 自身 emit 的回流：不重建
    rows.value = v.map((r) => ({ ...r, _key: ++keySeq }))
  },
)

function sync(): void {
  const out = rows.value.map(({ _key, ...rest }) => rest)
  lastEmitted = out
  emit('update:modelValue', out)
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

// ── 候选弹窗（勾选集在此，采纳去重后并入行） ──
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

    <ModelRow
      v-for="(r, i) in rows"
      :key="r._key"
      :row="r"
      :expanded="expanded.has(r._key)"
      :disabled="disabled"
      @change="(patch) => rowChanged(i, patch)"
      @toggle="toggleRow(r._key)"
      @remove="removeRow(i)"
    />

    <button class="add-row-btn" :disabled="disabled" @click="addRow">
      <Plus :size="13" /> 添加模型行
    </button>

    <ModelPicker
      :show="showPicker"
      :candidates="candidates ?? []"
      :picked="picked"
      @toggle="togglePick"
      @close="closePicker"
      @adopt="adoptPicked"
    />
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
.spin {
  animation: clw-spin 0.8s linear infinite;
}

</style>
