<script setup lang="ts">
/**
 * 总览 ④ 节奏分布面板（hh §八-16 自 OverviewView.vue 拆出，纯搬家）。
 * emphasis 设计：柱=已写（accent），线=规划（灰）；长短篇同构，短篇无 planned。
 */
import { computed } from 'vue'
import { BarChart3 } from 'lucide-vue-next'
import type { RhythmDist, RhythmResult } from '../../api/rhythm'

const props = defineProps<{
  rhythmData: RhythmResult | null
}>()

// 枚举顺序与服务端 rhythm.ts 一致（稳定渲染）
const HOOK_TYPES = ['危机钩', '悬念钩', '渴望钩', '情绪钩', '选择钩']
const EMOTIONS = ['压抑', '铺垫', '小爽', '大爽', '转折']
const SCENE_TYPES = ['战斗', '对话', '抒情', '叙事铺陈', '爽点高潮']

interface DistGroup { title: string; keys: string[]; written: RhythmDist; planned: RhythmDist }
const distGroups = computed<DistGroup[]>(() => {
  const d = props.rhythmData
  if (!d) return []
  if (d.kind === 'long') {
    return [
      { title: '钩子类型', keys: HOOK_TYPES, written: d.written.hookTypeDist, planned: d.planned.hookTypeDist },
      { title: '情绪定位', keys: EMOTIONS, written: d.written.emotionDist, planned: d.planned.emotionDist },
      { title: '场景分布', keys: SCENE_TYPES, written: d.written.sceneDist, planned: d.planned.sceneDist },
    ]
  }
  // 短篇：有 written（连续故事）才显示节奏分布（独立短篇无 written → 空）
  if (!d.written) return []
  return [
    { title: '钩子类型', keys: HOOK_TYPES, written: d.written.hookTypeDist, planned: {} },
    { title: '情绪定位', keys: EMOTIONS, written: d.written.emotionDist, planned: {} },
    { title: '场景分布', keys: SCENE_TYPES, written: d.written.sceneDist, planned: {} },
  ]
})
function distMax(g: DistGroup): number {
  return Math.max(1, ...g.keys.map((k) => Math.max(g.written[k] ?? 0, g.planned[k] ?? 0)))
}
</script>

<template>
  <section v-if="distGroups.length" class="panel">
    <div class="panel-head">
      <BarChart3 :size="14" /> <span>节奏分布</span>
      <span v-if="rhythmData?.kind === 'long'" class="head-legend">柱 已写 · 线 规划 · {{ rhythmData.written.count }}/{{ rhythmData.planned.count }} 章</span>
      <span v-else class="head-legend">柱 已写 · {{ rhythmData?.written?.count ?? 0 }} 章</span>
    </div>
    <div class="dist-grid">
      <div v-for="g in distGroups" :key="g.title" class="dist-group">
        <div class="dist-title">{{ g.title }}</div>
        <div v-for="k in g.keys" :key="k" class="dist-row">
          <span class="dist-key">{{ k }}</span>
          <div class="dist-bar">
            <div class="dist-written" :style="{ width: ((g.written[k] ?? 0) / distMax(g) * 100) + '%' }"></div>
            <div
              v-if="(g.planned[k] ?? 0) > 0"
              class="dist-target"
              :style="{ left: ((g.planned[k] ?? 0) / distMax(g) * 100) + '%' }"
            ></div>
          </div>
          <span class="dist-val">{{ g.written[k] ?? 0 }}<span class="sep">/</span>{{ g.planned[k] ?? 0 }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 面板基础（与 OverviewView 同式） */
.panel {
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  padding: 18px 20px;
  animation: clw-fade-up var(--dur-fast) var(--ease-out) both;
}

.head-legend { margin-left: auto; font-weight: 400; font-size: var(--font-size-xs); color: var(--text-muted); }

/* ══ 节奏分布 ══ */
.dist-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--size-4-5); }
.dist-group { display: flex; flex-direction: column; gap: 8px; }
.dist-title { font-size: var(--font-size-s); font-weight: 600; color: var(--text-normal); padding-bottom: 6px; margin-bottom: 2px; border-bottom: 1px solid var(--background-modifier-border); }
.dist-row { display: grid; grid-template-columns: 56px 1fr 38px; align-items: center; gap: var(--size-4-2); }
.dist-key { font-size: var(--font-size-xs); color: var(--text-muted); }
.dist-bar { position: relative; height: 14px; display: flex; align-items: center; background: color-mix(in srgb, var(--background-modifier-border) 50%, transparent); border-radius: 4px; }
.dist-written { height: 8px; background: var(--interactive-accent); border-radius: 3px; transition: width var(--dur-slow) var(--ease-out); }
.dist-target { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--text-muted); border-radius: 1px; transform: translateX(-1px); }
.dist-val { font-size: var(--font-size-xs); color: var(--text-faint); text-align: right; font-variant-numeric: tabular-nums; }
.dist-val .sep { margin: 0 2px; opacity: 0.5; }

@media (max-width: 600px) {
  .dist-grid { grid-template-columns: 1fr; }
}
</style>
