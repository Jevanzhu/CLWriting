<script setup lang="ts">
/**
 * 字体下拉选择器。
 * win：原生 <select> 弹出层在 Electron/win 下偶发被 OS 层盖住/错位（J5，2026-09-02），
 * 故 win 改自绘浮层（Teleport + fixed，z-index 同 ContextMenu 系 1000+"层，高于
 * 设置弹窗 modal-mask 150）；非 win 平台保留原生 select（mac 动线不动）。
 * 视觉对齐 `.font-select`（padding/边框/背景由调用方 class 提供，本组件只补按钮
 * 语义与下拉箭头）；菜单项以各字体 fontFamily 预览显示名。
 */
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { usePlatform } from '../../composables/usePlatform'

const props = defineProps<{
  value: string
  fonts: string[]
  placeholder: string
  display: (f: string) => string
}>()
const emit = defineEmits<{ (e: 'change', v: string): void }>()

const { isWin } = usePlatform()

// ── win 自绘浮层状态 ──
const open = ref(false)
const btn = ref<HTMLElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const pos = ref({ left: 0, top: 0, width: 0 })
const listH = ref(320)

function toggle(): void {
  open.value ? close() : openMenu()
}
function openMenu(): void {
  const r = btn.value!.getBoundingClientRect()
  pos.value = {
    left: r.left,
    top: r.bottom + 4,
    width: Math.max(r.width, 240),
  }
  listH.value = Math.max(120, Math.min(360, window.innerHeight - pos.value.top - 12))
  open.value = true
}
function close(): void {
  open.value = false
}
function pick(f: string): void {
  emit('change', f)
  close()
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') close()
}
function onScrollOrResize(): void {
  if (open.value) close()
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', onScrollOrResize)
  window.addEventListener('scroll', onScrollOrResize, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onScrollOrResize)
  window.removeEventListener('scroll', onScrollOrResize, true)
})
</script>

<template>
  <!-- win：自绘浮层 -->
  <template v-if="isWin">
    <button
      ref="btn"
      type="button"
      class="font-picker"
      v-bind="$attrs"
      :class="{ open }"
      :style="{ fontFamily: value || 'inherit' }"
      :aria-haspopup="'listbox'"
      :aria-expanded="open"
      :title="value || placeholder"
      @click="toggle"
    >
      <span class="fp-label">{{ value ? display(value) : placeholder }}</span>
      <svg class="fp-caret" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3 6l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <Teleport to="body">
      <div v-if="open" class="fp-mask" @mousedown.prevent.stop="close"></div>
      <div
        v-if="open"
        ref="menu"
        class="fp-menu"
        role="listbox"
        :style="{ left: pos.left + 'px', top: pos.top + 'px', width: pos.width + 'px', maxHeight: listH + 'px' }"
      >
        <button
          type="button"
          class="fp-item"
          :class="{ on: value === '' }"
          role="option"
          :aria-selected="value === ''"
          @click="pick('')"
        >
          {{ placeholder }}
        </button>
        <button
          v-for="f in fonts"
          :key="f"
          type="button"
          class="fp-item"
          :class="{ on: f === value }"
          :style="{ fontFamily: f }"
          role="option"
          :aria-selected="f === value"
          @click="pick(f)"
        >
          {{ display(f) }}
        </button>
      </div>
    </Teleport>
  </template>
  <!-- 非 win：原生 select（原样） -->
  <select
    v-else
    v-bind="$attrs"
    :value="value"
    :style="{ fontFamily: value || 'inherit' }"
    @change="emit('change', (($event.target) as HTMLSelectElement).value)"
  >
    <option value="">{{ placeholder }}</option>
    <option v-for="f in fonts" :key="f" :value="f" :style="{ fontFamily: f }">{{ display(f) }}</option>
  </select>
</template>

<style scoped>
/* 按钮语义对齐原生 select 观感；padding/边框/背景由 `.font-select`/`.ffb-select` 提供 */
.font-picker {
  appearance: none;
  -webkit-appearance: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  text-align: left;
}
.font-picker.open {
  border-color: var(--interactive-accent);
}
.fp-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fp-caret {
  flex-shrink: 0;
  color: var(--text-faint);
}

/* 浮层：z-index 同 ContextMenu 系（1000/1001），高于 modal-mask(150) */
.fp-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
}
.fp-menu {
  position: fixed;
  z-index: 1001;
  display: flex;
  flex-direction: column;
  padding: 4px;
  overflow-y: auto;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: var(--background-secondary);
  box-shadow: var(--shadow-l);
}
.fp-item {
  padding: 6px 10px;
  font-size: var(--font-size-s);
  text-align: left;
  border: none;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-normal);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fp-item:hover {
  background: var(--background-modifier-hover);
}
.fp-item.on {
  color: var(--text-accent);
  background: color-mix(in srgb, var(--interactive-accent) 12%, transparent);
}
</style>