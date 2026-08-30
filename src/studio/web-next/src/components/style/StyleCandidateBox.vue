<script setup lang="ts">
// 文风候选箱卡（StyleView 拆分 P2-5 ③ 候选箱段）：四源管线汇流可视化，确认/忽略入库。
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { Inbox, Sparkles, X, Check, ChevronRight } from 'lucide-vue-next'
import { useStyleStore } from '../../stores/style'
import { useUiStore } from '../../stores/ui'
import { friendlyError } from '../../shared/error'
import EmptyState from '../ui/EmptyState.vue'
import type { StyleCandidateFE } from '../../api/style'

const style = useStyleStore()
const ui = useUiStore()

const pending = computed(() => style.candidates.filter((c) => c.状态 === '待确认'))
const ignored = computed(() => style.candidates.filter((c) => c.状态 === '已忽略'))
const showIgnored = ref(false)
const harvesting = ref(false)
const acting = ref<string | null>(null) // 正在确认/忽略的候选路径（防连点）

/** 候选证据行（源1 章号/相似度/频次；源2 漂移说明在说明字段单独展示） */
function evidenceOf(c: StyleCandidateFE): string {
  const parts: string[] = []
  if (c.章号 !== undefined) parts.push(`第${c.章号}章`)
  if (c.相似度 !== undefined) parts.push(`与AI版相似度${c.相似度}%`)
  if (c.频次 !== undefined) parts.push(`${c.频次}处文档中删掉了它`)
  return parts.join(' · ')
}

// R26-73（二十六轮）：三处动作 toast 前补书名复检（对齐 StyleAcceptancePanel.onAnalyze
// 的入口捕获模式）——本组件无 bookName prop，守卫读共享 style store 的活书名（StyleView
// :key 重建后死实例的 store 引用仍活着，store.bookName 已是新书）。收割/确认/忽略在途
// 切书后，A 书的结果与失败 toast 均不落 B 书界面。
// R28-25（二十八轮）：书名守卫补 armed 门——路由变更 → StyleView :key 重建 → 子组件
// setup → StyleView onMounted 才 style.load（入口同步置 store.bookName）之间存在一个
// 渲染 tick 窗口，窗口内 store.bookName 仍滞留旧书；死实例在途动作恰在该窗口 settle 时
// 「bookName 匹配」放行，A 书 toast 落 B 书界面。armed 以路由活书名为代次源即时判定
// （等价代次比对）：路由在切书瞬间即变、且是全局响应式对象，死实例闭包读到的也是活值，
// 窗口期动作直接吞掉；store.bookName 匹配照旧保留（armed && bookName 双门）。
const route = useRoute()
function armed(book: string): boolean {
  return String(route.params.name ?? '') === book
}
async function onHarvest(): Promise<void> {
  if (harvesting.value) return
  const book = style.bookName
  harvesting.value = true
  try {
    const r = await style.harvest()
    if (!armed(book) || style.bookName !== book) return // R28-25：armed 门 + 书名门
    if (r.created > 0) {
      ui.toast(`收割完成：${r.created}条新候选${r.skipped > 0 ? `（${r.skipped}条重复已跳过）` : ''}`, 'success')
    } else {
      ui.toast(r.skipped > 0 ? `无新候选（${r.skipped}条重复已跳过）` : '暂无可收割的信号', 'info')
    }
  } catch (e) {
    if (!armed(book) || style.bookName !== book) return
    ui.toast(friendlyError(e), 'error')
  } finally {
    harvesting.value = false
  }
}
async function onConfirm(c: StyleCandidateFE): Promise<void> {
  if (acting.value) return
  const book = style.bookName
  acting.value = c._path
  try {
    await style.confirm(c._path)
    if (!armed(book) || style.bookName !== book) return
    ui.toast(`已收录：${c.类型}`, 'success')
  } catch (e) {
    if (!armed(book) || style.bookName !== book) return
    ui.toast(friendlyError(e), 'error')
  } finally {
    acting.value = null
  }
}
async function onIgnore(c: StyleCandidateFE): Promise<void> {
  if (acting.value) return
  const book = style.bookName
  acting.value = c._path
  try {
    await style.ignore(c._path)
  } catch (e) {
    if (!armed(book) || style.bookName !== book) return
    ui.toast(friendlyError(e), 'error')
  } finally {
    acting.value = null
  }
}
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <Inbox :size="14" /> <span>候选箱</span>
      <span v-if="pending.length > 0" class="head-count">{{ pending.length }}待确认</span>
      <div class="head-actions">
        <span class="token-chip free">免费</span>
        <button class="btn-primary" :disabled="harvesting" @click="onHarvest">
          <Sparkles :size="13" :class="{ spin: harvesting }" />
          {{ harvesting ? '收割中…' : '收割' }}
        </button>
      </div>
    </div>
    <p class="panel-hint">
      收割从你的改稿痕迹和文风偏差中提炼候选；AI深度分析的口癖和建议也会汇入。确认后收录，忽略后不再提醒。
    </p>

    <div v-if="pending.length > 0" class="cand-list">
      <div v-for="c in pending" :key="c._path" class="cand-card">
        <div class="cc-top">
          <span class="kind-badge" :data-kind="c.类型">{{ c.类型 }}候选</span>
          <span class="src-dot">{{ c.来源 }}</span>
          <span v-if="evidenceOf(c)" class="cc-evidence">{{ evidenceOf(c) }}</span>
        </div>
        <div v-if="c.说明" class="cc-note">{{ c.说明 }}</div>
        <template v-if="c.AI版">
          <div class="cc-compare">
            <div class="cc-side ai">
              <div class="cc-side-label">AI版</div>
              <div class="cc-side-text">{{ c.AI版 }}</div>
            </div>
            <div class="cc-side you">
              <div class="cc-side-label">你的重写</div>
              <div class="cc-side-text">{{ c.正文 }}</div>
            </div>
          </div>
        </template>
        <div v-else class="cc-text">{{ c.正文 }}</div>
        <div class="cc-actions">
          <button class="btn-ghost" :disabled="acting === c._path" @click="onIgnore(c)">
            <X :size="13" /> 忽略
          </button>
          <button class="btn-primary" :disabled="acting === c._path" @click="onConfirm(c)">
            <Check :size="13" /> 确认收录
          </button>
        </div>
      </div>
    </div>
    <EmptyState
      v-else
      :icon="Inbox"
      title="没有待确认的候选"
      text="写作和改稿会自然积累信号，点「收割」提炼一轮"
    />

    <button v-if="ignored.length > 0" class="ignored-toggle" @click="showIgnored = !showIgnored">
      <ChevronRight :size="13" :class="{ open: showIgnored }" />
      已忽略 {{ ignored.length }}条
    </button>
    <div v-if="showIgnored" class="cand-list dim">
      <div v-for="c in ignored" :key="c._path" class="cand-card slim">
        <div class="cc-top">
          <span class="kind-badge" :data-kind="c.类型">{{ c.类型 }}</span>
          <span class="cc-text-inline">{{ c.正文 }}</span>
          <button class="btn-ghost" :disabled="acting === c._path" @click="onConfirm(c)">仍要收录</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* ══ 面板基础（对齐 OverviewView 卡片语言）══ */
.panel {
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  padding: 18px 20px;
  animation: clw-fade-up var(--dur-fast) var(--ease-out) both;
}

.head-count {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-accent);
}
.head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.panel-hint {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  margin: -6px 0 12px;
  line-height: 1.6;
}

/* ══ 通用按钮 ══ */
.btn-ghost,
.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
  padding: 4px 10px;
  border-radius: var(--radius-s);
  cursor: pointer;
  border: 1px solid var(--background-modifier-border);
  background: transparent;
  color: var(--text-muted);
  white-space: nowrap;
}
.btn-ghost:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.btn-primary {
  border-color: transparent;
  background: var(--interactive-accent);
  color: var(--text-on-accent);
}
.btn-primary:hover:not(:disabled) {
  background: var(--interactive-accent-hover);
}
.btn-ghost:disabled,
.btn-primary:disabled {
  opacity: 0.45;
  cursor: default;
}
.spin {
  animation: clw-spin 1s linear infinite;
}

/* ══ token 徽标（零 token / 耗 token 区分同名打架）══ */
.token-chip {
  font-size: var(--font-size-xxs);
  padding: 1px 7px;
  border-radius: 99px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.token-chip.free {
  color: var(--dv-good);
  background: color-mix(in srgb, var(--dv-good) 12%, transparent);
}

/* ══ ③ 候选箱 ══ */
.cand-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cand-list.dim {
  opacity: 0.75;
  margin-top: 8px;
}
.cand-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: var(--background-secondary);
}
.cand-card.slim {
  padding: 8px 14px;
}
.cc-top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.cc-evidence {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.cc-note {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.cc-text {
  font-size: var(--font-size-s);
  color: var(--text-normal);
  line-height: 1.7;
}
.cc-text-inline {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cc-compare {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.cc-side {
  padding: 9px 11px;
  border-radius: var(--radius-s);
  border: 1px solid var(--background-modifier-border);
}
.cc-side.ai {
  background: var(--background-primary);
}
.cc-side.you {
  background: color-mix(in srgb, var(--text-accent) 5%, var(--background-primary));
  border-color: color-mix(in srgb, var(--text-accent) 25%, var(--background-modifier-border));
}
.cc-side-label {
  font-size: var(--font-size-xxs);
  font-weight: 600;
  color: var(--text-faint);
  margin-bottom: 4px;
}
.cc-side.you .cc-side-label {
  color: var(--text-accent);
}
.cc-side-text {
  font-size: var(--font-size-xs);
  color: var(--text-normal);
  line-height: 1.7;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.cc-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.ignored-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 10px;
  border: none;
  background: transparent;
  color: var(--text-faint);
  font-size: var(--font-size-xs);
  cursor: pointer;
  padding: 2px 0;
}
.ignored-toggle:hover {
  color: var(--text-muted);
}
.ignored-toggle svg {
  transition: transform var(--dur-fast) var(--ease-out);
}
.ignored-toggle svg.open {
  transform: rotate(90deg);
}

/* 类型徽标（样章紫/手法绿/反例橙/禁词红） */
.kind-badge {
  font-size: var(--font-size-xxs);
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 99px;
  flex-shrink: 0;
}
.kind-badge[data-kind='样章'] {
  color: var(--text-accent);
  background: color-mix(in srgb, var(--text-accent) 12%, transparent);
}
.kind-badge[data-kind='手法'] {
  color: var(--dv-good);
  background: color-mix(in srgb, var(--dv-good) 12%, transparent);
}
.kind-badge[data-kind='反例'] {
  color: var(--dv-warn);
  background: color-mix(in srgb, var(--dv-warn) 12%, transparent);
}
.kind-badge[data-kind='禁词'] {
  color: var(--text-error);
  background: color-mix(in srgb, var(--text-error) 12%, transparent);
}
.src-dot {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.src-dot::before {
  content: '◦ ';
}

@media (max-width: 860px) {
  .cc-compare {
    grid-template-columns: 1fr;
  }
}

</style>
