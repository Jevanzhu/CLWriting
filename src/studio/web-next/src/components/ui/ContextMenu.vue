<script lang="ts">
/** 通用右键菜单项。
 *  separator=true 分割线；submenu 非空时父级 hover 展开 ▸。
 *  disabled 灰显不可点击；accelerator 为 Electron 格式快捷键（如 "CmdOrCtrl+X"）。
 *  桌面端由 Electron Menu 渲染（原生外观）；浏览器回退由本组件 CSS 模拟 macOS 风格。 */
export interface MenuItem {
  key: string
  label: string
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  accelerator?: string
  submenu?: MenuItem[]
}
</script>

<script setup lang="ts">
// 浏览器/dev 回退的 CSS 模拟右键菜单（桌面端走 Electron 原生 Menu，不渲染本组件）。
// mask 和 menu 必须是 body 下的兄弟元素，不能嵌套——mask 的 z-index+position
// 会创建独立 stacking context，导致 menu 的 backdrop-filter 失效。
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { isImeComposing } from '../../shared/ime'

const props = defineProps<{
  visible: boolean
  x: number
  y: number
  items: MenuItem[]
}>()
const emit = defineEmits<{
  select: [key: string]
  close: []
}>()

const openSub = ref<string | null>(null)
const menuEl = ref<HTMLElement>()
const flipX = ref(false)
const flipY = ref(false)

// 重评2-P3-2（2026-09-09 全量重评 GLM-5.3）：浏览器回退菜单键盘导航（照 FontPicker
// 重评-P2-2 的 roving tabindex 搭法）——原 role="menu" 面仅 Esc 可用，无方向键导航，
// 纯键盘用户进不了任何菜单项。开启即把焦点移入首项，↑/↓ 循环、Home/End 首尾、
// Enter/Space 激活、Tab 自然走焦关闭、关闭还焦右键来源；容器另挂 aria-activedescendant
//（roving 焦点在项上时为冗余保险，焦点若落容器 AT 也能命中高亮项）。桌面端走 Electron
// 原生 Menu 不渲染本组件，不受影响。子菜单飞出层沿 hover 语义不进 roving 序（与原实现一致）。
/** 键盘高亮项在 navItems 中的序；-1 = 未初始化 */
const activeIdx = ref(-1)
/** 顶层可导航项（跳过分隔线；idx = props.items 下标，供 id/aria 对应） */
const navItems = computed(() => props.items.map((item, idx) => ({ item, idx })).filter((e) => !e.item.separator))
/** aria-activedescendant 指向的高亮项 id（与模板 cm-i-{items 下标} 对应） */
const activeId = computed(() => {
  const e = navItems.value[activeIdx.value]
  return e ? `cm-i-${e.idx}` : undefined
})
/** 打开前焦点元素（关闭时还焦右键来源——FontPicker P2-2「还焦触发钮」同语义） */
let prevFocus: HTMLElement | null = null

/** 顶层项导航序（props.items 下标 → 非分隔项序，模板 tabindex/.hl 用；菜单项极少 O(n) 直查） */
function navIdxOf(itemsIdx: number): number {
  return navItems.value.findIndex((e) => e.idx === itemsIdx)
}
/** 焦点移到高亮项（FontPicker focusActive 同款：顶层可聚焦项 DOM 序与 navItems 一一对应） */
function focusActive(): void {
  const el = menuEl.value
  if (!el) return
  const items = el.querySelectorAll<HTMLElement>(':scope > .cm-item, :scope > .cm-sub-wrap > .cm-item')
  if (items.length === 0) return
  const idx = Math.min(Math.max(activeIdx.value, 0), items.length - 1)
  items[idx]?.focus()
}
/** ↑/↓ 循环步进（FontPicker moveActive 同款） */
function moveActive(delta: 1 | -1): void {
  const n = navItems.value.length
  if (n === 0) return
  const cur = activeIdx.value < 0 ? (delta > 0 ? -1 : 0) : activeIdx.value
  activeIdx.value = (cur + delta + n) % n
  focusActive()
}
/** Enter/Space 激活高亮项：普通项选中关闭；子菜单父项开/收飞出层；disabled 可聚焦不可激活 */
function activateActive(): void {
  const e = navItems.value[Math.max(activeIdx.value, 0)]
  if (!e) return
  if (e.item.submenu) {
    openSub.value = openSub.value === e.item.key ? null : e.item.key
    return
  }
  if (e.item.disabled) return
  onSelect(e.item.key)
}

/** Electron accelerator → 平台可读文本（"CmdOrCtrl+X" → mac "⌘X" / win·linux "Ctrl+X"）。
 *  R33-83（三十三轮）：原无条件映射 ⌘，win 浏览器/dev 回退菜单显示 mac 符号。
 *  R37-35（三十七轮批E）：平台探测三级兜底——navigator.userAgentData?.platform 是
 *  Chromium-only API，老 WebView/非 Chromium 内核无该成员；其后回落 navigator.platform
 *  （已废弃但覆盖面广），再回落 navigator.userAgent 字符串嗅探，探测不再单源落空。 */
function isMacPlatform(): boolean {
  const uad = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
    ?.platform
  if (uad) return uad.toLowerCase().includes('mac')
  if (navigator.platform) return navigator.platform.toLowerCase().includes('mac')
  return navigator.userAgent.toLowerCase().includes('mac')
}

function accelLabel(accel?: string): string {
  if (!accel) return ''
  const isMac = isMacPlatform()
  return accel
    .replace(/CmdOrCtrl\+/g, isMac ? '⌘' : 'Ctrl+')
    .replace(/Shift\+/g, isMac ? '⇧' : 'Shift+')
    .replace(/Alt\+/g, isMac ? '⌥' : 'Alt+')
}

watch(
  () => props.visible,
  async (v) => {
    if (!v) {
      // 重评2-P3-2：关闭收尾——菜单会话仍持有焦点（焦点在菜单内/已落 body）时还焦
      // 右键来源，防焦点丢在已卸载的菜单上；他处焦点不动（parent 主动关窗等场景）
      const menu = menuEl.value
      const cur = document.activeElement
      if (prevFocus && (cur === null || cur === document.body || (menu !== undefined && menu.contains(cur)))) {
        prevFocus.focus()
      }
      prevFocus = null
      activeIdx.value = -1
      openSub.value = null
      return
    }
    prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    flipX.value = false
    flipY.value = false
    await nextTick()
    const el = menuEl.value
    if (!el) return
    const r = el.getBoundingClientRect()
    if (props.x + r.width > window.innerWidth - 8) flipX.value = true
    if (props.y + r.height > window.innerHeight - 8) flipY.value = true
    // 重评2-P3-2：开启即把键盘焦点移入首项（roving tabindex；与 flip 复位同一拍完成）
    activeIdx.value = navItems.value.length > 0 ? 0 : -1
    focusActive()
  },
)

function onKey(e: KeyboardEvent): void {
  if (!props.visible) return // 菜单未开不消费——Esc 落到 useHotkeys
  if (e.key === 'Escape') {
    emit('close')
    e.preventDefault() // Z-23（第五十八轮）：本层消费 Esc，防同键退专注双效
    return
  }
  // 重评2-P3-2：方向键/Home/End/Enter/Space roving 导航；IME 组合期让渡输入法
  //（FontPicker P2-2 同口径）；Tab 不消费仅关闭，焦点走自然次序
  if (isImeComposing(e)) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    moveActive(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    moveActive(-1)
  } else if (e.key === 'Home') {
    e.preventDefault()
    if (navItems.value.length > 0) {
      activeIdx.value = 0
      focusActive()
    }
  } else if (e.key === 'End') {
    e.preventDefault()
    if (navItems.value.length > 0) {
      activeIdx.value = navItems.value.length - 1
      focusActive()
    }
  } else if (e.key === 'Enter' || e.key === ' ') {
    // keydown 期 preventDefault 截停原生按钮激活（无原生 click），激活只走 activateActive 防双触发
    e.preventDefault()
    activateActive()
  } else if (e.key === 'Tab') {
    emit('close')
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))

function onSelect(key: string): void {
  emit('select', key)
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <template v-if="visible">
      <div class="cm-mask" @click="emit('close')" @contextmenu.prevent="emit('close')" />
      <div
        ref="menuEl"
        class="cm-menu"
        role="menu"
        :class="{ 'flip-x': flipX, 'flip-y': flipY }"
        :style="{ '--cm-x': x + 'px', '--cm-y': y + 'px' }"
        :aria-activedescendant="activeId"
        @click.stop
        @contextmenu.prevent.stop
      >
        <template v-for="(item, i) in items" :key="item.key || `sep-${i}`">
          <div v-if="item.separator" class="cm-sep" role="separator"></div>
          <div
            v-else-if="item.submenu"
            class="cm-sub-wrap"
            @mouseenter="openSub = item.key"
            @mouseleave="openSub = null"
          >
            <!-- 重评2-P3-2：顶层项 roving tabindex（高亮项 0 其余 -1）+ id 供 aria-activedescendant -->
            <button
              class="cm-item cm-has-sub"
              role="menuitem"
              :id="`cm-i-${i}`"
              :tabindex="navIdxOf(i) === activeIdx ? 0 : -1"
              :class="{ hl: navIdxOf(i) === activeIdx }"
              :aria-disabled="item.disabled || undefined"
            >
              <span class="cm-label">{{ item.label }}</span>
              <span class="cm-caret">▸</span>
            </button>
            <div v-if="openSub === item.key" class="cm-submenu" role="menu">
              <button
                v-for="sub in item.submenu"
                :key="sub.key"
                class="cm-item"
                role="menuitem"
                :class="{ danger: sub.danger, disabled: sub.disabled }"
                @click="!sub.disabled && onSelect(sub.key)"
              >
                <span class="cm-label">{{ sub.label }}</span>
                <span v-if="sub.accelerator" class="cm-shortcut">{{ accelLabel(sub.accelerator) }}</span>
              </button>
            </div>
          </div>
          <button
            v-else
            class="cm-item"
            role="menuitem"
            :id="`cm-i-${i}`"
            :tabindex="navIdxOf(i) === activeIdx ? 0 : -1"
            :class="{ danger: item.danger, disabled: item.disabled, hl: navIdxOf(i) === activeIdx }"
            :aria-disabled="item.disabled || undefined"
            @click="!item.disabled && onSelect(item.key)"
          >
            <span class="cm-label">{{ item.label }}</span>
            <span v-if="item.accelerator" class="cm-shortcut">{{ accelLabel(item.accelerator) }}</span>
          </button>
        </template>
      </div>
    </template>
  </Teleport>
</template>

<style>
/* 非 scoped：Teleport body 浮层，cm- 前缀避免冲突。
 * 浏览器/dev 回退用的 CSS 模拟（桌面端走原生 Menu 不渲染此组件）。 */
.cm-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
}
.cm-menu {
  position: fixed;
  z-index: 1001;
  left: var(--cm-x);
  top: var(--cm-y);
  min-width: 200px;
  max-width: 320px;
  padding: 5px;
  border-radius: 8px;
  user-select: none;
  animation: clw-appear var(--dur-fast) var(--ease-out);
}
.cm-menu.flip-x {
  left: auto;
  right: calc(100vw - var(--cm-x));
}
.cm-menu.flip-y {
  top: auto;
  bottom: calc(100vh - var(--cm-y));
}
.cm-menu,
.cm-submenu {
  background: rgba(252, 252, 252, 0.75);
  backdrop-filter: blur(30px) saturate(1.5);
  -webkit-backdrop-filter: blur(30px) saturate(1.5);
  box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.1), 0 12px 44px rgba(0, 0, 0, 0.16);
}
[data-theme='dark'] .cm-menu,
[data-theme='dark'] .cm-submenu {
  background: rgba(38, 38, 38, 0.80);
  box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.08), 0 12px 44px rgba(0, 0, 0, 0.55);
}
.cm-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  width: 100%;
  text-align: left;
  padding: 4px 12px;
  font-size: var(--font-size-m);
  line-height: 18px;
  color: var(--text-normal);
  background: transparent;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
[data-theme='dark'] .cm-item {
  color: var(--text-normal);
}
.cm-item:hover {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
}
.cm-item.danger {
  color: var(--text-error);
}
[data-theme='dark'] .cm-item.danger {
  color: var(--text-error);
}
.cm-item.danger:hover {
  background: var(--text-error);
  color: var(--text-on-accent);
}
.cm-item.disabled {
  opacity: 0.35;
  pointer-events: none;
}
/* 重评2-P3-2：键盘高亮项（roving tabindex 焦点所在），与 hover 同视觉；danger 同款 */
.cm-item.hl {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
}
.cm-item.danger.hl {
  background: var(--text-error);
  color: var(--text-on-accent);
}
.cm-item:focus-visible {
  outline: none;
}
.cm-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cm-shortcut {
  flex-shrink: 0;
  opacity: 0.42;
  font-size: var(--font-size-s);
  font-variant-numeric: tabular-nums;
}
.cm-item:hover .cm-shortcut {
  opacity: 0.8;
}
.cm-sep {
  height: 1px;
  margin: 4px 10px;
  background: rgba(0, 0, 0, 0.08);
}
[data-theme='dark'] .cm-sep {
  background: rgba(255, 255, 255, 0.08);
}
.cm-sub-wrap {
  position: relative;
  padding-right: 4px;
}
.cm-has-sub {
  gap: 16px;
}
.cm-caret {
  font-size: var(--font-size-xxs);
  opacity: 0.4;
}
.cm-submenu {
  position: absolute;
  left: 100%;
  top: -5px;
  min-width: 160px;
  padding: 5px;
  margin-left: 4px;
  border-radius: 8px;
}
</style>
