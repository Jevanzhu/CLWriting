<script setup lang="ts">
// 总览态右栏：当前页说明 + 联动占位。对齐 mockup 右栏 .card 样式。
// 明细联动留后续（共享数据状态）；此处不重复拉中栏数据、不造假。
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
  <div class="card">
    <div class="card-title">{{ pageName }}</div>
    <div class="dd-hint">{{ hint }}</div>
  </div>
  <div class="card">
    <div class="card-title">明细联动</div>
    <div class="dd-hint">右栏将与中栏选中项联动（账本条目、体检问题等），后续接共享数据状态。</div>
  </div>
</template>

<style scoped>
/* mockup 右栏 .card 已覆盖容器；此处仅补 .dd-hint（说明文本，mockup 无此语义类）。 */
.dd-hint{font-size:12px;color:var(--text-2);line-height:1.7}
</style>