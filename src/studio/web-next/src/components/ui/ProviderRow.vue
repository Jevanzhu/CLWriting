<script setup lang="ts">
/**
 * 提供方行卡共享壳（照搬 DSH：仅一个「编辑」入口）。
 * AI 与 RAG 列表共用：主信息槽 + 操作槽 + 展开槽；展开态由父层管理（互斥），
 * 点「编辑」（#actions 槽内，ProviderRowActions）才切换就地展开。
 * 主信息槽为单行结构（名称/徽章/协议 + 右对齐状态），由 providers.css 的 .row-line
 * 提供布局；#actions 槽内按钮的 .mini-btn 样式随 ProviderRowActions 自持
 * （插槽内容不带本组件 scope id，scoped 规则够不着，故不在本壳下发）。
 */
defineProps<{
  expanded: boolean
  /** 行激活态（AI 当前启用 / RAG false） */
  active?: boolean
}>()
</script>

<template>
  <div class="provider-row" :class="{ active, expanded }">
    <div class="provider-row-main">
      <slot name="main" />
    </div>
    <div class="provider-actions">
      <slot name="actions" />
    </div>
    <div v-if="expanded" class="provider-row-expand">
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
  transition:
    border-color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
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

/* 操作图标按钮（28px ghost）的样式不在此处：原 :slotted(.mini-btn) 只对直接插槽
 * 子节点生效，操作簇改由 ProviderRowActions 渲染后按钮挂的是该件 scope id，
 * :slotted 恒不命中且会静默失样式；声明随 ProviderRowActions 自持（值不变）。 */
</style>
