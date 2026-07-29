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
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'

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

/** Electron accelerator → macOS 可读文本（"CmdOrCtrl+X" → "⌘X"） */
function accelLabel(accel?: string): string {
  if (!accel) return ''
  return accel
    .replace(/CmdOrCtrl\+/g, '⌘')
    .replace(/Shift\+/g, '⇧')
    .replace(/Alt\+/g, '⌥')
}

watch(
  () => props.visible,
  async (v) => {
    if (!v) {
      openSub.value = null
      return
    }
    flipX.value = false
    flipY.value = false
    await nextTick()
    const el = menuEl.value
    if (!el) return
    const r = el.getBoundingClientRect()
    if (props.x + r.width > window.innerWidth - 8) flipX.value = true
    if (props.y + r.height > window.innerHeight - 8) flipY.value = true
  },
)

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
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
        :class="{ 'flip-x': flipX, 'flip-y': flipY }"
        :style="{ '--cm-x': x + 'px', '--cm-y': y + 'px' }"
        @click.stop
        @contextmenu.prevent.stop
      >
        <template v-for="(item, i) in items" :key="item.key || `sep-${i}`">
          <div v-if="item.separator" class="cm-sep"></div>
          <div
            v-else-if="item.submenu"
            class="cm-sub-wrap"
            @mouseenter="openSub = item.key"
            @mouseleave="openSub = null"
          >
            <button class="cm-item cm-has-sub">
              <span class="cm-label">{{ item.label }}</span>
              <span class="cm-caret">▸</span>
            </button>
            <div v-if="openSub === item.key" class="cm-submenu">
              <button
                v-for="sub in item.submenu"
                :key="sub.key"
                class="cm-item"
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
            :class="{ danger: item.danger, disabled: item.disabled }"
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
  font-size: 13px;
  line-height: 18px;
  color: #1d1d1f;
  background: transparent;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
[data-theme='dark'] .cm-item {
  color: #e5e5e7;
}
.cm-item:hover {
  background: #0a84ff;
  color: #fff;
}
.cm-item.danger {
  color: #d63031;
}
[data-theme='dark'] .cm-item.danger {
  color: #ff6b6b;
}
.cm-item.danger:hover {
  background: #d63031;
  color: #fff;
}
.cm-item.disabled {
  opacity: 0.35;
  pointer-events: none;
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
  font-size: 12px;
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
  font-size: 10px;
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
