<script setup lang="ts">
/**
 * 字体下拉选择器。
 * win：原生 <select> 弹出层在 Electron/win 下偶发被 OS 层盖住/错位（J5，2026-09-02），
 * 故 win 改自绘浮层（Teleport + fixed，z-index 同 ContextMenu 系 1000+"层，高于
 * 设置弹窗 modal-mask 150）；非 win 平台保留原生 select（mac 动线不动）。
 * 视觉对齐 `.font-select`（padding/边框/背景由调用方 class 提供，本组件只补按钮
 * 语义与下拉箭头）；菜单项以各字体 fontFamily 预览显示名。
 */
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { usePlatform } from '../../composables/usePlatform'
import { isImeComposing } from '../../shared/ime'

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
// 重评-P2-2（2026-09-09 全量代码重评）：win 浮层原只声明 role=listbox/option，键盘不可达
// （onKey 只管 Esc）。补 roving tabindex 键盘导航（对齐 CommandPalette 的 sel 索引风格）：
// 开启即把焦点移入列表（落当前选中项），↑/↓ 循环、Home/End 首尾、Enter/Space 选中、
// Esc 关闭还焦触发钮、Tab 自然走焦关闭。高亮项渲染 .hl class + tabindex=0，ARIA 面转如实。
/** 键盘高亮项索引：0 = 默认项（重置 ''），i≥1 = fonts[i-1]；-1 = 未初始化 */
const activeIdx = ref(-1)
/** 键盘导航域与渲染项一一对应（首项 = 重置默认 ''） */
const optionValues = computed<string[]>(() => ['', ...props.fonts])

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
  // P2-2：开启即把键盘焦点移入列表（roving tabindex，落当前选中项；无命中回落首项）
  void nextTick(() => {
    activeIdx.value = currentValueIdx()
    focusActive()
  })
}
function close(): void {
  open.value = false
}
function currentValueIdx(): number {
  if (props.value === '') return 0
  const i = props.fonts.indexOf(props.value)
  return i === -1 ? 0 : i + 1
}
function focusActive(): void {
  const items = menu.value?.querySelectorAll<HTMLElement>('.fp-item')
  if (!items || items.length === 0) return
  const idx = Math.min(Math.max(activeIdx.value, 0), items.length - 1)
  items[idx]?.focus()
}
/** ↑/↓ 循环步进（P2-2） */
function moveActive(delta: 1 | -1): void {
  const n = optionValues.value.length
  if (n === 0) return
  const cur = activeIdx.value < 0 ? (delta > 0 ? -1 : 0) : activeIdx.value
  activeIdx.value = (cur + delta + n) % n
  focusActive()
}
function pick(f: string): void {
  emit('change', f)
  close()
}
function onKey(e: KeyboardEvent): void {
  if (!open.value) return
  // P2-2：Tab 自然走焦关闭（不消费，焦点随 Tab 落到下一元素）
  if (e.key === 'Tab') {
    close()
    return
  }
  // R50-D1-1（五十轮）：IME 组合期 Esc 让渡输入法（isImeComposing 单源判据，对齐
  // ModelPicker/SettingsModal 等先例）——组合期收候选的 Esc 不应连带关闭字体下拉；
  // P2-2 起方向键/Enter 同口径让渡
  if (isImeComposing(e)) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    e.stopPropagation()
    moveActive(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    e.stopPropagation()
    moveActive(-1)
  } else if (e.key === 'Home') {
    e.preventDefault()
    e.stopPropagation()
    activeIdx.value = 0
    focusActive()
  } else if (e.key === 'End') {
    e.preventDefault()
    e.stopPropagation()
    activeIdx.value = optionValues.value.length - 1
    focusActive()
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    e.stopPropagation()
    const v = optionValues.value[Math.max(activeIdx.value, 0)]
    if (v === undefined) return
    pick(v)
    btn.value?.focus() // P2-2：键盘选中后焦点还触发钮（原生 select 同款语义）
  } else if (e.key === 'Escape') {
    // R39-4（三十九轮）：open 态本层消费 Esc——capture 注册先于 useHotkeys（后者在
    // WorkspaceShell setup 期挂、bubble 派发按注册序先跑，此处 preventDefault 对它
    // 迟到），对齐 ContextMenu/SettingsModal/ExportDialog 的 Z-23「本层消费防同键退
    // 专注」口径且不依赖挂载时序；未 open 时不消费（Esc 落到 useHotkeys）
    e.preventDefault()
    e.stopPropagation()
    close()
    btn.value?.focus() // P2-2：Esc 关闭后焦点还触发钮
  }
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
        <!-- P2-2：默认项 + 字体项合并为单一 v-for（与 optionValues 索引一一对应），
             roving tabindex + .hl 键盘高亮；.on 仍标当前选中值 -->
        <button
          v-for="(f, i) in optionValues"
          :key="i === 0 ? '__default__' : f"
          type="button"
          class="fp-item"
          :class="{ on: f === value, hl: i === activeIdx }"
          :style="f ? { fontFamily: f } : undefined"
          role="option"
          :aria-selected="f === value"
          :tabindex="i === activeIdx ? 0 : -1"
          @click="pick(f)"
        >
          {{ i === 0 ? (defaultFont ? `默认 · ${display(defaultFont)}` : placeholder) : display(f) }}
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
  /* 2026-09-08（作者反馈「预热后首开/复开仍有延迟卡顿」）：win 系统字体数百项，
   * 打开瞬间全量布局 + 每项各自 fontFamily 的文本首次 shaping 是主耗时（v-show
   * display:none 复显每次重排全表；DOM 常驻只免了节点重建）。content-visibility:
   * auto 令溢出视口的项跳过布局/绘制/shaping（字体文件也只在滚入时才加载），
   * 打开与复开成本收敛到可视窗口 ~12 项；常驻 DOM 复用口径与全部交互语义不变。
   * 屏外项以 contain-intrinsic-size 占位（项高统一 ≈30px；auto 前缀在首次真实
   * 渲染后锁定实测值），滚动条高度稳定。 */
  content-visibility: auto;
  contain-intrinsic-size: auto 30px;
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
/* P2-2：键盘高亮项（roving tabindex 焦点所在），与 hover 同视觉 */
.fp-item.hl {
  background: var(--background-modifier-hover);
}
.fp-item:focus-visible {
  outline: none;
}
.fp-item.on {
  color: var(--text-accent);
  background: color-mix(in srgb, var(--interactive-accent) 12%, transparent);
}
</style>