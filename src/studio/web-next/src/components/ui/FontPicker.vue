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

// R8C-F3（2026-09-09 修复批）：win 自绘浮层补 listbox 键盘导航——此前 aria 声明
// 完整 combobox/listbox/option 契约（"声明即承诺"），onKey 却只处理 Esc：「声明与
// 实现不符」漂移。补 roving 光标（键盘焦点留在触发按钮，光标经 aria-activedescendant
// 移动，标准 listbox 模式）：↑/↓ 逐项（APG：不环绕）、Home/End 首尾、Enter/Space
// 选中当前项、可打印字符 typeahead（前缀累计 800ms 窗）、Tab 收菜单放行焦移。
// mouseenter 与键盘光标同源（悬停即同步 roving 位，菜单内 hover/键盘态不打架）。
let fpSeq = 0 // 每实例唯一 id 前缀（页面多处字体下拉并存，aria-activedescendant 需全局唯一）
const uid = ++fpSeq
const activeIdx = ref(0)
const listNames = computed(() => [
  props.defaultFont ? `默认 · ${props.display(props.defaultFont)}` : props.placeholder,
  ...props.fonts.map((f) => props.display(f)),
])
const listCount = computed(() => props.fonts.length + 1)
const optId = (i: number): string => `fp-${uid}-opt-${i}`
/** 当前 roving 光标对应的字体值（0 = 默认项 → ''） */
const activeFont = computed(() => (activeIdx.value === 0 ? '' : props.fonts[activeIdx.value - 1]!))
let typeBuf = ''
let typeTimer: ReturnType<typeof setTimeout> | undefined
function startTypeahead(ch: string): void {
  const needle = typeBuf + ch
  // 惯例：自当前项之后绕回找前缀命中（罗盘式循环，未命中保持原位）
  for (let step = 1; step <= listCount.value; step++) {
    const i = (activeIdx.value + step) % listCount.value
    if (listNames.value[i]!.toLowerCase().startsWith(needle.toLowerCase())) {
      activeIdx.value = i
      break
    }
  }
  typeBuf = needle
  clearTimeout(typeTimer)
  typeTimer = setTimeout(() => {
    typeBuf = ''
  }, 800)
}
function revealActive(): void {
  const m = menu.value
  // 菜单子元素序 = 项序（默认项 + fonts 逐项，中间无分隔节点）；content-visibility
  // 屏外项实测不影响 children 索引（跳过布局/绘制但节点在列）
  const el = m?.children[activeIdx.value] as HTMLElement | undefined
  el?.scrollIntoView?.({ block: 'nearest' })
}

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
  // R8C-F3：打开即定位 roving 光标到当前值对应项（无值 → 默认项 0）
  const cur = props.value === '' ? 0 : props.fonts.indexOf(props.value) + 1
  activeIdx.value = cur >= 1 ? cur : 0
}
function close(): void {
  open.value = false
}
function pick(f: string): void {
  emit('change', f)
  close()
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (!open.value) return // 未开不消费——Esc 落到 useHotkeys
    // R50-D1-1（五十轮）：IME 组合期 Esc 让渡输入法（isImeComposing 单源判据，对齐
    // ModelPicker/SettingsModal 等先例）——组合期收候选的 Esc 不应连带关闭字体下拉
    if (isImeComposing(e)) return
    // R39-4（三十九轮）：open 态本层消费 Esc——capture 注册先于 useHotkeys（后者在
    // WorkspaceShell setup 期挂、bubble 派发按注册序先跑，此处 preventDefault 对它
    // 迟到），对齐 ContextMenu/SettingsModal/ExportDialog 的 Z-23「本层消费防同键退
    // 专注」口径且不依赖挂载时序
    e.preventDefault()
    e.stopPropagation()
    close()
    return
  }
  // R8C-F3：非 Esc 键仅 open 态且 win 自绘路径（非 win 原生 select 不拦）才收口
  if (!open.value || !isWin) return
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      e.stopPropagation()
      if (activeIdx.value < listCount.value - 1) activeIdx.value++
      revealActive()
      break
    case 'ArrowUp':
      e.preventDefault()
      e.stopPropagation()
      if (activeIdx.value > 0) activeIdx.value--
      revealActive()
      break
    case 'Home':
      e.preventDefault()
      e.stopPropagation()
      activeIdx.value = 0
      revealActive()
      break
    case 'End':
      e.preventDefault()
      e.stopPropagation()
      activeIdx.value = listCount.value - 1
      revealActive()
      break
    case 'Enter':
    case ' ':
      // Space 不拦会触发按钮默认激活 → toggle 反关菜单；Enter/Space 语义 = 选中当前项
      e.preventDefault()
      e.stopPropagation()
      pick(activeFont.value)
      break
    case 'Tab':
      close() // 收菜单放行焦移（不 preventDefault）
      break
    default:
      // typeahead：非修饰组合的可打印字符
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        e.stopPropagation()
        startTypeahead(e.key)
        revealActive()
      }
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
      :aria-activedescendant="open ? optId(activeIdx) : undefined"
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
          :class="{ on: value === '', active: 0 === activeIdx }"
          :id="optId(0)"
          role="option"
          :aria-selected="value === ''"
          @click="pick('')"
          @mouseenter="activeIdx = 0"
        >
          {{ defaultFont ? `默认 · ${display(defaultFont)}` : placeholder }}
        </button>
        <button
          v-for="(f, i) in fonts"
          :key="f"
          type="button"
          class="fp-item"
          :class="{ on: f === value, active: i + 1 === activeIdx }"
          :id="optId(i + 1)"
          :style="{ fontFamily: f }"
          role="option"
          :aria-selected="f === value"
          @click="pick(f)"
          @mouseenter="activeIdx = i + 1"
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
.fp-item.on {
  color: var(--text-accent);
  background: color-mix(in srgb, var(--interactive-accent) 12%, transparent);
}
/* R8C-F3：roving 光标（aria-activedescendant 指向项）——与 hover 同底色；
 * 选中项上加叠更深的 accent 底，键盘光标与已选态同屏可辨 */
.fp-item.active {
  background: var(--background-modifier-hover);
}
.fp-item.active.on {
  background: color-mix(in srgb, var(--interactive-accent) 22%, transparent);
}
</style>