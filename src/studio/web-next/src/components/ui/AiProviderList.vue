<script setup lang="ts">
// AI 提供方列表（卡片化 + 单卡展开）。
// 骨架（标题行/说明行/加载行/空态/行卡容器）走 ProviderListShell，行内操作簇走
// ProviderRowActions（两处与 RAG 列表共；收编口径见各件头注）；
// 展开槽 = 行内编辑（父层按 expandedId 互斥传入）；
// 新增卡打开由父层控制（与列表并列渲染），本组件只发 add 事件。
// 共享控件语言（分组标题/徽章/胶囊按钮等）见 styles/providers.css。
import { Bot } from 'lucide-vue-next'
import type { ProviderConfDto } from '../../api/providers'
import { capsBadge, timeAgo } from '../../shared/provider-format'
import ProviderListShell from './ProviderListShell.vue'
import ProviderRowActions from './ProviderRowActions.vue'

// 行卡状态面就两个来源：徽章读 p.caps（store.test() 探测后写回 providers 行），
// 失败原因走父层 toast——故不接 testResults（探测 details/error 的展示面在父层）。
defineProps<{
  providers: ProviderConfDto[]
  currentId: string | null
  loading: boolean
  /** 正在测试连接的提供方 id（按钮转圈 + 禁点） */
  testing: string | null
  /** 当前展开编辑的提供方 id（单卡互斥；null = 全收起） */
  expandedId: string | null
}>()

const emit = defineEmits<{
  add: []
  activate: [p: ProviderConfDto]
  test: [p: ProviderConfDto]
  edit: [p: ProviderConfDto]
  remove: [p: ProviderConfDto]
}>()

// 原 configuredRows 构造 {id,name} 行对象，模板只消费 .length
// （映射产物全量丢弃）——收编为纯计数，零行为变化。
function modelRowCount(p: ProviderConfDto): number {
  return (p.models ?? []).length
}
/** 协议标签 = API 接口名（Chat Completions / Responses / Messages），非品牌名 */
function protocolLabel(p: ProviderConfDto): string {
  return p.protocol === 'anthropic' ? 'Messages' : p.protocol === 'openai-responses' ? 'Responses' : 'Chat Completions'
}
</script>

<template>
  <ProviderListShell
    title="AI 提供方"
    :items="providers"
    :loading="loading"
    :expanded-id="expandedId"
    :active-id="currentId"
    :empty-icon="Bot"
    empty-title="尚未配置任何 AI 提供方"
    empty-text="添加后测试连接，即可启用为当前写作服务"
    empty-cta="添加提供方"
    @add="emit('add')"
  >
    <template #intro><p class="group-intro">填入各提供方的 API 密钥即可使用其模型。</p></template>
    <template #main="{ p }">
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

    <template #actions="{ p }">
      <ProviderRowActions
        :testing="testing === p.id"
        :show-enable="p.id !== currentId"
        divider
        @activate="emit('activate', p)"
        @test="emit('test', p)"
        @edit="emit('edit', p)"
        @remove="emit('remove', p)"
      />
    </template>

    <template #expand="{ p }">
      <!-- 行展开内容：父层可用 scoped slot #row-expand 注入行内编辑器（AiServicePanel）；
           未提供时默认显示模型行数预览（未展开编辑态由父层在外部处理）。 -->
      <slot name="row-expand" :p="p">
        <div class="row-expand-preview">
          <span v-if="modelRowCount(p)" class="row-expand-model-count">{{ modelRowCount(p) }} 个模型行</span>
          <span v-else class="row-expand-placeholder">展开编辑配置</span>
        </div>
      </slot>
    </template>
  </ProviderListShell>
</template>
