<script setup lang="ts">
/**
 * 总览 · 短篇画像缺口面板（hh §八-16 自 OverviewView.vue 拆出，纯搬家）。
 * 短篇专属：情绪覆盖 + 反转类型覆盖 + 跨章母题（长篇无 shortProfile → 不渲染）。
 */
import { computed } from 'vue'
import { BarChart3, Info } from 'lucide-vue-next'
import type { RhythmResult } from '../../api/rhythm'

const props = defineProps<{
  /** 总览 identity 侧的短篇画像（targetEmotions/targetReversalTypes/seriesMotifs） */
  shortProfile: { targetEmotions?: string[]; targetReversalTypes?: string[]; seriesMotifs?: string[] } | undefined
  rhythmData: RhythmResult | null
}>()

/** 情绪缺口：target_emotions vs 已写章的目标情绪分布 */
const emotionGap = computed(() => {
  const profile = props.shortProfile
  if (!profile?.targetEmotions?.length) return null
  const dist = props.rhythmData?.kind === 'short' ? props.rhythmData.emotionDist : {}
  return profile.targetEmotions.map((e) => ({
    emotion: e,
    count: dist[e] ?? 0,
    missing: (dist[e] ?? 0) === 0,
  }))
})
/** 跨章母题 */
const seriesMotifs = computed(() => props.shortProfile?.seriesMotifs ?? [])

/** 反转类型缺口：target_reversal_types vs 已写章核心反转归类（派生自 rhythm） */
const reversalGap = computed(() => {
  const profile = props.shortProfile
  if (!profile?.targetReversalTypes?.length) return null
  const d = props.rhythmData
  if (d?.kind !== 'short') return null
  return d.reversalGap
})
/** 未归类章数（规则未命中 / 池外类型） */
const reversalUnrecognized = computed(() => {
  const d = props.rhythmData
  return d?.kind === 'short' ? (d.reversalUnrecognized ?? 0) : 0
})
</script>

<template>
  <section v-if="emotionGap || reversalGap || seriesMotifs.length" class="panel">
    <div class="panel-head">
      <BarChart3 :size="14" /> <span>画像缺口</span>
      <span v-if="emotionGap" class="head-legend">{{ emotionGap.filter((g) => !g.missing).length }}/{{ emotionGap.length }} 情绪已覆盖</span>
      <span v-if="reversalGap" class="head-legend">{{ reversalGap.filter((g) => !g.missing).length }}/{{ reversalGap.length }} 反转已覆盖</span>
    </div>
    <!-- 情绪覆盖 -->
    <div v-if="emotionGap" class="gap-rows">
      <div v-for="g in emotionGap" :key="g.emotion" class="gap-row" :class="{ 'is-missing': g.missing }">
        <span class="gap-label">{{ g.emotion }}</span>
        <div class="gap-bar">
          <div class="gap-fill" :style="{ width: Math.min(100, g.count * 25) + '%' }"></div>
        </div>
        <span class="gap-count" :class="{ 'is-zero': g.missing }">{{ g.count }} 章</span>
      </div>
    </div>
    <!-- 反转类型覆盖 -->
    <div v-if="reversalGap" class="gap-rows">
      <div v-for="g in reversalGap" :key="g.type" class="gap-row" :class="{ 'is-missing': g.missing }">
        <span class="gap-label">{{ g.type }}</span>
        <div class="gap-bar">
          <div class="gap-fill" :style="{ width: Math.min(100, g.count * 25) + '%' }"></div>
        </div>
        <span class="gap-count" :class="{ 'is-zero': g.missing }">{{ g.count }} 章</span>
      </div>
      <div v-if="reversalUnrecognized > 0" class="gap-unrecognized">
        <Info :size="12" /> {{ reversalUnrecognized }} 章未归类（规则未命中 / 池外类型）
      </div>
    </div>
    <!-- 跨章母题 -->
    <div v-if="seriesMotifs.length" class="motif-section">
      <span class="motif-label">跨章母题</span>
      <div class="motif-tags">
        <span v-for="m in seriesMotifs" :key="m" class="motif-tag">{{ m }}</span>
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
  animation: fade-up var(--dur-fast) var(--ease-out) both;
}
.panel-head {
  display: flex; align-items: center; gap: 6px;
  font-size: var(--font-size-s); font-weight: 600;
  color: var(--text-muted); margin-bottom: 14px;
}
.panel-head svg { opacity: 0.5; flex-shrink: 0; }
.head-legend { margin-left: auto; font-weight: 400; font-size: var(--font-size-xs); color: var(--text-muted); }
@keyframes fade-up { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

/* ══ 短篇画像缺口 ══ */
.gap-rows { display: flex; flex-direction: column; gap: 8px; }
.gap-row { display: grid; grid-template-columns: 72px 1fr 44px; align-items: center; gap: var(--size-4-2); }
.gap-label { font-size: var(--font-size-xs); color: var(--text-muted); }
.gap-bar { position: relative; height: 8px; background: color-mix(in srgb, var(--background-modifier-border) 50%, transparent); border-radius: 4px; }
.gap-fill { height: 100%; background: var(--interactive-accent); border-radius: 4px; transition: width var(--dur-slow) var(--ease-out); }
.gap-row.is-missing .gap-fill { background: var(--text-warning); box-shadow: 0 0 6px color-mix(in srgb, var(--text-warning) 40%, transparent); }
.gap-count { font-size: var(--font-size-xs); color: var(--text-faint); text-align: right; font-variant-numeric: tabular-nums; }
.gap-count.is-zero { color: var(--text-warning); font-weight: 600; }
.gap-unrecognized { display: flex; align-items: center; gap: 4px; font-size: var(--font-size-xxs); color: var(--text-faint); margin-top: 2px; }
.motif-section { margin-top: 14px; display: flex; align-items: center; gap: var(--size-4-2); }
.motif-label { font-size: var(--font-size-xs); color: var(--text-faint); flex-shrink: 0; }
.motif-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.motif-tag { font-size: var(--font-size-xs); padding: 1px 10px; border-radius: 8px; background: color-mix(in srgb, var(--interactive-accent) 10%, transparent); color: var(--text-accent); }
</style>
