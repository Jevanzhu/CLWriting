<script setup lang="ts">
// RAG（嵌入）提供方列表（卡片化 + 单卡展开）。
// 骨架（标题行/加载行/空态/行卡容器）走 ProviderListShell，行内操作簇走
// ProviderRowActions（两处与 AI 列表共；收编口径见各件头注）；
// 展开槽由父层 scoped slot #row-expand 注入（默认显示 endpoint 占位）。
// 共享控件语言（分组标题/徽章/胶囊按钮等）见 styles/providers.css。
import { Database } from 'lucide-vue-next'
import type { RagProviderDto } from '../../api/providers'
import { timeAgo } from '../../shared/provider-format'
import ProviderListShell from './ProviderListShell.vue'
import ProviderRowActions from './ProviderRowActions.vue'

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
  <ProviderListShell
    title="RAG 提供方"
    :items="ragProviders"
    :loading="ragLoading"
    :expanded-id="expandedId"
    :empty-icon="Database"
    empty-title="尚未配置嵌入提供方"
    empty-text="「设置 · 本书」页的知识检索需要至少一个"
    empty-cta="添加 RAG 提供方"
    @add="emit('add')"
  >
    <template #main="{ p }">
      <!-- 单行：名称 + 嵌入模型 + 右对齐状态（地址不占行——编辑卡里可查） -->
      <div class="row-line">
        <span class="provider-row-name">{{ p.name }}</span>
        <span class="model-tag" :data-tip="p.model">{{ p.model }}</span>
        <span class="provider-status">
          <span v-if="p.caps" class="caps-badge" :class="p.caps.connected ? 'ok' : 'bad'">{{
            p.caps.connected ? '已连接' : '连接失败'
          }}</span>
          <span v-if="p.caps?.connected" class="probed-at">{{ timeAgo(p.capsProbedAt) }}</span>
          <span v-if="!p.caps" class="unchecked-hint">未测试</span>
        </span>
      </div>
    </template>

    <template #actions="{ p }">
      <ProviderRowActions
        :testing="ragTesting === p.id"
        @test="emit('test', p)"
        @edit="emit('edit', p)"
        @remove="emit('remove', p)"
      />
    </template>

    <template #expand="{ p }">
      <!-- 父层可用 scoped slot #row-expand 注入行内编辑器；默认仅占位 -->
      <slot name="row-expand" :p="p">
        <div class="row-expand-preview"><span class="row-expand-placeholder">展开编辑配置</span></div>
      </slot>
    </template>
  </ProviderListShell>
</template>
