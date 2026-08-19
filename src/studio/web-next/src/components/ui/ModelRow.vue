<script setup lang="ts">
/**
 * 模型行卡片（hh §八-16 自 ModelListEditor.vue 拆出，纯搬家）。
 * 单行 id/名称平铺输入 + 展开容量（contextWindow/maxTokens）；受控组件——
 * 输入即时上抛 change(patch)，由父层合并进 v-model 草稿。
 */
import { Trash2, ChevronRight } from 'lucide-vue-next'
import type { ModelRowDraft } from '../../shared/provider-format'

withDefaults(defineProps<{
  /** 本行草稿（父层 LocalRow 含 _key，结构满足 ModelRowDraft 即可） */
  row: ModelRowDraft
  /** 容量区展开态（父层按稳定 _key 记录） */
  expanded: boolean
  disabled?: boolean
}>(), { disabled: false })

const emit = defineEmits<{
  change: [patch: Partial<ModelRowDraft>]
  toggle: []
  remove: []
}>()
</script>

<template>
  <div class="model-entry">
    <div class="model-row">
      <input
        :value="row.id"
        type="text"
        placeholder="模型 id，如 gpt-5"
        aria-label="模型 id"
        class="compact-input row-input-id"
        :disabled="disabled"
        @input="emit('change', { id: ($event.target as HTMLInputElement).value })"
      />
      <input
        :value="row.name"
        type="text"
        placeholder="显示名（可选）"
        aria-label="显示名"
        class="compact-input"
        :disabled="disabled"
        @input="emit('change', { name: ($event.target as HTMLInputElement).value })"
      />
      <button
        class="row-icon-btn"
        :class="{ open: expanded }"
        :aria-expanded="expanded"
        data-tip="容量（上下文 / 输出上限）"
        :disabled="disabled"
        @click="emit('toggle')"
      >
        <ChevronRight :size="14" />
      </button>
      <button class="row-icon-btn danger" :disabled="disabled" data-tip="删除此模型行" @click="emit('remove')">
        <Trash2 :size="13" />
      </button>
    </div>
    <div v-if="expanded" class="model-advanced">
      <div class="model-field">
        <label>上下文窗口</label>
        <input
          :value="row.contextWindowText"
          type="text"
          placeholder="256K"
          class="compact-input"
          :disabled="disabled"
          @input="emit('change', { contextWindowText: ($event.target as HTMLInputElement).value })"
        />
        <span class="field-hint">空 = 默认 256K；支持 K/M</span>
      </div>
      <div class="model-field">
        <label>最大输出 token</label>
        <input
          :value="row.maxTokensText"
          type="text"
          placeholder="128K"
          class="compact-input"
          :disabled="disabled"
          @input="emit('change', { maxTokensText: ($event.target as HTMLInputElement).value })"
        />
        <span class="field-hint">空 = 默认 128K；支持 K/M</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
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
</style>
