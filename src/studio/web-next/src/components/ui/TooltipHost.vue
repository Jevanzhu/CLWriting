<script setup lang="ts">
// 全局 tooltip 宿主（Teleport to body）：监听 mouseover 检查 [data-tip]，
// fixed 定位显示——不受任何 overflow:hidden/auto 容器裁切。
// 解决 CSS ::after 在 .tabbar(overflow-y:hidden) / .right-body(overflow:auto) 等
// 容器内被裁切的问题。方向 + 边缘检测自动避让视口边界。
import { ref, onMounted, onBeforeUnmount } from 'vue'

interface TipState { text: string; x: number; y: number; dir: string }

const tip = ref<TipState | null>(null)
let showTimer: ReturnType<typeof setTimeout> | null = null
let lastTarget: HTMLElement | null = null

function hide(): void {
  if (showTimer) {
    clearTimeout(showTimer)
    showTimer = null
  }
  tip.value = null
  lastTarget = null
}

function onOver(e: MouseEvent): void {
  const el = (e.target as HTMLElement)?.closest?.('[data-tip]') as HTMLElement | null
  if (el === lastTarget) return
  if (!el || !el.dataset.tip) {
    hide()
    return
  }
  lastTarget = el
  // P2-F6b：data-tip 同时暴露为 aria-label（读屏可读）。已有 aria-label 不覆盖。
  syncAriaLabel(el)
  if (showTimer) clearTimeout(showTimer)
  showTimer = setTimeout(() => {
    const text = el.dataset.tip!
    const dir = el.dataset.tipDir || 'top'
    const r = el.getBoundingClientRect()
    // 预估 tooltip 尺寸（font-size-s≈12px，中文每字约 13px + padding 16px；高约 24px）
    const tw = text.length * 13 + 16
    const th = 26
    const vw = window.innerWidth
    const vh = window.innerHeight
    let x = r.left + r.width / 2
    let y = r.top
    let actualDir = dir
    if (dir === 'bottom') {
      y = r.bottom + 6
    } else if (dir === 'right') {
      x = r.right + 10
      y = r.top + r.height / 2
    } else if (dir === 'left') {
      x = r.left - 10
      y = r.top + r.height / 2
    } else {
      // top（默认）
      if (r.top - th - 6 < 8) {
        // 上方空间不足，翻转为 bottom
        y = r.bottom + 6
        actualDir = 'bottom'
      } else {
        y = r.top - 6
      }
    }
    // 水平边缘检测（居中方向 top/bottom）：避免溢出视口左右
    if (actualDir === 'top' || actualDir === 'bottom') {
      if (x - tw / 2 < 8) x = tw / 2 + 8
      if (x + tw / 2 > vw - 8) x = vw - tw / 2 - 8
    }
    // 垂直边缘检测（居中方向 left/right）：避免溢出视口上下
    if (actualDir === 'left' || actualDir === 'right') {
      if (y - th / 2 < 8) y = th / 2 + 8
      if (y + th / 2 > vh - 8) y = vh - th / 2 - 8
    }
    tip.value = { text, x, y, dir: actualDir }
  }, 250)
}

/** 同步 data-tip → aria-label（P2-F6b：读屏可读）。已有 aria-label 不覆盖。 */
function syncAriaLabel(el: HTMLElement): void {
  if (!el.getAttribute('aria-label') && el.dataset.tip) {
    el.setAttribute('aria-label', el.dataset.tip)
  }
}

function onFocusIn(e: FocusEvent): void {
  const el = (e.target as HTMLElement)?.closest?.('[data-tip]') as HTMLElement | null
  if (el) syncAriaLabel(el)
}

onMounted(() => {
  document.addEventListener('mouseover', onOver)
  document.addEventListener('scroll', hide, { capture: true })
  window.addEventListener('blur', hide)
  // 键盘导航（tab 聚焦）也能读屏
  document.addEventListener('focusin', onFocusIn)
  // 挂载时对已存在元素补一次（首屏常驻按钮）
  document.querySelectorAll<HTMLElement>('[data-tip]').forEach(syncAriaLabel)
})
onBeforeUnmount(() => {
  document.removeEventListener('mouseover', onOver)
  document.removeEventListener('scroll', hide, { capture: true })
  window.removeEventListener('blur', hide)
  document.removeEventListener('focusin', onFocusIn)
  if (showTimer) clearTimeout(showTimer)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="tip"
      class="tip-host"
      :class="tip.dir"
      :style="{ left: tip.x + 'px', top: tip.y + 'px' }"
    >{{ tip.text }}</div>
  </Teleport>
</template>

<style scoped>
/* fixed 定位脱离所有 overflow 容器；z-index 高于 modal（200）确保顶层 */
.tip-host {
  position: fixed;
  z-index: 10000;
  padding: 4px 8px;
  background: var(--background-secondary-alt);
  color: var(--text-normal);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  box-shadow: var(--shadow-s);
  font-size: var(--font-size-s);
  white-space: nowrap;
  pointer-events: none;
  animation: clw-tip-fade var(--dur-fast) var(--ease-out);
}
.tip-host.top {
  transform: translate(-50%, -100%);
}
.tip-host.bottom {
  transform: translate(-50%, 0);
}
.tip-host.right {
  transform: translate(0, -50%);
}
.tip-host.left {
  transform: translate(-100%, -50%);
}
@keyframes clw-tip-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
</style>
