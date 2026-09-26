<script setup lang="ts">
// 全屏遮罩统一组件：open 即向 ui store 登记、关即注销（⌘P 守卫 /
// Esc 让渡 / win 窗控压暗对一切走本组件的遮罩自动生效）；遮罩浓度从 ui store
// MASK_ALPHA 单源内联上色——各弹窗不再自写 rgba 遮罩 CSS（原「MASK_ALPHA ↔ 组件
// CSS」双份镜像、靠测试读 CSS 对账的面已删）。
// 调用方传 :open 而非在本组件上挂 v-if：teleport 之内隔组件边界做挂载/卸载开关，
// 卸载路径在双窗实例 + body 清空时序下触发 DOM 竞态（回归）——本组件常驻、
// 内层 div 的 v-if 与迁移前「Teleport > div v-if」的 DOM 操作序列逐位一致；
// Teleport 亦由调用方自持（ConfirmPrompt 无 Teleport 惯例，原位渲染不变）。
import { computed, watch, onUnmounted } from 'vue'
import { MASK_ALPHA, useUiStore, type OverlayKey } from '../../stores/ui'

const props = defineProps<{ kind: OverlayKey; open: boolean }>()
const emit = defineEmits<{ maskClick: [] }>()
const ui = useUiStore()

// 遮罩 DOM 类名保持迁出前逐字口径——base.css 的 win32 animation:none 名单与既有
// 测试按类名对账（settings/export 共用 .modal-mask 同名异浓，浓度已按 kind 分流）
const MASK_CLASS: Record<OverlayKey, string> = {
  palette: 'palette-mask',
  settings: 'modal-mask',
  export: 'modal-mask',
  shelf: 'shelf-mask',
  confirm: 'cp-mask',
  chapterMeta: 'meta-mask',
  splitChapter: 'split-mask',
}

// open 即登记：开合条件直连（store 动作位 / 面板 v-model / confirmState），登记随动
watch(
  () => props.open,
  (v) => ui.setMaskOpen(props.kind, v),
  { immediate: true },
)
// open=true 期间组件整体被拆（宿主卸载）也注销，不留残留登记位
onUnmounted(() => {
  if (props.open) ui.setMaskOpen(props.kind, false)
})

const alpha = computed(() => MASK_ALPHA[props.kind])
</script>

<template>
  <div
    v-if="open"
    :class="MASK_CLASS[kind]"
    :style="{ background: `rgba(0, 0, 0, ${alpha})` }"
    @click.self="emit('maskClick')"
  >
    <slot />
  </div>
</template>

<style scoped>
/* 遮罩布局按 kind 类名分段，数值为各弹窗迁出前原值（逐像素等价）；背景浓度不在
   CSS（模板内联自 MASK_ALPHA）。meta/split 迁出前即无渐变动画，不在 base.css
   win32 animation:none 名单内也无须在。 */
.modal-mask,
.palette-mask,
.shelf-mask,
.cp-mask,
.meta-mask,
.split-mask {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.modal-mask {
  z-index: 150;
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  animation: clw-overlay var(--dur-norm) var(--ease-out);
}
.palette-mask {
  z-index: 150;
  align-items: flex-start;
  padding-top: 12vh;
  animation: clw-overlay var(--dur-norm) var(--ease-out);
}
.shelf-mask {
  z-index: 150;
  align-items: flex-start;
  padding-top: 24vh;
  animation: clw-overlay var(--dur-norm) var(--ease-out);
}
.cp-mask {
  z-index: 200;
  animation: clw-overlay var(--dur-norm) var(--ease-out);
}
.meta-mask,
.split-mask {
  z-index: 100;
}
</style>
