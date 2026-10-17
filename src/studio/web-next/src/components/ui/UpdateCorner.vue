<script setup lang="ts">
// 更新角标（工作区左栏标题条，刷新目录按钮左侧）：安静时只剩一枚小图标——有小点=有新版本、环形=下载中、
// 小胶囊「重启更新」=包已就绪（点即重启，对齐 DSH 的「安装并重启」一步到位）、
// 警示图标=失败或「上次更新未完成」。点击出小弹层（详情/进度/按钮），
// 「忽略此版本」是弹层内的显式按钮——弹层右上角的叉只关弹层，两义不混。
//
// 挂点（单点）：工作区左栏标题条（SidebarLeft 的 .left-tabs），紧邻「刷新目录」左侧、与
// 刷新/收起按钮同组（间距取行 gap）——即「已进库的工作窗」的常驻面。引导页 / 书架窗 /
// 书库管理窗不挂；也不入 TabBar（那条属中栏，右端还与专注/右栏按钮、右栏顶栏、win 窗控
// 让位挤在同一角）。
// 状态与订阅都在 stores/update（组件按页挂卸，进度不随切页丢）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AlertTriangle, Download, Loader2, X } from 'lucide-vue-next'
import { useUpdateStore } from '../../stores/update'
import { isImeComposing } from '../../shared/ime'
import UpdateActions from './UpdateActions.vue'

const u = useUpdateStore()

/** 弹层定宽（视口夹取用；与 .uc-pop 的 width 一致） */
const POP_W = 300
/** 进度环几何（SVG 16×16，r=6.5） */
const RING_R = 6.5
const RING_C = 2 * Math.PI * RING_R

const chipRef = ref<HTMLElement | null>(null)
const popOpen = ref(false)
const popX = ref(0)
const popY = ref(0)

/** 角标形态：dot（有新版本）/ progress（下载中）/ ready（可一键重启）/ warn（失败或
 *  上次未完成）/ busy（正在退出并更新）；null = 不渲染（无更新且无结果条，或已忽略） */
const chipMode = computed<'dot' | 'progress' | 'ready' | 'warn' | 'busy' | null>(() => {
  if (!u.visible) return null
  switch (u.phase) {
    case 'downloading':
      return 'progress'
    case 'applying':
      return 'busy'
    case 'ready':
      return u.canInstall ? 'ready' : 'dot'
    case 'failed':
      return 'warn'
    default:
      return u.hasUpdate ? 'dot' : 'warn'
  }
})

/** 下载百分比（total 未知 = null → 环形转圈） */
const pct = computed(() => {
  const p = u.progress
  if (p?.total) return Math.min(100, Math.round((p.received / p.total) * 100))
  return null
})

const tipText = computed(() => {
  switch (chipMode.value) {
    case 'ready':
      return '重启后自动完成替换'
    case 'busy':
      return '正在退出并更新…'
    case 'progress':
      return pct.value !== null ? `下载中 ${pct.value}%` : '正在下载更新包'
    case 'warn':
      return u.phase === 'failed'
        ? (u.errorText ?? '更新失败（点开查看详情）')
        : (u.attemptText ?? '上次更新未完成（点开查看详情）')
    default:
      return u.latest ? `有新版本 v${u.latest.version}` : '更新提示'
  }
})

function syncPopPos(): void {
  const el = chipRef.value
  if (!el || !popOpen.value) return
  const r = el.getBoundingClientRect()
  // 左缘锚定角标左缘（弹层向右展开）：角标在左栏标题条内偏右（刷新按钮左侧），按右缘
  // 对齐会把弹层整体推到角标左侧之外、被 8px 下限夹成「钉窗口左角」，与角标脱钩。
  popX.value = Math.max(8, Math.min(r.left, window.innerWidth - POP_W - 8))
  popY.value = r.bottom + 6
}

function togglePop(): void {
  if (popOpen.value) {
    popOpen.value = false
    return
  }
  u.resetCopied()
  popOpen.value = true
  syncPopPos()
}

function onChipClick(): void {
  // 就绪态一步到位：点击即带意图重启（退出被取消会收到广播回到就绪，不丢包）
  if (chipMode.value === 'ready') {
    void u.applyUpdate()
    return
  }
  togglePop()
}

function onDocClick(e: MouseEvent): void {
  if (!popOpen.value) return
  const t = e.target as HTMLElement
  if (!t.closest('.uc-pop') && !t.closest('.uc-chip')) popOpen.value = false
}

function onDocKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && popOpen.value) {
    // IME 组合期 Esc 让渡输入法（isImeComposing 单源判据，对齐 TabBar/SettingsModal 先例）
    if (isImeComposing(e)) return
    e.preventDefault()
    popOpen.value = false
    chipRef.value?.focus()
  }
}

/** 角标隐去（忽略/清掉结果条）时弹层不悬空；形态变化改角标矩形（就绪胶囊 22px 高
 *  ⟷ 图标 26px 高，底边差 2px），弹层开着时须按新几何重锚（否则顶边锚在旧底边上）。 */
watch(chipMode, (m) => {
  if (!m) popOpen.value = false
  else if (popOpen.value) void nextTick(syncPopPos)
})

onMounted(() => {
  u.ensureInit()
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onDocKeydown)
  window.addEventListener('resize', syncPopPos, { passive: true })
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onDocKeydown)
  window.removeEventListener('resize', syncPopPos)
})
</script>

<template>
  <button
    v-if="chipMode"
    ref="chipRef"
    class="uc-chip"
    :class="`uc-${chipMode}`"
    :data-tip="tipText"
    data-tip-dir="bottom"
    @click="onChipClick"
  >
    <span v-if="chipMode === 'ready'" class="uc-ready-label">重启更新</span>
    <Loader2 v-else-if="chipMode === 'busy'" :size="16" class="uc-ic spin" />
    <svg
      v-else-if="chipMode === 'progress'"
      class="uc-ring"
      :class="{ spin: pct === null }"
      viewBox="0 0 16 16"
      width="16"
      height="16"
    >
      <circle class="uc-ring-track" cx="8" cy="8" :r="RING_R" fill="none" stroke-width="2" />
      <circle
        class="uc-ring-arc"
        cx="8"
        cy="8"
        :r="RING_R"
        fill="none"
        stroke-width="2"
        :stroke-dasharray="pct === null ? `10 ${RING_C - 10}` : `${(pct / 100) * RING_C} ${RING_C}`"
        transform="rotate(-90 8 8)"
      />
    </svg>
    <AlertTriangle v-else-if="chipMode === 'warn'" :size="16" class="uc-ic uc-warn-ic" />
    <template v-else>
      <Download :size="16" class="uc-ic" />
      <!-- 指示点类名**不得**与形态类同名（uc-dot）：同名时按钮自己吃下
           「absolute + top/right 3px + 6px 见方」，角标被钉到容器右上角 6px 小格 -->
      <span class="uc-badge" />
    </template>
  </button>
  <Teleport to="body">
    <div v-if="popOpen && chipMode" class="uc-pop" :style="{ left: popX + 'px', top: popY + 'px' }">
      <div class="uc-pop-head">
        <span class="uc-pop-title">{{ u.latest ? `有新版本 v${u.latest.version}` : '更新提示' }}</span>
        <button class="uc-pop-close" title="关闭" aria-label="关闭" @click="popOpen = false">
          <X :size="14" />
        </button>
      </div>
      <UpdateActions />
    </div>
  </Teleport>
</template>

<style scoped>
.uc-chip {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--size-control);
  height: var(--size-control);
  padding: 0;
  border: none;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-icon);
  cursor: pointer;
  -webkit-app-region: no-drag;
}
.uc-chip:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.uc-ic {
  flex-shrink: 0;
}
/* 有新版本：图标右上角一枚强调色小点（安静但有指示）。
 * 类名是 .uc-badge 不是 .uc-dot——「点」形态类名就叫 uc-dot，同名会让按钮
 * 自己命中本规则（实测：角标被定成容器右上角 6px 绝对定位小格）。 */
.uc-badge {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-accent);
}
/* 就绪：小胶囊（点即重启） */
.uc-ready {
  width: auto;
  height: 22px;
  padding: 0 10px;
  border-radius: 999px;
  background: var(--interactive-accent);
  color: var(--text-on-accent);
}
.uc-ready:hover {
  background: var(--interactive-accent-hover);
  color: var(--text-on-accent);
}
.uc-ready-label {
  font-size: var(--font-size-xs);
  font-weight: 600;
  white-space: nowrap;
}
/* 失败/上次未完成：警示色图标（hover 仍走 .uc-chip 底） */
.uc-warn-ic {
  color: var(--text-warning);
}
/* 进度环（.spin 走全局 utilities.css 单源；total 未知时转圈） */
.uc-ring {
  flex-shrink: 0;
}
.uc-ring-track {
  stroke: var(--background-modifier-border);
}
.uc-ring-arc {
  stroke: var(--text-accent);
  stroke-linecap: round;
}
/* 弹层（Teleport 到 body，左缘锚定角标左缘、贴其下方；z 与 TabBar 新建下拉同档） */
.uc-pop {
  position: fixed;
  z-index: 1000;
  width: 300px;
  padding: var(--size-4-3);
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-m);
}
.uc-pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--size-4-2);
}
.uc-pop-title {
  font-size: var(--font-size-m);
  font-weight: 600;
  color: var(--text-normal);
}
.uc-pop-close {
  flex: none;
  display: flex;
  align-items: center;
  padding: 3px;
  border: none;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.uc-pop-close:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
</style>
