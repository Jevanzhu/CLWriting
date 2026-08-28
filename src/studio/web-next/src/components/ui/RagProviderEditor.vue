<script setup lang="ts">
// RAG 提供方新增/编辑表单（I1 纯重构拆分自 AiServicePanel + 阶段 14 P6 Key 前端校验）。
// 草稿为组件本地状态；校验与 API 写入留在父层（AiServicePanel.saveRag）。
// 表单骨架/输入/胶囊按钮用 providers.css 共享类。
import { ref, computed } from 'vue'
import type { RagProviderDto } from '../../api/providers'
import { apiKeyFailure } from '../../shared/provider-format'

const props = defineProps<{
  /** 编辑目标（null = 新增）；挂载时快照初始化（与原 v-if 重建语义一致） */
  initial: RagProviderDto | null
  /** 父层保存在途（R73-62）：校验与 API 写入在父层（AiServicePanel.saveRag），在途锁也在
   *  父层——在途时禁保存按钮 + 文案反馈，挡双击第二笔重复提交 */
  saving?: boolean
}>()

const emit = defineEmits<{
  save: [form: { name: string; endpoint: string; model: string; apiKey: string }]
  cancel: []
}>()

const form = ref(
  props.initial
    ? { name: props.initial.name, endpoint: props.initial.endpoint, model: props.initial.model, apiKey: '' }
    : { name: '', endpoint: '', model: '', apiKey: '' },
)

/** P6：新增必填且形状校验；编辑留空 = 保留原 key。 */
const keyError = computed(() => {
  if (props.initial && !form.value.apiKey) return null
  return apiKeyFailure(form.value.apiKey)
})
</script>

<template>
  <div class="rag-provider-section">
    <div class="form">
      <div class="form-row">
        <label>名称</label>
        <input v-model="form.name" type="text" placeholder="如「OpenAI 官方」" class="text-input" />
      </div>
      <div class="form-row">
        <label>嵌入服务地址</label>
        <input v-model="form.endpoint" type="text" placeholder="https://api.example.com/v1/embeddings（完整 URL）" class="text-input" />
      </div>
      <div class="form-row">
        <label>嵌入模型</label>
        <input v-model="form.model" type="text" placeholder="如 text-embedding-3-small" class="text-input" />
      </div>
      <div class="form-row">
        <label>API Key</label>
        <input
          v-model="form.apiKey"
          type="password"
          :placeholder="initial ? '不改则保留原 Key' : '粘贴你的 API Key'"
          class="text-input"
        />
        <span v-if="keyError" class="key-error">{{ keyError }}</span>
        <span v-if="initial?.hasKey && !form.apiKey" class="key-stored">已存 Key（vault 加密，留空即保留）</span>
      </div>
      <div class="form-actions">
        <button class="cancel-btn" @click="emit('cancel')">取消</button>
        <!-- R73-62：保存按钮在途禁用 + 文案反馈 -->
        <button class="save-btn" :disabled="saving" @click="emit('save', { ...form })">{{ saving ? '保存中…' : '保存' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 表单骨架/输入/胶囊按钮均来自 providers.css 共享类。 */
/* 凭据状态点（I6·P3）：hasKey 来自服务端 vault 存在性推导（与 AiProviderEditor 同则） */
.key-stored {
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
}
.rag-provider-section {
  display: grid;
  gap: var(--size-4-2);
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: var(--size-4-2);
}
</style>
