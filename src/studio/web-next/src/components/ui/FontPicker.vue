<script setup lang="ts">
/**
 * 字体下拉选择器。
 * win：原生 <select> 弹出层在 Electron/win 下偶发被 OS 层盖住/错位（J5，2026-09-02），
 * 故 win 改自绘浮层（Teleport + fixed，z-index 同 ContextMenu 系 1000+"层，高于
 * 设置弹窗 modal-mask 150）；非 win 平台保留原生 select（mac 动线不动）。
 * 视觉对齐 `.font-select`（padding/边框/背景由调用方 class 提供，本组件只补按钮
 * 语义与下拉箭头）；菜单项以各字体 fontFamily 预览显示名。
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { usePlatform } from '../../composables/usePlatform'

const props = defineProps<{
  value: string
  fonts: string[]
  placeholder: string
  display: (f: string) => string
  /** 本槽位默认字体的具体名（useSystemFonts 按已安装列表解析；空 = 无可显默认回落 placeholder） */
  defaultFont?: string
}>()
const emit = defineEmits<{ (e: 'change', v: string): void }>()

const { isWin } = usePlatform()

// ── win 自绘浮层状态 ──
const open = ref(false)
// 2026-09-04 作者反馈「下拉每次打开有延迟」：原 v-if="open" 每次全量重建字体项
// （win 系统数百个按钮 + 各自 fontFamily shaping/布局）；字体列表一会话内不变，
// 首开后常驻 DOM、v-show 复开，复开零重建。closed 契约由「元素存在但隐藏」改为
// display:none（测试按可见性断言）。
const rendered = ref(false)
const btn = ref<HTMLElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const pos = ref({ left: 0, top: 0, width: 0 })
const listH = ref(320)

/** 默认态展示名：默认字体名（如「微软雅黑」）；无可显默认回落 placeholder */
const defaultLabel = computed(() => (props.defaultFont ? props.display(props.defaultFont) : props.placeholder))

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
  rendered.value = true
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
  if (e.key !== 'Escape' || !open.value) return
  // R39-4（三十九轮）：open 态本层消费 Esc——capture 注册先于 useHotkeys（后者在
  // WorkspaceShell setup 期挂、bubble 派发按注册序先跑，此处 preventDefault 对它
  // 迟到），对齐 ContextMenu/SettingsModal/ExportDialog 的 Z-23「本层消费防同键退
  // 专注」口径且不依赖挂载时序；未 open 时不消费（Esc 落到 useHotkeys）
  e.preventDefault()
  e.stopPropagation()
  close()
}
function onScrollOrResize(e: Event): void {
  if (!open.value) return
  // R39-3（三十九轮）：浮层自身滚动不算锚位失效——捕获监听会收到 target=菜单的
  // scroll（列表溢出滚动是常态），原逻辑首个滚动 tick 即关闭，第 13 项及以后的
  // 字体永远选不到；只有浮层外的滚动/窗口 resize 才关闭
  const t = e.target
  if (t instanceof Node && menu.value && (t === menu.value || menu.value.contains(t))) return
  close()
}
onMounted(() => {
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', onScrollOrResize)
  window.addEventListener('scroll', onScrollOrResize, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, true)
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
      :style="{ fontFamily: value || defaultFont || 'inherit' }"
      :aria-haspopup="'listbox'"
      :aria-expanded="open"
      :title="value || defaultLabel"
      @click="toggle"
    >
      <span class="fp-label">{{ value ? display(value) : defaultLabel }}</span>
      <svg class="fp-caret" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3 6l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <Teleport to="body">
      <div v-if="rendered" v-show="open" class="fp-mask" @mousedown.prevent.stop="close"></div>
      <div
        v-if="rendered"
        v-show="open"
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
          {{ defaultFont ? `默认 · ${display(defaultFont)}` : placeholder }}
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
  <!-- 非 win：原生 select（原样；默认项同步带默认字体名，闭合态即显示「默认 · X」） -->
  <select
    v-else
    v-bind="$attrs"
    :value="value"
    :style="{ fontFamily: value || defaultFont || 'inherit' }"
    @change="emit('change', (($event.target) as HTMLSelectElement).value)"
  >
    <option value="">{{ defaultFont ? `默认 · ${display(defaultFont)}` : placeholder }}</option>
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
  /* flex 列布局下默认 flex-shrink:1 会把整表项压进 max-height（46 项→每项 12px，
   * 文字被竖直压扁/裁掉）——禁收缩，超高走 overflow 滚动 */
  flex-shrink: 0;
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