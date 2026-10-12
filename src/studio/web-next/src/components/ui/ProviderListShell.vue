<script setup lang="ts" generic="T extends { id: string }">
/**
 * 提供方列表壳（AI / RAG 两列表共用）——分组标题 + 加载行 + 空态 + 行卡容器，
 * 以及 ProviderRow 的展开态/激活态接线。两列表原本这三段逐字重复、
 * 只有标题文案/空态文案/说明行这类数据面不同，故收为单源。
 *
 * 行内差异（主信息区、操作簇、展开区）仍由各列表经 main / actions / expand
 * 槽注入：本壳只管骨架与行卡接线，不认识具体的提供方字段——故 items 走泛型，
 * 槽内 p 保留调用方的具体类型。
 *
 * DOM 契约与迁移前逐字一致（同层同序：标题行 → 说明行 → 加载行/空态/列表三选一），
 * 类名与 providers.css 的全局前缀（.ai-service-panel）文案不变。
 */
import { Loader2, Plus } from 'lucide-vue-next'
import type { Component } from 'vue'
import ProviderRow from './ProviderRow.vue'
import EmptyState from './EmptyState.vue'

defineProps<{
  /** 分组标题 */
  title: string
  /** 空态行动钮文案（「添加…」） */
  emptyCta: string
  emptyIcon: Component
  emptyTitle: string
  emptyText: string
  items: T[]
  loading: boolean
  /** 当前展开行 id（单卡互斥；null = 全收起） */
  expandedId: string | null
  /** 行激活态 id（该档无激活概念则不传 → 各行均无激活态） */
  activeId?: string | null
}>()

const emit = defineEmits<{
  add: []
}>()
</script>

<template>
  <div class="group-title">
    <span class="group-title-text">{{ title }}</span>
    <button class="add-btn" @click="emit('add')"><Plus :size="14" />添加</button>
  </div>
  <!-- 标题下的说明行：该档有才注入（用插槽而非 v-if 传值——不注入即整个不渲染，
       不留 v-if 的占位注释节点，DOM 与迁移前逐字一致） -->
  <slot name="intro" />

  <div v-if="loading" class="empty"><Loader2 :size="18" class="spin" /> 加载中…</div>

  <EmptyState v-else-if="items.length === 0" :icon="emptyIcon" size="full" :title="emptyTitle" :text="emptyText">
    <button class="add-btn-lg" @click="emit('add')"><Plus :size="15" />{{ emptyCta }}</button>
  </EmptyState>

  <div v-else class="provider-list">
    <ProviderRow v-for="p in items" :key="p.id" :expanded="expandedId === p.id" :active="activeId === p.id">
      <template #main><slot name="main" :p="p" /></template>
      <template #actions><slot name="actions" :p="p" /></template>
      <template #expand><slot name="expand" :p="p" /></template>
    </ProviderRow>
  </div>
</template>
