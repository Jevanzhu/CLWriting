<script lang="ts">
import type { Component } from 'vue'
import type { CheckItem } from '../../api/check'
import type { ReviewIssueFE } from '../../api/review'

/** 条目两种形态：机检命中（message）与三审意见（issue）——按字段判别（互斥字段见各自 API 类型）。 */
export type IssueRow = CheckItem | ReviewIssueFE

/** 一组问题条目的渲染模型（CheckPanel 红/黄项、ReviewPanel 阻断/警告项直出）。
 * 调用方消费 key（v-for 键）、label/tone/icon/count/omitted（组头与容器），
 * view/keys 为渲染上限切片后的条目面与全量稳定键表（按下标对齐）。 */
export interface IssueGroupModel {
  key: string
  label: string
  icon: Component
  tone: 'red' | 'yellow'
  count: number
  view: readonly IssueRow[]
  keys: readonly string[]
  keyPrefix: string
  omitted: number
}
</script>

<script setup lang="ts">
// 机检 / 三审「一组问题条目」骨架单源：组头（图标 + 标签 + 全量计数）+ 条目列表 + 截断省略提示行。
// 两面板此前各持一份逐字重复的组模板与组样式，抽件后单源。
// 不变量（行为/视觉零变）：DOM 层级、类名（check-group/rev-group、check-item/rev-item(--tone)、
// item-* 族、fp-btn、cap-hint）、文案（含全角括号与省略提示）、键构造（keyPrefix + 全量稳定键）
// 与交互（误报按钮禁用/标题/点击）逐字保留——两面板的原两处 DOM 除组件边界外不可区分。
import { ThumbsDown } from 'lucide-vue-next'

/** 行形态判别：两形态各有互斥必填字段（CheckItem.message / ReviewIssueFE.issue），
 * 判别用于内容分支与行类名，避免在模板里写断言。 */
function isReviewRow(row: IssueRow): row is ReviewIssueFE {
  return 'issue' in row
}

const props = defineProps<{
  /** 组语义：check = 机检命中行（含误报标记钮）、review = 三审意见行；须与本组条目形态一致 */
  variant: 'check' | 'review'
  /** 组模型（组头计数与切片面口径见 IssueGroupModel） */
  group: IssueGroupModel
  /** variant=check：已标误报的 checkId 集（灰显 + 置灰） */
  flagged?: ReadonlySet<string>
  /** variant=check：有标记在途（全行置灰，防并发重复标记）；review 组不消费 */
  flagBusy?: boolean
  /** variant=review：镜头 id → 人话（映射单源在 ReviewPanel——缺视角横幅同用同一张表） */
  lensLabel?: (lens: string) => string
}>()

const emit = defineEmits<{ flag: [checkId: string] }>()

/** 未传 flagged 时的空集（组内不消费灰显） */
const EMPTY_FLAGGED: ReadonlySet<string> = new Set()
const flaggedIds = (): ReadonlySet<string> => props.flagged ?? EMPTY_FLAGGED
const flagBusy = (): boolean => props.flagBusy === true

/** 行类名与组类名逐字保留原面板拼法（tone 修饰同理） */
function rowClass(row: IssueRow): string {
  const base = isReviewRow(row) ? 'rev-item' : 'check-item'
  return `${base} ${base}--${props.group.tone}`
}
function groupClass(): string {
  return props.variant === 'check' ? 'check-group' : 'rev-group'
}

/** severity 人话（S1/S2→重点，其余→参考；内部编号不暴露给作者） */
function severityClass(s: string): string {
  if (s === 'S1' || s === 'S2') return 'sev-high'
  return 'sev-low'
}
function severityLabel(s: string): string {
  return s === 'S1' || s === 'S2' ? '重点' : '参考'
}
/** 镜头人话；未传入映射表时按原值（原 lensLabel 缺省分支同语义） */
function lensText(lens: string): string {
  return props.lensLabel ? props.lensLabel(lens) : lens
}
</script>

<template>
  <div :class="groupClass()">
    <div class="group-label" :class="`group-label--${group.tone}`">
      <component :is="group.icon" :size="13" />
      <span>{{ group.label }}（{{ group.count }}）</span>
    </div>
    <div v-for="(it, i) in group.view" :key="group.keyPrefix + group.keys[i]" :class="rowClass(it)">
      <template v-if="isReviewRow(it)">
        <div class="item-head">
          <span class="item-sev" :class="severityClass(it.severity)">{{ severityLabel(it.severity) }}</span>
          <span class="item-lens">{{ lensText(it.lens) }}</span>
          <span v-if="it.location" class="item-loc">{{ it.location }}</span>
        </div>
        <div class="item-issue">{{ it.issue }}</div>
        <div v-if="it.evidence.length > 0" class="item-evidence">「{{ it.evidence.join('；') }}」</div>
        <div v-if="it.fix" class="item-fix">建议：{{ it.fix }}</div>
      </template>
      <template v-else>
        <div class="item-msg">{{ it.message }}</div>
        <button
          class="fp-btn"
          :class="{ done: flaggedIds().has(it.checkId) }"
          :disabled="flagBusy() || flaggedIds().has(it.checkId)"
          :title="flaggedIds().has(it.checkId) ? '已标记误报' : '标记为误报（喂语料回归库）'"
          @click="emit('flag', it.checkId)"
        >
          <ThumbsDown :size="12" />
          {{ flaggedIds().has(it.checkId) ? '已标误报' : '误报' }}
        </button>
      </template>
    </div>
    <!-- RENDER_CAP 截断省略提示行（数据面计数不虚减） -->
    <div v-if="group.omitted > 0" class="cap-hint">已省略 {{ group.omitted }} 项</div>
  </div>
</template>

<style scoped>
/* 组容器（check-group / rev-group 两面板类名逐字保留，声明逐字相同故双选择器单条） */
.check-group,
.rev-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
/* 条目公共盒（两面板声明逐字相同）；check 行另需横向两端布局（正文 + 误报钮） */
.check-item,
.rev-item {
  padding: 6px 8px;
  border-radius: var(--radius-s);
  font-size: var(--font-size-s);
  line-height: 1.5;
}
.check-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.check-item--red,
.rev-item--red {
  background: color-mix(in srgb, var(--text-error) 8%, transparent);
  border-left: 2px solid var(--text-error);
}
.check-item--yellow,
.rev-item--yellow {
  background: color-mix(in srgb, var(--text-warning) 8%, transparent);
  border-left: 2px solid var(--text-warning);
}
/* 条目正文（机检 .item-msg / 三审 .item-issue 声明逐字相同） */
.item-msg,
.item-issue {
  color: var(--text-normal);
}
.fp-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  font-size: var(--font-size-xxs);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.fp-btn:hover:not(:disabled) {
  color: var(--text-normal);
  border-color: var(--text-muted);
}
.fp-btn:disabled {
  cursor: default;
  opacity: 0.75;
}
.fp-btn.done {
  color: var(--text-accent, inherit);
}
/* 三审条目结构 */
.item-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 3px;
  flex-wrap: wrap;
}
.item-sev {
  font-size: var(--font-size-xxs);
  font-weight: 700;
  padding: 1px 4px;
  border-radius: var(--radius-s);
}
.sev-high {
  background: var(--text-error);
  color: var(--text-on-accent, #fff);
}
.sev-low {
  background: var(--background-modifier-hover);
  color: var(--text-muted);
}
.item-lens {
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
}
.item-loc {
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
  font-style: italic;
}
.item-evidence {
  margin-top: 2px;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.item-fix {
  margin-top: 2px;
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
</style>
