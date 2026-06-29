<script setup lang="ts">
// 总览态右栏：当前总览页说明（route 推断）。明细数据与中栏联动留后续刀（共享数据状态）。
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()

const NAME: Record<string, string> = {
  health: '体检',
  rhythm: '节奏',
  leads: '账本',
  settings: '设定',
  config: '配置',
}

const pageName = computed(() => {
  const seg = route.path.split('/').pop() ?? ''
  if (!seg || seg === route.params.name) return '作品概要'
  if (seg === 'piece') return '篇详情'
  return NAME[seg] || seg
})

const HINT: Record<string, string> = {
  作品概要: '身份卡 · 进度 · 状态机 · 卷结构 · 写作热力。',
  体检: '成本柱状 · 审查条形 · 文风折线 + 指标卡。',
  节奏: '字数曲线 · 钩子/情绪分布。',
  账本: '七类概览 · 章×线矩阵 · 停滞预警。',
  设定: '境界体系 · 角色卡 · 时间线 · 关系图。',
  配置: 'book.yaml 表单 + 文风铁律。',
  篇详情: '元数据 · 正文对照 · 情绪曲线 · 反转线索。',
}

const hint = computed(() => HINT[pageName.value] ?? '数据明细。')
</script>

<template>
  <div class="dd">
    <div class="dd-card">
      <div class="dd-title">{{ pageName }}</div>
      <div class="dd-hint">{{ hint }}</div>
    </div>
    <div class="dd-card">
      <div class="dd-title">明细联动</div>
      <div class="dd-hint">右栏将与中栏选中项联动（如账本条目明细、体检问题清单），后续刀接共享数据状态。</div>
    </div>
  </div>
</template>

<style scoped>
.dd-card{background:var(--panel-74);border:1px solid var(--white-20);border-radius:12px;padding:14px 16px;margin-bottom:12px;transition:transform .2s}
.dd-card:hover{transform:translateY(-2px)}
.dd-title{font-size:13px;font-weight:600;color:var(--ink);margin-bottom:8px}
.dd-hint{font-size:12px;color:var(--text-2);line-height:1.7}
</style>
