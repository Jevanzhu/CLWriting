<script setup lang="ts">
/**
 * 模型清单候选弹窗（hh §八-16 自 ModelListEditor.vue 拆出，纯搬家）。
 * 从「获取模型列表」探测结果勾选采纳——勾选集 picked 由父层持有（采纳/去重逻辑在父）。
 */
import { X, Check } from 'lucide-vue-next'
import { onMounted, onBeforeUnmount } from 'vue'
import { isImeComposing } from '../../shared/ime'

const props = defineProps<{
  show: boolean
  candidates: string[]
  /** 已勾选的模型 id 集（父层持有；toggle 事件上抛） */
  picked: Set<string>
}>()

const emit = defineEmits<{
  toggle: [id: string]
  close: []
  adopt: []
}>()

// R37-36（三十七轮批E）：弹层内按 Esc 关闭自身且不外溢——原无任何 Esc 处理，按键直穿
// 到 window 层的外层 Esc 链（useHotkeys 退专注/SettingsModal 关设置），内层未关外层
// 先动。document capture + stopPropagation：先于外层 window 冒泡监听收口，本层消费后
// 外层不再触发（对齐 ConfirmPrompt 的 capture 手法）；IME 组合期 Esc 归输入法（R75-E-P3e）
function onKeydown(e: KeyboardEvent): void {
  if (!props.show || e.key !== 'Escape') return
  if (isImeComposing(e)) return
  e.preventDefault()
  e.stopPropagation()
  emit('close')
}
onMounted(() => document.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <!-- 候选弹窗：从已拉取清单勾选 -->
  <Teleport to="body">
    <div v-if="show" class="picker-mask" @click.self="emit('close')">
      <div class="picker-pop">
        <div class="picker-head">
          <span>从模型清单选择</span>
          <button class="close-btn" @click="emit('close')"><X :size="15" /></button>
        </div>
        <div class="picker-list">
          <label v-for="c in candidates" :key="c" class="picker-item">
            <input type="checkbox" :checked="picked.has(c)" @change="emit('toggle', c)" />
            <span>{{ c }}</span>
          </label>
        </div>
        <div class="picker-actions">
          <button class="cancel-btn" @click="emit('close')">取消</button>
          <button class="save-btn" :disabled="picked.size === 0" @click="emit('adopt')">
            <Check :size="14" /> 添加 {{ picked.size }} 个
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
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
</style>
