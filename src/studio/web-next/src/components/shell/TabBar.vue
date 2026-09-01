<script setup lang="ts">
// 顶栏操作条：新建按钮（split：主钮=新建正文，caret=下拉新建大纲/设定）
//   + 左栏/右栏/专注按钮（标签页已移除，单文档模式）。
// 新建信号通过 workspace store createTick 触发 ChapterTreePanel 执行。
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { FilePlus, ChevronDown, Focus, PanelRight, PanelLeft } from 'lucide-vue-next'
import { useWorkspaceStore, type CreateKind } from '../../stores/workspace'
import { useTreeStore } from '../../stores/tree'
import { usePlatform } from '../../composables/usePlatform'

defineProps<{ bookName: string }>()
const ws = useWorkspaceStore()
const tree = useTreeStore()
const { isDesktop, isMac, isWin } = usePlatform()
// 左栏可见性（含专注模式覆盖）：关闭/专注时 ws-main 左移到交通灯区，lead 需避让
const leftVisible = computed(() => ws.leftOpen && !ws.focusMode)
// 右栏可见性：关闭时 tabbar-actions 贴窗口右上角，需避让 win 窗控 overlay（J5）；
// 打开时贴角的是右栏自己的 right-topbar（其组件内自行避让），此处避让反而把专注
// 按钮推离栏缘（2026-08-29 作者反馈「专注按钮位置有问题」根因）
const rightVisible = computed(() => ws.rightOpen && !ws.focusMode)

// --- 新建下拉菜单（split button caret）---
const dropdownOpen = ref(false)
const dropX = ref(0)
const dropY = ref(0)
const caretRef = ref<HTMLElement | null>(null)
// 总纲/世界观为全书唯一单文件：存在则菜单文案改「打开」
const hasSynopsis = computed(() => !!tree.byPath.get('大纲/总纲.md'))
const hasWorldview = computed(() => !!tree.byPath.get('设定/世界观.md'))

function toggleDropdown(): void {
  if (dropdownOpen.value) {
    dropdownOpen.value = false
    return
  }
  const el = caretRef.value
  if (el) {
    const r = el.getBoundingClientRect()
    dropX.value = r.left
    dropY.value = r.bottom + 4
  }
  dropdownOpen.value = true
}
function pick(kind: CreateKind): void {
  dropdownOpen.value = false
  ws.triggerCreate(kind)
}
function onDocClick(e: MouseEvent): void {
  if (!dropdownOpen.value) return
  const t = e.target as HTMLElement
  if (!t.closest('.new-dropdown') && !t.closest('.tb-caret')) dropdownOpen.value = false
}
function onDocKeydown(e: KeyboardEvent): void {
  // R33-90（三十三轮）：新建下拉补 Esc 关闭路径（原只能点击外部关闭，键盘不可达）
  if (e.key === 'Escape' && dropdownOpen.value) {
    e.preventDefault()
    dropdownOpen.value = false
    caretRef.value?.focus()
  }
}
onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onDocKeydown)
})
onUnmounted(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onDocKeydown)
})
</script>

<template>
  <div
    class="tabbar"
    :class="{ 'is-drag': isDesktop, 'avoid-traffic': isMac && !leftVisible, 'avoid-wco': isWin && !rightVisible }"
  >
    <!-- 最左 lead 区：新建按钮（split）+ 展开左栏（条件） -->
    <div class="tabbar-lead">
      <div class="tb-split">
        <button
          class="tb-btn tb-btn-main"
          data-tip="新建正文" data-tip-dir="bottom"
          @click="ws.triggerCreate('chapter')"
        >
          <FilePlus :size="17" :stroke-width="1.6" />
        </button>
        <button
          ref="caretRef"
          class="tb-btn tb-caret"
          :class="{ active: dropdownOpen }"
          data-tip="新建…" data-tip-dir="bottom"
          @click.stop="toggleDropdown"
        >
          <ChevronDown :size="17" :stroke-width="1.6" />
        </button>
      </div>
      <button
        v-if="!ws.leftOpen"
        class="tb-btn"
        data-tip="展开左栏" data-tip-dir="bottom"
        @click="ws.toggleLeft()"
      >
        <PanelLeft :size="17" :stroke-width="1.6" />
      </button>
    </div>
    <div class="tabbar-spacer" />
    <div class="tabbar-actions">
      <button
        class="tb-btn"
        :class="{ active: ws.focusMode }"
        :data-tip="ws.focusMode ? '退出专注（⌘⇧F）' : '专注模式（⌘⇧F）'"
        data-tip-dir="bottom"
        @click="ws.toggleFocus()"
      >
        <Focus :size="17" :stroke-width="1.6" />
      </button>
      <button
        v-show="!ws.rightOpen"
        class="tb-btn"
        data-tip="展开右栏" data-tip-dir="bottom"
        @click="ws.toggleRight()"
      >
        <PanelRight :size="17" :stroke-width="1.6" />
      </button>
    </div>
    <!-- 下拉菜单（Teleport 到 body 脱离 tabbar overflow:hidden 裁剪） -->
    <Teleport to="body">
      <div
        v-if="dropdownOpen"
        class="new-dropdown"
        :style="{ left: dropX + 'px', top: dropY + 'px' }"
      >
        <button class="dd-item" @click="pick('chapter')">正文章节</button>
        <div class="dd-sep">大纲</div>
        <button class="dd-item" @click="pick('chapter-outline')">章纲</button>
        <button class="dd-item" @click="pick('volume-outline')">卷纲</button>
        <button class="dd-item" @click="pick('synopsis')">{{ hasSynopsis ? '打开总纲' : '新建总纲' }}</button>
        <div class="dd-sep">设定</div>
        <button class="dd-item" @click="pick('character')">角色</button>
        <button class="dd-item" @click="pick('item')">物品</button>
        <button class="dd-item" @click="pick('foreshadow')">伏笔</button>
        <button class="dd-item" @click="pick('worldview')">{{ hasWorldview ? '打开世界观' : '新建世界观' }}</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.tabbar {
  min-height: var(--size-tabbar);
  display: flex;
  align-items: stretch;
  background: var(--tab-container-background);
  border-bottom: 1px solid var(--background-modifier-border);
  overflow: hidden;
}
/* 桌面版：空白区可拖动整窗（按钮本身可点） */
.tabbar.is-drag {
  -webkit-app-region: drag;
}
/* 桌面版交通灯避让：左栏关闭或专注模式时，lead 区整体右移 52px */
.tabbar.avoid-traffic .tabbar-lead {
  padding-left: 52px;
}
/* 弹性占位区（撑满中间空白，桌面版作为窗口拖拽区） */
.tabbar-spacer {
  flex: 1;
  min-width: 0;
}
/* 最左 lead 区：新建 + 展开左栏。垂直居中；左侧 padding 归零——新建图标在按钮内
 * 距左缘 5px，若再叠加 lead padding 会使「窗沿→图标 12px ≠ 图标→竖线 5px」右侧
 * 显得贴线（2026-08-31 作者反馈），归零后两侧各 5px 对称 */
.tabbar-lead {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 var(--size-4-2) 0 0;
}
.tabbar-lead .tb-btn {
  -webkit-app-region: no-drag;
}
/* 右侧固定按钮区（展开右栏 + 专注）——始终钉在最右 */
.tabbar-actions {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 var(--size-4-2);
}
/* J5（win 体验面）：右栏关闭时本栏贴窗口右上角，让位 WCO 系统窗控。宽度由
 * env(titlebar-area-*) 注入（Chromium 在 WCO 窗口提供；非 win/浏览器/mac
 * hiddenInset 回退 100vw/0px → padding 0）+ 12px 呼吸间隙（实测 env 恰好贴住
 * 窗控命中区，不留隙即重叠）。右栏打开时不挂类（贴角的是 right-topbar，避让
 * 在其组件内）——否则专注按钮被无谓推离栏缘（作者反馈根因）。 */
.tabbar.avoid-wco .tabbar-actions {
  padding-right: calc(100vw - env(titlebar-area-width, 100vw) - env(titlebar-area-x, 0px) + var(--size-4-3));
}
.tabbar-actions .tb-btn {
  -webkit-app-region: no-drag;
}
.tb-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--size-control);
  height: var(--size-control);
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-icon);
  border-radius: var(--radius-s);
  cursor: pointer;
}
.tb-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
/* 图标按名义尺寸等比渲染：.tb-btn 默认 button padding(≈1px 6px)在窄钮(如 caret 22px)
 * 里会把 16px 图标 flex-shrink 压到内容盒宽，viewBox 被横向拉伸、描边畸变发糊 */
.tb-btn svg {
  flex-shrink: 0;
}
.tb-btn.active {
  color: var(--text-accent);
}
/* split button：主钮（新建正文）+ caret（出下拉） */
.tb-split {
  display: flex;
  align-items: center;
}
.tb-btn-main {
  border-radius: var(--radius-s) 0 0 var(--radius-s);
}
.tb-caret {
  position: relative;
  width: 22px;
  border-radius: 0 var(--radius-s) var(--radius-s) 0;
  color: var(--text-muted);
}
/* 主钮与箭头间的短分割线（居中细竖线，不顶天立地） */
.tb-caret::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 1px;
  height: 14px;
  background: var(--background-modifier-border);
}
.tb-caret.active {
  background: var(--background-modifier-hover);
  color: var(--text-accent);
}
/* 新建下拉菜单 */
.new-dropdown {
  position: fixed;
  z-index: 1000;
  min-width: 148px;
  padding: 4px;
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.18);
}
.dd-item {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 5px 10px;
  border: none;
  background: transparent;
  color: var(--text-normal);
  font-size: var(--font-size-m);
  border-radius: var(--radius-s);
  cursor: pointer;
  text-align: left;
}
.dd-item:hover {
  background: var(--background-modifier-hover);
  color: var(--text-accent);
}
.dd-sep {
  padding: 7px 10px 3px;
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  letter-spacing: 0.04em;
  user-select: none;
}
</style>
