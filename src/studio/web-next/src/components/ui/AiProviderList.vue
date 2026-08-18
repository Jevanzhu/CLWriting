<script setup lang="ts">
// AI 提供方列表（阶段 14 I2 卡片化 + 单卡展开）。
// 行卡壳用 ProviderRow（两行主区：首行身份/状态，次行地址/模型数）；
// 展开槽 = 行内编辑（父层按 expandedId 互斥传入）；
// 新增卡也由父层控制 addOpen，本组件只发 add 事件（列表区隐藏，新增空白编辑器由父层渲染）。
// 共享控件语言（分组标题/徽章/胶囊按钮等）见 styles/providers.css。
import { Plus, Trash2, Check, Zap, Loader2, Pencil, Bot } from 'lucide-vue-next'
import type { ProviderConfDto, TestResult } from '../../api/providers'
import { capsBadge, timeAgo } from '../../shared/provider-format'
import ProviderRow from './ProviderRow.vue'
import EmptyState from './EmptyState.vue'

defineProps<{
  providers: ProviderConfDto[]
  currentId: string | null
  loading: boolean
  /** 正在测试连接的提供方 id（按钮转圈 + 禁点） */
  testing: string | null
  testResults: Map<string, TestResult>
  /** 当前展开编辑的提供方 id（单卡互斥；null = 全收起） */
  expandedId: string | null
  /** 新增卡是否打开（父层控制，打开时列表隐藏） */
  addOpen: boolean
}>()

const emit = defineEmits<{
  add: []
  activate: [p: ProviderConfDto]
  test: [p: ProviderConfDto]
  edit: [p: ProviderConfDto]
  remove: [p: ProviderConfDto]
}>()

function configuredRows(p: ProviderConfDto): { id: string; name?: string }[] {
  return (p.models ?? []).map((m) => ({ id: m.id, name: typeof m.name === 'string' ? m.name : undefined }))
}
/** 协议标签 = API 接口名（Chat Completions / Responses / Messages），非品牌名 */
function protocolLabel(p: ProviderConfDto): string {
  return p.protocol === 'anthropic' ? 'Messages' : p.protocol === 'openai-responses' ? 'Responses' : 'Chat Completions'
}
</script>

<template>
  <div class="group-title">
    <span class="group-title-text">AI 提供方</span>
    <button class="add-btn" @click="emit('add')"><Plus :size="14" />添加</button>
  </div>
  <p class="group-intro">填入各提供方的 API 密钥即可使用其模型。</p>

  <div v-if="loading" class="empty"><Loader2 :size="18" class="spin" /> 加载中…</div>

  <EmptyState
    v-else-if="providers.length === 0"
    :icon="Bot"
    size="full"
    title="尚未配置任何 AI 提供方"
    text="添加后测试连接，即可启用为当前写作服务"
  >
    <button class="add-btn-lg" @click="emit('add')"><Plus :size="15" />添加提供方</button>
  </EmptyState>

  <template v-else>
    <div class="provider-list">
      <ProviderRow
        v-for="p in providers"
        :key="p.id"
        :expanded="expandedId === p.id"
        :active="p.id === currentId"
      >
        <template #main>
          <!-- 单行：名称 + 当前徽章 + 协议接口名 + 模型数（淡字，有配置才显示）+ 右对齐状态 -->
          <div class="row-line">
            <span class="provider-row-name">{{ p.name }}</span>
            <span v-if="p.id === currentId" class="current-badge">当前</span>
            <span class="tag" :class="`proto-${p.protocol}`">{{ protocolLabel(p) }}</span>
            <span v-if="(p.models ?? []).length" class="row-count">{{ (p.models ?? []).length }} 个模型行</span>
            <span class="provider-status">
              <span v-if="p.caps" class="caps-badge" :class="capsBadge(p.caps)?.cls">{{ capsBadge(p.caps)?.text }}</span>
              <span v-if="p.caps?.connected" class="probed-at">{{ timeAgo(p.capsProbedAt) }}</span>
              <span v-if="!p.caps" class="unchecked-hint">未测试</span>
            </span>
          </div>
        </template>

        <template #actions>
          <!-- 启用：直接可用（当前提供方除外）；测试模型的选择在编辑卡里 -->
          <button
            v-if="p.id !== currentId"
            class="mini-btn enable"
            data-tip="设为当前启用"
            @click="emit('activate', p)"
          >
            <Check :size="13" />
          </button>
          <button
            class="mini-btn"
            :class="{ testing: testing === p.id }"
            :disabled="testing === p.id"
            data-tip="测试连接"
            @click="emit('test', p)"
          >
            <Loader2 v-if="testing === p.id" :size="13" class="spin" />
            <Zap v-else :size="13" />
          </button>
          <span class="row-action-sep" aria-hidden="true"></span>
          <button class="mini-btn" data-tip="编辑" @click="emit('edit', p)"><Pencil :size="13" /></button>
          <button class="mini-btn danger" data-tip="删除" @click="emit('remove', p)"><Trash2 :size="13" /></button>
        </template>

        <template #expand>
          <!-- 行展开内容：父层可用 scoped slot #row-expand 注入行内编辑器（AiServicePanel）；
               未提供时默认显示模型行数预览（未展开编辑态由父层在外部处理）。 -->
          <slot name="row-expand" :p="p">
            <div class="row-expand-preview">
              <span v-if="configuredRows(p).length" class="row-expand-model-count">{{ configuredRows(p).length }} 个模型行</span>
              <span v-else class="row-expand-placeholder">展开编辑配置</span>
            </div>
          </slot>
        </template>
      </ProviderRow>
    </div>
  </template>
</template>

<style scoped>
/* 共享控件语言（group-title/add-btn/empty/徽章 等）
 * 在 styles/providers.css；这里只留列表自身骨架。 */
.provider-list {
  display: grid;
  gap: var(--size-4-2);
}
</style>
