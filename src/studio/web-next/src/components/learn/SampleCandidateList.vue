<script setup lang="ts">
/**
 * 文风收割 · 样章候选区（hh §八-16 自 LearnView.vue 拆出，纯搬家）。
 * 筛选（全部/仅 A 级）+ 批量操作（全选 A / 清空）+ 场景分组候选卡列表。
 * 候选制红线：勾选才入库，品味归人——勾选态直接读写 learn store（单一实例）。
 */
import { computed, ref, watch } from 'vue'
import { Check } from 'lucide-vue-next'
import { useLearnStore } from '../../stores/learn'
import { TIER_A, scoreTierStats, tierOf } from '../../shared/learn-tier'
import type { SampleCandidateFE } from '../../api/learn'

const learn = useLearnStore()

// ── 筛选 ──
const filter = ref<'all' | 'a'>('all')

// ── 打分分布统计 ──
// R48-90（四十八轮）：统计收敛 shared/learn-tier 单源（原与 LearnView 逐字双实现）
const scoreStats = computed(() => scoreTierStats(learn.samples))

// ── 样章按场景分组（筛选后、组内打分降序、组间均分降序）──
// R-P2-6：v-for key 原拼整段正文（`出处\u0000正文`）——巨串逐项比较放大列表 diff 开销，
// 且同组「同出处+同正文」两条候选同 key（Vue duplicate key，diff 边角）。改数据内在键
// `场景\u0000出处\u0000组内全量下标`：下标在分组 computed 内对排序后的全量 items 编号
// （非 visibleItems 可见切片下标——展开前后切片恒为前缀延展，键随条目走不错位；下标
// 本身保证组内唯一，同出处多条也不撞）。勾选翻转只触发 allPicked 重算（sort 稳定、
// 下标不变，键稳定不引发 DOM 重建）；重跑收割整体替换 learn.samples 时键整体重建，
// 与旧键的全量重渲染等价。
type KeyedSample = { s: SampleCandidateFE; key: string }
const sampleGroups = computed(() => {
  const list = filter.value === 'a'
    ? learn.samples.filter((s) => s.打分 >= TIER_A)
    : learn.samples
  const map = new Map<string, SampleCandidateFE[]>()
  for (const s of list) {
    const arr = map.get(s.场景)
    if (arr) arr.push(s)
    else map.set(s.场景, [s])
  }
  return [...map.entries()]
    .map(([场景, items]) => {
      items.sort((x, y) => y.打分 - x.打分)
      const keyed: KeyedSample[] = items.map((s, i) => ({
        s,
        key: `${场景}\u0000${s.出处}\u0000${i}`,
      }))
      return {
        场景,
        items: keyed,
        count: keyed.length,
        avg: Math.round(keyed.reduce((n, x) => n + x.s.打分, 0) / keyed.length),
        allPicked: keyed.every((x) => learn.isSamplePicked(x.s)),
      }
    })
    .sort((a, b) => b.avg - a.avg)
})

// ── R47-16（四十七轮）：分组渲染上限──
// 候选每卡含整段正文（reactive 数组 + DOM 双吃），服务端返回量不受前端控制；每组
// 默认渲染前 50 条，超出「显示剩余 N 条」按需展开（勾选/统计/全选仍面向全量 items，
// 仅渲染面截断——大书收割数千候选时 DOM 不失控）。
const GROUP_RENDER_CAP = 50
// 口径互引（重评-P3-17）：此处直接依赖 Vue 3 对 Set.add 的响应式插桩（无需重赋值）；
// ChatMessages.vue 的重赋值写法属防御性惯例，非响应性必需
const expandedGroups = ref(new Set<string>())
function visibleItems(g: { 场景: string; items: KeyedSample[] }): KeyedSample[] {
  if (expandedGroups.value.has(g.场景) || g.items.length <= GROUP_RENDER_CAP) return g.items
  return g.items.slice(0, GROUP_RENDER_CAP)
}
function expandGroup(scene: string): void {
  expandedGroups.value.add(scene)
}
// R0912-3 #23：expandedGroups 跨收割重置——组件实例随视图常驻，上一轮手动展开的大组
// 在新收割数据上仍全量渲染；收割跑完（loading 落 false）即清。commit 后列表收缩不推
// loading，展开态保留
watch(() => learn.loading, (v, old) => {
  if (old && !v) expandedGroups.value = new Set()
})

// ── 批量操作 ──
function selectAllTierA(): void {
  for (const s of learn.samples) {
    if (s.打分 >= TIER_A && !learn.isSamplePicked(s)) learn.toggleSample(s)
  }
}
function toggleGroup(items: KeyedSample[]): void {
  const allIn = items.every((x) => learn.isSamplePicked(x.s))
  for (const x of items) {
    if (allIn === learn.isSamplePicked(x.s)) learn.toggleSample(x.s)
  }
}
function clearAllPicks(): void {
  learn.clearPicks()
}
</script>

<template>
  <section v-if="learn.samples.length" class="sec">
    <div class="sec-bar">
      <h2 class="sec-title">样章候选</h2>
      <div class="filter-tabs">
        <button :class="{ on: filter === 'all' }" @click="filter = 'all'">全部</button>
        <button :class="{ on: filter === 'a' }" @click="filter = 'a'">仅 A 级（{{ scoreStats.a }}）</button>
      </div>
      <div class="batch-ops">
        <button class="text-btn" @click="selectAllTierA">全选 A 级</button>
        <button class="text-btn" @click="clearAllPicks">清空勾选</button>
      </div>
    </div>

    <div v-for="g in sampleGroups" :key="g.场景" class="scene-group">
      <!-- R72-12（二十轮 E-10）：分组头补键盘可达性（原仅 @click） -->
      <div
        class="group-head"
        role="button"
        tabindex="0"
        @keydown.enter.prevent="toggleGroup(g.items)"
        @keydown.space.prevent="toggleGroup(g.items)"
        @click="toggleGroup(g.items)"
      >
        <span class="scene-name">{{ g.场景 }}</span>
        <span class="group-meta">{{ g.count }} 章 · 均分 {{ g.avg }}</span>
        <span class="group-toggle" :class="{ all: g.allPicked }">
          <Check :size="12" />{{ g.allPicked ? '已全选' : '全选' }}
        </span>
      </div>
      <div class="cand-list">
        <div
          v-for="it in visibleItems(g)"
          :key="it.key"
          class="cand-card"
          :class="[tierOf(it.s.打分), { picked: learn.isSamplePicked(it.s) }]"
        >
          <div class="cand-head">
            <span class="score-badge">{{ it.s.打分 }}</span>
            <span class="src">{{ it.s.出处 }}</span>
            <input
              type="checkbox"
              :checked="learn.isSamplePicked(it.s)"
              @change="learn.toggleSample(it.s)"
              @click.stop
            />
          </div>
          <p class="cand-body">{{ it.s.正文 }}</p>
          <p v-if="it.s.技法指令" class="cand-tech">技法 · {{ it.s.技法指令 }}</p>
        </div>
        <!-- R47-16：分组渲染上限的展开钮（勾选/全选/统计仍面向全量 g.items） -->
        <button
          v-if="g.items.length > GROUP_RENDER_CAP && !expandedGroups.has(g.场景)"
          class="text-btn expand-more"
          @click="expandGroup(g.场景)"
        >
          显示剩余 {{ g.items.length - GROUP_RENDER_CAP }} 条
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 区段基础（与 LearnView 同式） */
.sec {
  margin-bottom: var(--size-4-6);
}
.sec-title {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  margin: 0 0 var(--size-4-3);
  font-size: var(--font-size-l);
  font-weight: 700;
  color: var(--text-muted);
}

/* 样章区工具栏 */
.sec-bar {
  display: flex;
  align-items: center;
  gap: var(--size-4-3);
  margin-bottom: var(--size-4-4);
  flex-wrap: wrap;
}
.sec-bar .sec-title {
  margin: 0;
}
.filter-tabs {
  display: flex;
  gap: 2px;
  background: var(--background-secondary);
  border-radius: var(--radius-m);
  padding: 2px;
}
.filter-tabs button {
  padding: 3px 10px;
  border: none;
  background: none;
  border-radius: var(--radius-s);
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.filter-tabs button.on {
  background: var(--background-primary);
  color: var(--text-normal);
  box-shadow: var(--shadow-s);
}
.batch-ops {
  display: flex;
  gap: var(--size-4-2);
  margin-left: auto;
}
.text-btn {
  padding: 3px 8px;
  border: none;
  background: none;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-s);
  transition: all var(--dur-fast) var(--ease-out);
}
.text-btn:hover {
  color: var(--text-accent);
  background: var(--background-modifier-hover);
}

/* 场景分组 */
.scene-group {
  margin-bottom: var(--size-4-4);
}
.group-head {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  padding: 5px 10px;
  margin-bottom: var(--size-4-2);
  background: var(--background-secondary);
  border-radius: var(--radius-s);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.group-head:hover {
  background: var(--background-modifier-hover);
}
.scene-name {
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-normal);
}
.group-meta {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.group-toggle {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.group-toggle.all {
  color: var(--text-accent);
}

/* 样章候选卡 */
.cand-list {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
}
.cand-card {
  border: 1px solid var(--background-modifier-border);
  border-left: 3px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: var(--background-primary);
  padding: var(--size-4-3);
  transition: border-color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
/* 左竖线按档着色 */
.cand-card.a { border-left-color: var(--dv-good); }
.cand-card.b { border-left-color: var(--dv-warn); }
.cand-card.c { border-left-color: var(--background-modifier-border-active); }
.cand-card.picked {
  background: var(--background-modifier-active-hover);
  border-color: var(--interactive-accent);
  border-left-color: var(--interactive-accent);
}
.cand-head {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  margin-bottom: var(--size-4-2);
}
.score-badge {
  font-size: var(--font-size-s);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  font-family: var(--font-monospace);
  min-width: 30px;
  text-align: center;
  padding: 1px 6px;
  border-radius: var(--radius-s);
}
.cand-card.a .score-badge {
  color: var(--dv-good);
  background: color-mix(in srgb, var(--dv-good) 14%, transparent);
}
.cand-card.b .score-badge {
  color: var(--dv-warn);
  background: color-mix(in srgb, var(--dv-warn) 14%, transparent);
}
.cand-card.c .score-badge {
  color: var(--text-muted);
  background: var(--background-modifier-hover);
}
.src {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.cand-head input[type='checkbox'] {
  margin-left: auto;
  width: 15px;
  height: 15px;
  accent-color: var(--interactive-accent);
  cursor: pointer;
}
.cand-body {
  margin: 0;
  font-size: var(--font-size-m);
  line-height: 1.85;
  color: var(--text-normal);
  font-family: var(--prose-font);
  white-space: pre-wrap;
  /* 内存核查（2026-08-25 M-P3-15）：候选正文默认 6 行截断（纯样式，store 数据
     形态不动；样章是整章级长文，全量渲染放大卡片高度与排版成本） */
  display: -webkit-box;
  -webkit-line-clamp: 6;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.cand-tech {
  margin: var(--size-4-2) 0 0;
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
</style>
