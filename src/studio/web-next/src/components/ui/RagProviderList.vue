<script setup lang="ts">
// RAG（嵌入）提供方列表（阶段 14 I2 卡片化 + 单卡展开）。
// 行卡壳用 ProviderRow（两行主区：首行身份/状态，次行服务地址）；
// 展开槽由父层 scoped slot #row-expand 注入（默认显示 endpoint）。
// 共享控件语言（分组标题/徽章/胶囊按钮等）见 styles/providers.css。
import { Plus, Trash2, Zap, Loader2, Pencil, Database } from 'lucide-vue-next'
import type { RagProviderDto } from '../../api/providers'
import { timeAgo } from '../../shared/provider-format'
import ProviderRow from './ProviderRow.vue'
import EmptyState from './EmptyState.vue'

defineProps<{
  ragProviders: RagProviderDto[]
  ragLoading: boolean
  ragTesting: string | null
  /** 当前展开行 id（单卡互斥） */
  expandedId: string | null
}>()

const emit = defineEmits<{
  add: []
  edit: [p: RagProviderDto]
  remove: [p: RagProviderDto]
  test: [p: RagProviderDto]
}>()
</script>

<template>
  <div class="group-title">
    <span class="group-title-text">RAG 提供方</span>
    <button class="add-btn" @click="emit('add')"><Plus :size="14" />添加</button>
  </div>

  <div v-if="ragLoading" class="empty"><Loader2 :size="18" class="spin" /> 加载中…</div>

  <EmptyState
    v-else-if="ragProviders.length === 0"
    :icon="Database"
    size="full"
    title="尚未配置嵌入提供方"
    text="「设置 · 本书」页的知识检索需要至少一个"
  >
    <button class="add-btn-lg" @click="emit('add')"><Plus :size="15" />添加 RAG 提供方</button>
  </EmptyState>

  <template v-else>
    <div class="provider-list">
      <ProviderRow
        v-for="p in ragProviders"
        :key="p.id"
        :expanded="expandedId === p.id"
      >
        <template #main>
          <!-- 单行：名称 + 嵌入模型 + 右对齐状态（地址不占行——编辑卡里可查） -->
          <div class="row-line">
            <span class="provider-row-name">{{ p.name }}</span>
            <span class="model-tag" :data-tip="p.model">{{ p.model }}</span>
            <span class="provider-status">
              <span v-if="p.caps" class="caps-badge" :class="p.caps.connected ? 'ok' : 'bad'">{{ p.caps.connected ? '已连接' : '连接失败' }}</span>
              <span v-if="p.caps?.connected" class="probed-at">{{ timeAgo(p.capsProbedAt) }}</span>
              <span v-if="!p.caps" class="unchecked-hint">未测试</span>
            </span>
          </div>
        </template>

        <template #actions>
          <button class="mini-btn" :class="{ testing: ragTesting === p.id }" :disabled="ragTesting === p.id" data-tip="测试连接" @click="emit('test', p)">
            <Loader2 v-if="ragTesting === p.id" :size="13" class="spin" />
            <Zap v-else :size="13" />
          </button>
          <button class="mini-btn" data-tip="编辑" @click="emit('edit', p)"><Pencil :size="13" /></button>
          <button class="mini-btn danger" data-tip="删除" @click="emit('remove', p)"><Trash2 :size="13" /></button>
        </template>

        <template #expand>
          <!-- 父层可用 scoped slot #row-expand 注入行内编辑器；默认仅占位 -->
          <slot name="row-expand" :p="p">
            <div class="row-expand-preview"><span class="row-expand-placeholder">展开编辑配置</span></div>
          </slot>
        </template>
      </ProviderRow>
    </div>
  </template>
</template>

<style scoped>
/* 共享控件语言在 styles/providers.css；这里只留区块骨架。 */
.rag-provider-section {
  display: grid;
  gap: var(--size-4-2);
}
.provider-list {
  display: grid;
  gap: var(--size-4-2);
}
</style>
