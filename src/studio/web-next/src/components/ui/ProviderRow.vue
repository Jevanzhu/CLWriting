<script setup lang="ts">
/**
 * 提供方行卡共享壳（阶段 14 I2，照搬 DSH：仅一个「编辑」入口）。
 * AI 与 RAG 列表共用：主信息槽 + 操作槽 + 展开槽；展开态由父层管理（互斥），
 * 点「编辑」（#actions 槽内）才切换就地展开。
 * 主信息槽为单行结构（名称/徽章/协议 + 右对齐状态），由 providers.css 的
 * .row-line 提供布局；#actions 槽内按钮用 .mini-btn，
 * 其样式经 :slotted() 下发——插槽内容不带本组件 scope id，普通 scoped 选择器够不着。
 */
import { Loader2 } from 'lucide-vue-next'

defineProps<{
  expanded: boolean
  /** 操作区是否有测试按钮在跑（用于测试按钮局部 loading？这里仅做展开区忙碌提示） */
  busy?: boolean
  /** 行激活态（AI 当前启用 / RAG false） */
  active?: boolean
}>()
</script>

<template>
  <div class="provider-row" :class="{ active, expanded, 'row-busy': busy }">
    <div class="provider-row-main">
      <slot name="main" />
    </div>
    <div class="provider-actions">
      <slot name="actions" />
    </div>
    <div v-if="expanded" class="provider-row-expand">
      <Loader2 v-if="busy" :size="14" class="spin" />
      <slot name="expand" />
    </div>
  </div>
</template>

<style scoped>
/* 行卡壳（DSH rowCard 语言）：面板底色上描边行卡；展开的编辑器是「填充模块」
 * ——不再边框套边框，展开区用 secondary 底色读作嵌套对象。 */
.provider-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
  /* 紧凑行卡（对齐 dsh rowCard：12 圆角 + 小内边距，信息做减法） */
  padding: 8px 10px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  background: var(--background-primary);
  transition: border-color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.provider-row:hover {
  border-color: var(--background-modifier-border-hover);
  /* 悬浮微升（DSH 允许的 hover-lift） */
  transform: translateY(-1px);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
}
.provider-row.active {
  /* 当前提供方：只走强调描边（「当前」徽章已标身份）——不再叠紫调底，
   * 否则展开编辑区的灰模块压在紫调上会发脏（dsh：单一模块底，不多层填色） */
  border-color: color-mix(in srgb, var(--interactive-accent) 34%, transparent);
}
.provider-row.expanded {
  align-items: stretch;
  transform: none;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.05);
}
.provider-row-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}
.provider-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  align-self: center;
  flex-shrink: 0;
}
.provider-row-expand {
  flex-basis: 100%;
  margin-top: 4px;
  padding: 10px 12px;
  border-radius: var(--radius-m);
  background: var(--background-secondary);
  animation: clw-card-in var(--dur-norm) var(--ease-out);
}

/* ── 操作图标按钮（28px ghost）：定义在本壳、写给 #actions 槽内容用。
 *    插槽内容挂的是调用方 scope id，必须 :slotted() 才能命中（曾因此整排
 *    按钮回落成浏览器原生样式）。 ── */
:slotted(.mini-btn) {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  /* dsh iconButton 的 6px：小方格图标钮比输入框（8）更收 */
  border-radius: 6px;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
:slotted(.mini-btn:hover) {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
:slotted(.mini-btn.enable) {
  color: var(--dv-good);
}
:slotted(.mini-btn.testing) {
  pointer-events: none;
}
:slotted(.mini-btn.danger:hover) {
  color: var(--dv-bad);
  background: color-mix(in srgb, var(--dv-bad) 10%, transparent);
}
</style>
