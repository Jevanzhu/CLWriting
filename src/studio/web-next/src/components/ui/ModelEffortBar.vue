<script setup lang="ts">
/**
 * 模型 + 推理等级统一下拉条（Codex 风格胶囊）。
 * ChatPanel（工作台 tab）与 ChatDock（dock 输入框）共用，保证两处视觉/行为完全一致。
 */
import { ref, watch, nextTick, onMounted } from 'vue'
import { ChevronDown, Cpu } from 'lucide-vue-next'
import { useChatTier, EFFORT_LEVELS } from '../../composables/useChatTier'

const tier = useChatTier()

// ── 模型/推理等级下拉宽度贴合当前选中项 ──

const modelSelect = ref<HTMLSelectElement | null>(null)
const effortSelect = ref<HTMLSelectElement | null>(null)

/** 用临时 span 测量当前选中文本宽度，写入 select 宽度（自适应当前内容）。
 *  span 的 0 4px 内距 = 居中后两侧各 4px 留白；再加 select 自身水平内边距
 *  （胶囊内边距由 label 的 padding 提供） */
function fitSelect(el: HTMLSelectElement | null): void {
  if (!el) return
  const cs = getComputedStyle(el)
  const span = document.createElement('span')
  span.style.cssText = `font:${cs.font};letter-spacing:${cs.letterSpacing};white-space:nowrap;position:absolute;visibility:hidden;padding:0 4px;`
  span.textContent = el.value || '选择模型'
  document.body.appendChild(span)
  el.style.width = `${span.offsetWidth + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)}px`
  document.body.removeChild(span)
}

watch(
  () => [tier.activeModel, tier.activeEffort],
  () => nextTick(() => {
    fitSelect(modelSelect.value)
    fitSelect(effortSelect.value)
  }),
)
onMounted(() => {
  nextTick(() => {
    fitSelect(modelSelect.value)
    fitSelect(effortSelect.value)
  })
})
</script>

<template>
  <div class="model-effort-bar">
    <label class="composer-chip" :class="{ on: !!tier.chatTier }" data-tip="对话档 · 未配置时回落创作档 Beta">
      <Cpu :size="12" />
      <select
        ref="modelSelect"
        :value="tier.activeModel"
        class="chat-select chat-model"
        :disabled="tier.tierLoading"
        @change="tier.onModelChange"
      >
        <option v-if="tier.activeModel && !tier.models.includes(tier.activeModel)" :value="tier.activeModel">{{ tier.activeModel }}</option>
        <option value="" disabled>选择模型</option>
        <option v-for="m in tier.modelsOptions" :key="m.value" :value="m.value">{{ m.label }}</option>
      </select>
      <ChevronDown :size="10" />
    </label>
    <label class="composer-chip" :class="{ on: !!tier.chatTier }">
      <select
        ref="effortSelect"
        :value="tier.activeEffort"
        class="chat-select chat-effort"
        :disabled="tier.tierLoading || !tier.activeModel"
        @change="tier.onEffortChange"
      >
        <option v-for="l in EFFORT_LEVELS" :key="l" :value="l">{{ l }}</option>
      </select>
      <ChevronDown :size="10" />
    </label>
  </div>
</template>

<style scoped>
/* ── 统一下拉胶囊（两对话共用，含 ChevronDown 下拉箭头）── */
.model-effort-bar {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.composer-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--background-secondary);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.composer-chip:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.composer-chip.on {
  color: var(--text-accent);
}
.chat-select {
  appearance: none;
  border: none;
  background: transparent;
  color: inherit;
  font-size: inherit;
  font-family: var(--font-ui); /* UI 字体，清晰可读 */
  font-weight: 500;
  /* 高度=行高：文字垂直精确居中（档位下拉同手法——去原生外观后定位归 CSS）；
   * 22px 亦高于中文字形，不裁上下部 */
  height: 22px;
  line-height: 22px;
  letter-spacing: 0.01em;
  text-align: center; /* 左右居中：宽度贴合当前选中项，余量两侧对称 */
  text-align-last: center;
  outline: none;
  cursor: pointer;
  padding: 0;
}
.chat-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
/* 宽度由 JS 测量贴合当前选中项（兜底上限防超长模型名溢出） */
.chat-model {
  max-width: 300px;
  white-space: nowrap;
}
.chat-effort {
  max-width: 96px;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
}
</style>