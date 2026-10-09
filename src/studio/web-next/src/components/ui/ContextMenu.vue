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

// 2-：浏览器回退菜单键盘导航（照 FontPicker
// 的 roving tabindex 搭法）——原 role="menu" 面仅 Esc 可用，无方向键导航，
// 纯键盘用户进不了任何菜单项。开启即把焦点移入首项，↑/↓ 循环、Home/End 首尾、
// Enter/Space 激活、Tab 自然走焦关闭、关闭还焦右键来源；容器另挂 aria-activedescendant
//（roving 焦点在项上时为冗余保险，焦点若落容器 AT 也能命中高亮项）。桌面端走 Electron
// 原生 Menu 不渲染本组件，不受影响。
// 飞出层（子菜单）键盘可达（原「hover 唯一可达」登记随本实现闭合）：→ 于父项展开并聚焦
// 层内首项（无子菜单不响应、不消费）；层内 ← 收层还焦父项、↑/↓ 循环、Home/End 首尾、
// Enter/Space 激活子项；Esc 在层内只收层（关整菜单只在顶层）。层界 = subActiveIdx >= 0
//（-1 = 键盘在顶层；hover/Enter 只开层不入层，进层走 →）；顶层位移（↑/↓/Home/End）后
// 高亮离开父项即收层——原生菜单惯例，防 hl 与展开层错位。
// 两路径让位规则：指针换父项时键盘层退场（高亮随指针落到新父项，→ 即可接管该层）；
// 键盘已入层时 hover 离场收层但焦点还父项——鼠标擦过不得把焦点丢给已卸载的层（body）。
// 层内落焦须待 v-if 渲染一拍（nextTick）——层已展开（hover 路径）时同拍即落。
// 原挂账锚 = 总览 §三「已登记开放项」（触发条件＝浏览器版转正），由作者随批清行。
/** 键盘高亮项在 navItems 中的序；-1 = 未初始化 */
const activeIdx = ref(-1)
/** 键盘高亮项在 subNavItems 中的序；-1 = 键盘在顶层（层已展开但未进层时也是 -1） */
const subActiveIdx = ref(-1)
/** 顶层可导航项（跳过分隔线；idx = props.items 下标，供 id/aria 对应） */
const navItems = computed(() => props.items.map((item, idx) => ({ item, idx })).filter((e) => !e.item.separator))
/** 当前展开飞出层的可导航子项（跳过分隔线；idx = 该子菜单下标，供 id 对应）。
 *  同一时刻至多一层展开（v-if openSub）——id 用 cm-s-{子菜单下标} 不会跨层撞号。 */
const subNavItems = computed(() => {
  const parent = props.items.find((it) => it.key === openSub.value)
  if (!parent?.submenu) return []
  return parent.submenu.map((item, idx) => ({ item, idx })).filter((e) => !e.item.separator)
})
/** aria-activedescendant 指向的高亮项 id（与模板 cm-i-{items 下标} / cm-s-{子菜单下标} 对应）。
 *  键盘在层内时指向子项——子项同为 .cm-menu 的 DOM 后裔，引用不越界（aria 只要求后裔关系）。 */
const activeId = computed(() => {
  if (subActiveIdx.value >= 0) {
    const se = subNavItems.value[subActiveIdx.value]
    return se ? `cm-s-${se.idx}` : undefined
  }
  const e = navItems.value[activeIdx.value]
  return e ? `cm-i-${e.idx}` : undefined
})
/** 打开前焦点元素（关闭时还焦右键来源——FontPicker 「还焦触发钮」同语义） */
let prevFocus: HTMLElement | null = null

/** 顶层项导航序（props.items 下标 → 非分隔项序，模板 tabindex/.hl 用；菜单项极少 O(n) 直查） */
function navIdxOf(itemsIdx: number): number {
  return navItems.value.findIndex((e) => e.idx === itemsIdx)
}
/** 飞出层项导航序（子菜单下标 → 非分隔项序，模板 tabindex/.hl 用；同款直查） */
function subIdxOf(subItemsIdx: number): number {
  return subNavItems.value.findIndex((e) => e.idx === subItemsIdx)
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
/** 焦点移到飞出层高亮项（层内 .cm-item DOM 序与 subNavItems 一一对应＝分隔线不渲染 .cm-item；
 *  层未渲染时 no-op——调用方按需另补一拍 nextTick） */
function focusSubActive(): void {
  const el = menuEl.value
  if (!el) return
  const items = el.querySelectorAll<HTMLElement>('.cm-submenu .cm-item')
  if (items.length === 0) return
  const idx = Math.min(Math.max(subActiveIdx.value, 0), items.length - 1)
  items[idx]?.focus()
}
/** ↑/↓ 循环步进（FontPicker moveActive 同款）；顶层位移后按需收层 */
function moveActive(delta: 1 | -1): void {
  const n = navItems.value.length
  if (n === 0) return
  const cur = activeIdx.value < 0 ? (delta > 0 ? -1 : 0) : activeIdx.value
  activeIdx.value = (cur + delta + n) % n
  dropSubIfLeft()
  focusActive()
}
/** 飞出层 ↑/↓ 循环步进（moveActive 同款，限于层内；层内高亮不进顶层序） */
function moveSubActive(delta: 1 | -1): void {
  const n = subNavItems.value.length
  if (n === 0) return
  const cur = subActiveIdx.value < 0 ? (delta > 0 ? -1 : 0) : subActiveIdx.value
  subActiveIdx.value = (cur + delta + n) % n
  focusSubActive()
}
/** 顶层位移后收层：新高亮不是展开层父项即收（原生菜单惯例，防 hl 在别项而旧飞出层仍挂）。
 *  仅在键盘处于顶层时调用（层内位移走 moveSubActive，不经此）。 */
function dropSubIfLeft(): void {
  if (openSub.value !== null && navItems.value[activeIdx.value]?.item.key !== openSub.value) {
    openSub.value = null
  }
}
/** Home/End 直达：按当前焦点层分派（层内动层内高亮、顶层动顶层高亮，互不改写对方序） */
function moveEdge(toFirst: boolean): void {
  if (subActiveIdx.value >= 0) {
    const n = subNavItems.value.length
    if (n === 0) return
    subActiveIdx.value = toFirst ? 0 : n - 1
    focusSubActive()
    return
  }
  const n = navItems.value.length
  if (n === 0) return
  activeIdx.value = toFirst ? 0 : n - 1
  dropSubIfLeft()
  focusActive()
}
/** →：展开当前父项飞出层并聚焦层内首项；无子菜单不响应（返回 false 供调用方决定是否消费键）。
 *  键盘首开层待 v-if 渲染一拍，故落焦双保险：同拍（hover 已展开时即生效）+ 过拍补落。 */
function openSubLayer(): boolean {
  const e = navItems.value[Math.max(activeIdx.value, 0)]
  if (!e?.item.submenu || e.item.submenu.length === 0) return false
  openSub.value = e.item.key
  subActiveIdx.value = 0
  focusSubActive()
  void nextTick(focusSubActive)
  return true
}
/** 收飞出层并还焦父项（← / 层内 Esc / Enter 再按收层）；顶层 roving 高亮始终停在父项，直接重落即可 */
function closeSubLayer(): void {
  openSub.value = null
  subActiveIdx.value = -1
  focusActive()
}
/** Enter/Space 激活高亮项：层内激活子项；顶层普通项选中关闭、子菜单父项开/收飞出层；
 *  disabled 可聚焦不可激活（顶层 disabled 父项仍可开层——沿既有 Enter 语义原样保留） */
function activateActive(): void {
  if (subActiveIdx.value >= 0) {
    const se = subNavItems.value[subActiveIdx.value]
    if (!se || se.item.disabled) return
    onSelect(se.item.key)
    return
  }
  const e = navItems.value[Math.max(activeIdx.value, 0)]
  if (!e) return
  if (e.item.submenu) {
    if (openSub.value === e.item.key) {
      closeSubLayer() // 再按收层（焦点落回父项本身，不关整菜单、不上抛 select）
      return
    }
    openSub.value = e.item.key // 只开层不入层——进层走 →（原 Enter 语义不变）
    return
  }
  if (e.item.disabled) return
  onSelect(e.item.key)
}
/** 父项 hover 展开；指针落到父项即把 roving 高亮/焦点收到该项（键盘可从指针处续走，
 *  → 即接管该层）。换父项时键盘层退场；旧层若已被卸载，此处的落焦同时把焦点救回菜单内。 */
function onSubEnter(key: string, itemsIdx: number): void {
  if (openSub.value === key) return // 同父项重进：层与键盘态都保留（键盘接管后指针擦过不夺层）
  openSub.value = key
  subActiveIdx.value = -1
  const ni = navIdxOf(itemsIdx)
  if (ni >= 0) activeIdx.value = ni
  focusActive()
}
/** 父项 hover 离场收层；键盘已入层时收层须还焦父项——鼠标擦过不得把焦点丢给已卸载的层 */
function onSubLeave(key: string): void {
  if (openSub.value !== key) return
  if (subActiveIdx.value >= 0) closeSubLayer()
  else openSub.value = null
}

/** Electron accelerator → 平台可读文本（"CmdOrCtrl+X" → mac "⌘X" / win·linux "Ctrl+X"）。
 * 原无条件映射 ⌘，win 浏览器/dev 回退菜单显示 mac 符号。
 * 平台探测三级兜底——navigator.userAgentData?.platform 是
 *  Chromium-only API，老 WebView/非 Chromium 内核无该成员；其后回落 navigator.platform
 *  （已废弃但覆盖面广），再回落 navigator.userAgent 字符串嗅探，探测不再单源落空。 */
function isMacPlatform(): boolean {
  const uad = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
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

/** 视口溢出翻转测量（开启拍与 resize 跟随共用单源；调用前须已复位 flip 并过一拍渲染） */
function measureFlip(): void {
  const el = menuEl.value
  if (!el || !props.visible) return
  const r = el.getBoundingClientRect()
  if (props.x + r.width > window.innerWidth - 8) flipX.value = true
  if (props.y + r.height > window.innerHeight - 8) flipY.value = true
}

/** 窗口 resize 跟随重算——原只在开启一刻快照判 flip，
 *  此后视口缩小时溢出态不重判（菜单探出屏幕外）；关闭态 no-op。复位→过拍→测量
 *  与开启拍同序（watch 内联保持原时序不抽函数——async 函数包装会多一跳微任务，
 *  把 activeIdx 赋值推出调用方的 nextTick 预算，re2-roving 用例实证）。 */
async function recomputeFlip(): Promise<void> {
  if (!props.visible) return
  flipX.value = false
  flipY.value = false
  await nextTick()
  measureFlip()
}

watch(
  () => props.visible,
  async (v) => {
    if (!v) {
      // 2-：关闭收尾——菜单会话仍持有焦点（焦点在菜单内/已落 body）时还焦
      // 右键来源，防焦点丢在已卸载的菜单上；他处焦点不动（parent 主动关窗等场景）
      const menu = menuEl.value
      const cur = document.activeElement
      if (prevFocus && (cur === null || cur === document.body || (menu !== undefined && menu.contains(cur)))) {
        prevFocus.focus()
      }
      prevFocus = null
      activeIdx.value = -1
      subActiveIdx.value = -1
      openSub.value = null
      return
    }
    prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    flipX.value = false
    flipY.value = false
    await nextTick()
    measureFlip()
    // 2-：开启即把键盘焦点移入首项（roving tabindex；与 flip 复位同一拍完成）；
    // 层界归顶层——上一会话残留的层内高亮不得带进新会话
    activeIdx.value = navItems.value.length > 0 ? 0 : -1
    subActiveIdx.value = -1
    focusActive()
  },
)

function onKey(e: KeyboardEvent): void {
  if (!props.visible) return // 菜单未开不消费——Esc 落到 useHotkeys
  if (e.key === 'Escape') {
    // 层内 Esc 先收飞出层（还焦父项，菜单不关）；顶层 Esc 关整菜单
    if (subActiveIdx.value >= 0) closeSubLayer()
    else emit('close')
    e.preventDefault() // 本层消费 Esc，防同键退专注双效
    return
  }
  // 2-：方向键/Home/End/Enter/Space roving 导航（顶层与飞出层分层，层界 = subActiveIdx）；
  // IME 组合期让渡输入法（FontPicker 同口径）；Tab 不消费仅关闭，焦点走自然次序
  if (isImeComposing(e)) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (subActiveIdx.value >= 0) moveSubActive(1)
    else moveActive(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (subActiveIdx.value >= 0) moveSubActive(-1)
    else moveActive(-1)
  } else if (e.key === 'ArrowRight') {
    // →：父项展开并聚焦层内首项；无子菜单不响应、不消费（层内无更深层，亦不响应）
    if (subActiveIdx.value < 0 && openSubLayer()) e.preventDefault()
  } else if (e.key === 'ArrowLeft') {
    // ←：已展开即收层还焦父项（键盘未入层——hover 开的层——也收，同「后退一层」语义）；
    // 顶层无层可收则不响应、不消费
    if (openSub.value !== null) {
      e.preventDefault()
      closeSubLayer()
    }
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault()
    moveEdge(e.key === 'Home')
  } else if (e.key === 'Enter' || e.key === ' ') {
    // keydown 期 preventDefault 截停原生按钮激活（无原生 click），激活只走 activateActive 防双触发
    e.preventDefault()
    activateActive()
  } else if (e.key === 'Tab') {
    emit('close')
  }
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', recomputeFlip, { passive: true })
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', recomputeFlip)
})

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
            @mouseenter="onSubEnter(item.key, i)"
            @mouseleave="onSubLeave(item.key)"
          >
            <!-- 2-：顶层项 roving tabindex（高亮项 0 其余 -1）+ id 供 aria-activedescendant -->
            <button
              class="cm-item cm-has-sub"
              role="menuitem"
              :id="`cm-i-${i}`"
              :tabindex="navIdxOf(i) === activeIdx ? 0 : -1"
              :class="{ hl: navIdxOf(i) === activeIdx }"
              :aria-disabled="item.disabled || undefined"
              aria-haspopup="menu"
              :aria-expanded="openSub === item.key"
            >
              <span class="cm-label">{{ item.label }}</span>
              <span class="cm-caret">▸</span>
            </button>
            <!-- 飞出层：hover（mouseenter）与键盘（→ 进层 / ← Esc 收层）共用同一 openSub 开关 -->
            <div v-if="openSub === item.key" class="cm-submenu" role="menu">
              <template v-for="(sub, j) in item.submenu" :key="sub.key || `sub-sep-${j}`">
                <div v-if="sub.separator" class="cm-sep" role="separator"></div>
                <!-- 层内 roving tabindex + id（cm-s-{子菜单下标}，单层展开故不撞号）供 aria-activedescendant -->
                <button
                  v-else
                  class="cm-item"
                  role="menuitem"
                  :id="`cm-s-${j}`"
                  :tabindex="subIdxOf(j) === subActiveIdx ? 0 : -1"
                  :class="{ danger: sub.danger, disabled: sub.disabled, hl: subIdxOf(j) === subActiveIdx }"
                  :aria-disabled="sub.disabled || undefined"
                  @click="!sub.disabled && onSelect(sub.key)"
                >
                  <span class="cm-label">{{ sub.label }}</span>
                  <span v-if="sub.accelerator" class="cm-shortcut">{{ accelLabel(sub.accelerator) }}</span>
                </button>
              </template>
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
/* 遮罩为纯点击捕获（透明、无背景浓度），有意不并入 ModalMask：并入会引入全屏变暗
   并登记为 overlay（改 ⌘P/Esc 让渡语义）；z-index 1000 须高于应用内 modal-mask(150)。 */
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
  box-shadow:
    0 0 0 0.5px rgba(0, 0, 0, 0.1),
    0 12px 44px rgba(0, 0, 0, 0.16);
}
[data-theme='dark'] .cm-menu,
[data-theme='dark'] .cm-submenu {
  background: rgba(38, 38, 38, 0.8);
  box-shadow:
    0 0 0 0.5px rgba(255, 255, 255, 0.08),
    0 12px 44px rgba(0, 0, 0, 0.55);
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
/* 2-：键盘高亮项（roving tabindex 焦点所在），与 hover 同视觉；danger 同款 */
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
  /* 悬停闪关根因——旧 margin-left:4px 把子菜单推出
   * .cm-sub-wrap 边界之外：指针从父项滑向子菜单必经 4px 真空带 → mouseleave 触发
   * openSub=null（子菜单同拍卸载），再进入时已无处可悬。贴 wrap 右缘后该 4px 视觉
   * 间隙由 wrap 的 padding-right 承载（仍在悬停热区内），外观不变、真空带消除。 */
  border-radius: 8px;
}
</style>
