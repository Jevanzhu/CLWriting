<script setup lang="ts">
/**
 * 提供方行卡的操作簇（启用 / 测试连接 / 编辑 / 删除）——AI 与 RAG 两列表的这几个钮
 * 原本逐字同构，收为单源：图标、顺序、禁用条件、data-tip 文案与类名一致。
 *
 * 两个差异面收在 props 上，DOM 顺序与迁移前逐字一致：
 * - `showEnable`：AI 档有「设为当前启用」（当前提供方除外，由父层判定后传入）；
 *   RAG 档无此概念。
 * - `divider`：测试钮与编辑钮之间是否插分组 hairline（AI 档把「连接类动作」与
 *   「行改写类动作」分两组，RAG 档不分）。
 *
 * 纯图标钮的可访问名走 data-tip（TooltipHost 统一同步成 aria-label，同全局口径）。
 * `.mini-btn` 各态样式随本件自持（scoped）：原由行卡壳的 :slotted(.mini-btn) 下发，
 * 插槽内容须挂调用方 scope id 才命中；本簇改由本组件渲染后按钮挂的是本件 scope id，
 * 样式定义随实现落到一处，不再依赖插槽面的作用域约定。
 */
import { Trash2, Check, Zap, Loader2, Pencil } from 'lucide-vue-next'

defineProps<{
  /** 正在测试连接（按钮转圈 + 禁点） */
  testing: boolean
  /** 是否显示「设为当前启用」钮（AI 档：非当前提供方时） */
  showEnable?: boolean
  /** 测试钮与编辑钮之间是否插分组竖线（AI 档 true） */
  divider?: boolean
}>()

const emit = defineEmits<{
  activate: []
  test: []
  edit: []
  remove: []
}>()
</script>

<template>
  <!-- 启用：直接可用（当前提供方除外）；测试模型的选择在编辑卡里 -->
  <button v-if="showEnable" class="mini-btn enable" data-tip="设为当前启用" @click="emit('activate')">
    <Check :size="13" />
  </button>
  <button class="mini-btn" :class="{ testing }" :disabled="testing" data-tip="测试连接" @click="emit('test')">
    <Loader2 v-if="testing" :size="13" class="spin" />
    <Zap v-else :size="13" />
  </button>
  <span v-if="divider" class="row-action-sep" aria-hidden="true"></span>
  <button class="mini-btn" data-tip="编辑" @click="emit('edit')"><Pencil :size="13" /></button>
  <button class="mini-btn danger" data-tip="删除" @click="emit('remove')"><Trash2 :size="13" /></button>
</template>

<style scoped>
/* ── 操作图标按钮（28px ghost；声明自行卡壳的 :slotted(.mini-btn) 逐字迁入） ── */
.mini-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  /* 小方格图标钮 6px：比输入框（8）更收 */
  border-radius: 6px;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.mini-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.mini-btn.enable {
  color: var(--dv-good);
}
.mini-btn.testing {
  pointer-events: none;
}
.mini-btn.danger:hover {
  color: var(--dv-bad);
  background: color-mix(in srgb, var(--dv-bad) 10%, transparent);
}
</style>
