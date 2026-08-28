<script setup lang="ts">
// AI 提供方新增/编辑表单（阶段 14 §七）。
// 主字段 = API Key（P6 前端校验）；「自定义设置」折叠 = 类型/名称/API 地址 + 模型行编辑器（P9）。
// 校验与 API 写入留在父层（AiServicePanel.save）；本组件 emit 草稿（含 modelDrafts 供父层 validateModels）。
// 表单骨架/输入/胶囊按钮用 providers.css 共享类；此处只留折叠器与协议分段。
import { ref, computed, reactive } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import type { ProviderConfDto, Protocol, AuthStrategy, ModelConfDto } from '../../api/providers'
import { updateProviderPricing } from '../../api/providers'
import { apiKeyFailure, dtoToModelDrafts, modelDraftToDto, type ModelRowDraft } from '../../shared/provider-format'
import ModelListEditor from './ModelListEditor.vue'

const props = defineProps<{
  /** 编辑目标（null = 新增）；挂载时快照初始化 */
  initial: ProviderConfDto | null
  /** 嵌入行卡（就地展开）时不重复「编辑提供方」标题——行头即上下文 */
  embedded?: boolean
  /** 当前选中的测试模型（空 = 后端回落全局当前模型） */
  probeModel?: string
  /** 父层保存在途（R73-62）：校验与 API 写入在父层（AiServicePanel.save），在途锁也在父层——
   *  在途时禁保存按钮 + 文案反馈，挡双击第二笔（新增卡双 POST 落两条同名记录） */
  saving?: boolean
}>()

const emit = defineEmits<{
  save: [form: { name: string; protocol: Protocol; auth: AuthStrategy; baseUrl: string; apiKey: string; models: ModelConfDto[]; modelDrafts: ModelRowDraft[] }]
  cancel: []
  /** 测试模型选择变更（父层写 store.probeModels） */
  'probe-model': [model: string]
}>()

// 与原实现同款初始化：新增给默认值；编辑回填 + 旧配置无 auth 按协议推断
const form = ref(
  props.initial
    ? {
        name: props.initial.name,
        protocol: props.initial.protocol,
        auth: (props.initial.auth ?? (props.initial.protocol === 'anthropic' ? 'anthropic' : 'bearer')) as AuthStrategy,
        baseUrl: props.initial.baseUrl,
        apiKey: '',
      }
    : { name: '', protocol: 'openai' as Protocol, auth: 'bearer' as AuthStrategy, baseUrl: '', apiKey: '' },
)

/** 模型行草稿（ModelListEditor 双向；挂载由 initial?.models 回填） */
const modelDrafts = ref<ModelRowDraft[]>(dtoToModelDrafts(props.initial?.models))

const detailsOpen = ref(false)

const keyError = computed(() => apiKeyFailure(form.value.apiKey))
/** 新增必填；编辑留空 = 保留原 key，此时不算错 */
const keyRequiredError = computed(() => {
  if (props.initial) return null
  return apiKeyFailure(form.value.apiKey)
})

/** 选协议类型——自动定认证策略（anthropic→anthropic 头，openai/openai-responses→bearer） */
function selectProtocol(p: Protocol): void {
  form.value.protocol = p
  form.value.auth = p === 'anthropic' ? 'anthropic' : 'bearer'
}

function onModelDrafts(v: ModelRowDraft[]): void {
  modelDrafts.value = v
}

/** 探测目标（dsh ProbeTarget）：表单现值优先——含未保存的 Key/地址，新增卡一趟完成；
 *  编辑卡 Key 留空时 ModelListEditor 回退 initial.id 用已存凭据。 */
const probe = computed(() => ({
  id: props.initial?.id,
  protocol: form.value.protocol,
  baseUrl: form.value.baseUrl.trim(),
  apiKey: form.value.apiKey.trim(),
}))

// ── 测试模型下拉（编辑卡）：选项 = 我们声明的模型行（不向端点拉清单）；
//    没声明模型行时只有「默认」一项（后端回落全局当前模型） ──
const testModelOptions = computed(() =>
  Array.from(new Set(modelDrafts.value.map((r) => r.id.trim()).filter(Boolean))),
)

function submit(): void {
  emit('save', {
    ...form.value,
    models: modelDraftToDto(modelDrafts.value),
    modelDrafts: modelDrafts.value.map((r) => ({ ...r })),
  })
}

// ── D2（批 5）价格表：自包含小节——独立端点独立保存（价格不影响连通性，
//    不与主表单保存/expectedRevision 耦合）；仅编辑卡显示 ──
const pricingForm = reactive({
  inputPerMTok: props.initial?.pricing?.inputPerMTok?.toString() ?? '',
  outputPerMTok: props.initial?.pricing?.outputPerMTok?.toString() ?? '',
  cacheReadPerMTok: props.initial?.pricing?.cacheReadPerMTok?.toString() ?? '',
  cacheWritePerMTok: props.initial?.pricing?.cacheWritePerMTok?.toString() ?? '',
  currency: props.initial?.pricing?.currency ?? 'USD',
})
const pricingState = ref<'idle' | 'saving' | 'saved' | 'error'>('idle')
const pricingError = ref('')

const pricingConfigured = computed(() => !!props.initial?.pricing)

async function savePricing(clear = false): Promise<void> {
  if (!props.initial) return
  pricingState.value = 'saving'
  pricingError.value = ''
  try {
    const num = (v: string): number | undefined => {
      const t = v.trim()
      if (!t) return undefined
      const n = Number(t)
      return Number.isFinite(n) && n >= 0 ? n : NaN
    }
    const pricing = clear
      ? null
      : {
          inputPerMTok: num(pricingForm.inputPerMTok),
          outputPerMTok: num(pricingForm.outputPerMTok),
          cacheReadPerMTok: num(pricingForm.cacheReadPerMTok),
          cacheWritePerMTok: num(pricingForm.cacheWritePerMTok),
          ...(pricingForm.currency.trim() ? { currency: pricingForm.currency.trim() } : {}),
        }
    if (pricing && Object.values(pricing).some((v) => Number.isNaN(v))) {
      pricingState.value = 'error'
      pricingError.value = '单价需为非负数字'
      return
    }
    if (pricing && ![pricing.inputPerMTok, pricing.outputPerMTok, pricing.cacheReadPerMTok, pricing.cacheWritePerMTok].some((v) => v !== undefined)) {
      pricingState.value = 'error'
      pricingError.value = '至少填一个单价（或点「清除价格」）'
      return
    }
    await updateProviderPricing(props.initial.id, pricing)
    pricingState.value = 'saved'
    if (clear) {
      pricingForm.inputPerMTok = ''
      pricingForm.outputPerMTok = ''
      pricingForm.cacheReadPerMTok = ''
      pricingForm.cacheWritePerMTok = ''
    }
  } catch (e) {
    pricingState.value = 'error'
    pricingError.value = e instanceof Error ? e.message : String(e)
  }
}
</script>

<template>
  <!-- 嵌入行卡时（embedded）不重复标题——行头即上下文；仅独立新增卡显示 -->
  <div v-if="!embedded" class="group-title">{{ initial ? '编辑提供方' : '新增提供方' }}</div>
  <div class="form">
    <!-- 测试模型（编辑卡专属）：行卡测试按钮用它；空 = 后端回落全局当前模型 -->
    <div v-if="initial" class="form-row">
      <label>测试模型</label>
      <select
        class="text-input select-input"
        :value="probeModel ?? ''"
        data-tip="测试连接用的模型"
        @change="emit('probe-model', ($event.target as HTMLSelectElement).value)"
      >
        <option value="">默认（用全局当前模型探测）</option>
        <option v-for="m in testModelOptions" :key="m" :value="m">{{ m }}</option>
      </select>
    </div>

    <!-- 主字段：API Key（P6 前端校验） -->
    <div class="form-row">
      <label>API Key</label>
      <input
        v-model="form.apiKey"
        type="password"
        :placeholder="initial ? '不改则保留原 Key' : '粘贴你的 API Key'"
        class="text-input"
      />
      <span v-if="keyError && !initial" class="key-error">{{ keyError }}</span>
      <span v-if="initial?.hasKey && !form.apiKey" class="key-stored">已存 Key（vault 加密，留空即保留）</span>
    </div>

    <!-- 折叠自定义设置（类型/名称/API 地址 + 模型行） -->
    <details class="adv-details" :open="form.protocol !== 'openai' || !!form.baseUrl || modelDrafts.length > 0">
      <summary class="adv-summary">
        <span>自定义设置</span>
        <span class="adv-caret"><ChevronDown :size="14" /></span>
      </summary>
      <div class="adv-body">
        <div class="form-row">
          <label>类型</label>
          <div class="protocol-toggle">
            <button class="protocol-btn" :class="{ on: form.protocol === 'openai' }" @click="selectProtocol('openai')">
              <span class="proto-brand">OpenAI</span><span class="proto-name">Chat Completions</span>
            </button>
            <button
              class="protocol-btn"
              :class="{ on: form.protocol === 'openai-responses' }"
              @click="selectProtocol('openai-responses')"
            >
              <span class="proto-brand">OpenAI</span><span class="proto-name">Responses</span>
            </button>
            <button class="protocol-btn" :class="{ on: form.protocol === 'anthropic' }" @click="selectProtocol('anthropic')">
              <span class="proto-brand">Anthropic</span><span class="proto-name">Messages</span>
            </button>
          </div>
        </div>
        <div class="form-row">
          <label>名称</label>
          <input v-model="form.name" type="text" placeholder="如「我的中转」" class="text-input" />
        </div>
        <div class="form-row">
          <label>API 地址</label>
          <input v-model="form.baseUrl" type="text" placeholder="https://..." class="text-input" />
        </div>

        <!-- 模型行编辑器（P9 §7.1；探测自持：表单现值 → 勾选弹窗） -->
        <ModelListEditor
          :model-value="modelDrafts"
          :probe="probe"
          @update:model-value="onModelDrafts"
        />

        <!-- D2（批 5）价格表：每百万 token 单价；配价后用量面板显示金额、预算可用 cost 口径 -->
        <div v-if="initial" class="pricing-block">
          <div class="pricing-title">
            价格表（每百万 token）
            <span v-if="pricingConfigured" class="pricing-on">已配置</span>
            <span v-else class="pricing-off">未配置（不显示金额）</span>
          </div>
          <div class="pricing-grid">
            <label>输入<input v-model="pricingForm.inputPerMTok" type="text" inputmode="decimal" placeholder="—" /></label>
            <label>输出<input v-model="pricingForm.outputPerMTok" type="text" inputmode="decimal" placeholder="—" /></label>
            <label>缓存读<input v-model="pricingForm.cacheReadPerMTok" type="text" inputmode="decimal" placeholder="—" /></label>
            <label>缓存写<input v-model="pricingForm.cacheWritePerMTok" type="text" inputmode="decimal" placeholder="—" /></label>
            <label>币种<input v-model="pricingForm.currency" type="text" placeholder="USD" /></label>
          </div>
          <div class="pricing-actions">
            <button class="save-btn" :disabled="pricingState === 'saving'" @click="savePricing(false)">
              {{ pricingState === 'saving' ? '保存中…' : '保存价格' }}
            </button>
            <button v-if="pricingConfigured" class="cancel-btn" :disabled="pricingState === 'saving'" @click="savePricing(true)">清除价格</button>
            <span v-if="pricingState === 'saved'" class="pricing-ok">已保存</span>
            <span v-else-if="pricingState === 'error'" class="key-error">{{ pricingError }}</span>
          </div>
        </div>
      </div>
    </details>

    <div class="form-actions">
      <button class="cancel-btn" @click="emit('cancel')">取消</button>
      <!-- R73-62：保存按钮在途禁用 + 文案反馈（同 :233 价格小节 saving 态口径） -->
      <button class="save-btn" :disabled="saving" @click="submit">{{ saving ? '保存中…' : '保存' }}</button>
    </div>
  </div>
</template>

<style scoped>
/* 表单骨架（.form/.form-row/.text-input/.key-error/胶囊按钮）用 providers.css 共享类。 */
/* 凭据状态点（I6·P3）：hasKey 来自服务端 vault 存在性推导，不依赖明文字段 */
.key-stored {
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
}
/* 下拉借用 .text-input 的盒子；原生箭头丑且贴边 → 去原生外观自绘浅灰箭头（与档位下拉同语言）。
 * 双类名提权：压过 .text-input 的 background 简写（简写会把 background-image 重置为 none） */
.select-input.select-input {
  appearance: none;
  -webkit-appearance: none;
  padding: 8px 32px 8px 12px;
  cursor: pointer;
  background-color: var(--background-primary);
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 11px center;
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: var(--size-4-2);
}

/* 协议选择：分段胶囊组——品牌前缀弱化成小字，接口名承载识别；
 * 两个 OpenAI 线相邻、Anthropic 在后；窄面板时整组可换行 */
.protocol-toggle {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 3px;
  padding: 3px;
  border: 1px solid var(--background-modifier-border);
  border-radius: 99px;
  background: var(--background-primary);
  width: fit-content;
}
.protocol-btn {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  padding: 4px 12px;
  font-size: var(--font-size-xs);
  font-weight: 500;
  border: none;
  border-radius: 99px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.protocol-btn:hover {
  color: var(--text-normal);
  background: var(--background-modifier-hover);
}
.protocol-btn.on {
  background: color-mix(in srgb, var(--interactive-accent) 12%, transparent);
  color: var(--text-accent);
}
.proto-brand {
  font-size: var(--font-size-xxs);
  font-weight: 500;
  color: var(--text-faint);
  letter-spacing: 0.02em;
  transition: color var(--dur-fast) var(--ease-out);
}
.protocol-btn.on .proto-brand {
  color: color-mix(in srgb, var(--text-accent) 72%, var(--text-faint));
}

/* ── 折叠自定义设置（dsh customized）：不是盒子——一条发丝线 + 安静小字摘要，
 *    避免在展开区的模块底上再叠白块（灰白交替是之前配色发脏的根源） ── */
.adv-details {
  border-top: 1px solid var(--background-modifier-border);
  padding-top: 10px;
}
.adv-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  width: fit-content;
  padding: 2px 4px;
  margin-left: -4px;
  font-size: var(--font-size-xs);
  font-weight: 500;
  color: var(--text-muted);
  border-radius: var(--radius-s);
  cursor: pointer;
  list-style: none;
  user-select: none;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.adv-summary:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.adv-summary::-webkit-details-marker {
  display: none;
}
.adv-caret {
  display: inline-flex;
  color: var(--text-faint);
  transition: transform var(--dur-norm) var(--ease-out);
}
.adv-details[open] .adv-caret {
  transform: rotate(180deg);
}
.adv-body {
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
}

/* D2（批 5）价格表小节 */
.pricing-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
}
.pricing-title {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-normal);
  display: flex;
  align-items: center;
  gap: 8px;
}
.pricing-on {
  font-weight: 400;
  color: var(--text-accent, inherit);
}
.pricing-off {
  font-weight: 400;
  color: var(--text-faint);
}
.pricing-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
  gap: 8px;
}
.pricing-grid label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: var(--font-size-xxs);
  color: var(--text-muted);
}
.pricing-grid input {
  padding: 5px 8px;
  font-size: var(--font-size-s);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
}
.pricing-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pricing-ok {
  font-size: var(--font-size-xs);
  color: var(--text-accent, green);
}
</style>
