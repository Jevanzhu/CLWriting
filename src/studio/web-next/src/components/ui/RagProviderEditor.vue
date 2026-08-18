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
      </div>
      <div class="form-actions">
        <button class="cancel-btn" @click="emit('cancel')">取消</button>
        <button class="save-btn" @click="emit('save', { ...form })">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 表单骨架/输入/胶囊按钮均来自 providers.css 共享类。 */
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
