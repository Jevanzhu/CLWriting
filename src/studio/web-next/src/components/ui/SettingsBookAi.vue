<script setup lang="ts">
// 「本书」页 · AI 写作覆盖组（IA 重组前是 SettingsAi 的本书组）：
// 文风注入/自动确认细纲/批量写作章数/单章调用上限的「本书使用独立设定」覆盖，全局默认在「AI 写作」页。
// 生效链 book.yaml 对应键 → global.json（prefs store）→ 硬编码回落。
// 父组件（本书页）已用 v-if="hasBook" 保证有书打开；本组件独立拉 config（raw watch）。
import { ref, computed, watch, inject } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import { useUiStore } from '../../stores/ui'
import { usePrefsStore } from '../../stores/prefs'
import { getConfig } from '../../api/books'
import { SAVE_CONFIG_KEY } from './settings-context'

const ui = useUiStore()
const ws = useWorkspaceStore()
// 全局默认值来自 prefs store（main.ts 在 mount 前 await init()，设置打开时必已就绪）
const prefs = usePrefsStore()
const saveConfig = inject(SAVE_CONFIG_KEY)!

// ── 本书覆盖（book.yaml style/auto/budget 段四键；null = 未设 = 跟随全局）──
const bookInjection = ref<'light' | 'heavy' | null>(null)
const bookConfirmOutline = ref<boolean | null>(null)
const bookBatchSize = ref<number | null>(null)
const bookCalls = ref<number | null>(null)

// 当前生效值（本书覆盖 ?? 全局默认）：本书开关 desc 与覆盖初始化用
const effInjection = computed(() => bookInjection.value ?? prefs.styleInjection)
const effConfirmOutline = computed(() => bookConfirmOutline.value ?? prefs.autoConfirmOutline)
const effBatchSize = computed(() => bookBatchSize.value ?? prefs.aiBatchSize)
const effCalls = computed(() => bookCalls.value ?? prefs.callsPerChapter)
// 组开关判定：组内任一键在 raw config 中已设
const bookOverride = computed(
  () =>
    bookInjection.value !== null ||
    bookConfirmOutline.value !== null ||
    bookBatchSize.value !== null ||
    bookCalls.value !== null,
)

/** 本书开关 desc：组内生效值拼成一行摘要（自动确认细纲尚未上线，不入摘要） */
const effSummary = computed(
  () => `${effInjection.value === 'light' ? '轻' : '重'} · 批量 ${effBatchSize.value} 章 · 上限 ${effCalls.value} 次`,
)

watch(
  () => [ui.settingsOpen, ws.bookName] as const,
  async ([open, name]) => {
    if (!open) return
    // 无书打开：覆盖复位（父组件此时整页空态，本组不可见，复位只为切书不留旧值）
    if (!name) {
      bookInjection.value = null
      bookConfirmOutline.value = null
      bookBatchSize.value = null
      bookCalls.value = null
      return
    }
    try {
      const cfg = await getConfig(name)
      // raw 形态契约：13 键未设时为 undefined——只认合法类型，脏值按跟随全局展示
      bookInjection.value =
        cfg.style?.injection === 'light' || cfg.style?.injection === 'heavy' ? cfg.style.injection : null
      bookConfirmOutline.value = typeof cfg.auto?.confirm_outline === 'boolean' ? cfg.auto.confirm_outline : null
      bookBatchSize.value =
        typeof cfg.auto?.batch_size === 'number' && cfg.auto.batch_size >= 1 ? cfg.auto.batch_size : null
      bookCalls.value =
        typeof cfg.budget?.calls_per_chapter === 'number' && cfg.budget.calls_per_chapter >= 1
          ? cfg.budget.calls_per_chapter
          : null
    } catch {
      /* 读不到就按跟随全局展示 */
    }
  },
  { immediate: true },
)

/** 「本书使用独立设定」开关：off = 跟随全局（删四键）；on = 组内全部键用当前生效值写入。
 *  auto 段成对写 confirm_outline/batch_size、budget 写 calls_per_chapter、style 写 injection——
 *  展开保留段内他键（auto 段还有关系图键，归「本书」页的智能分析组管）。 */
function onOverrideToggle(e: Event): void {
  const on = (e.target as HTMLInputElement).checked
  if (on) {
    bookInjection.value = effInjection.value
    bookConfirmOutline.value = effConfirmOutline.value
    bookBatchSize.value = effBatchSize.value
    bookCalls.value = effCalls.value
    void saveConfig((c) => {
      c.style = { ...(c.style ?? {}), injection: effInjection.value }
      c.auto = { ...(c.auto ?? {}), confirm_outline: effConfirmOutline.value, batch_size: effBatchSize.value }
      c.budget = { ...(c.budget ?? {}), calls_per_chapter: effCalls.value }
    })
  } else {
    bookInjection.value = null
    bookConfirmOutline.value = null
    bookBatchSize.value = null
    bookCalls.value = null
    void saveConfig((c) => {
      if (c.style) delete c.style.injection
      if (c.auto) {
        delete c.auto.confirm_outline
        delete c.auto.batch_size
      }
      if (c.budget) delete c.budget.calls_per_chapter
    })
  }
}

// ── 本书覆盖子项（override 已开；clamp 同全局 setter 口径）──

function setBookInjection(mode: 'light' | 'heavy'): void {
  bookInjection.value = mode
  void saveConfig((c) => {
    c.style = { ...(c.style ?? {}), injection: mode }
  })
}
function onBookConfirmToggle(e: Event): void {
  const v = (e.target as HTMLInputElement).checked
  bookConfirmOutline.value = v
  void saveConfig((c) => {
    c.auto = { ...(c.auto ?? {}), confirm_outline: v }
  })
}
function onBookBatchInput(e: Event): void {
  const raw = Number((e.target as HTMLInputElement).value)
  const v = Math.min(20, Math.max(1, Math.round(raw)))
  bookBatchSize.value = v
  void saveConfig((c) => {
    c.auto = { ...(c.auto ?? {}), batch_size: v }
  })
}
function onBookCallsInput(e: Event): void {
  const raw = Number((e.target as HTMLInputElement).value)
  const v = Math.min(50, Math.max(1, Math.round(raw)))
  bookCalls.value = v
  void saveConfig((c) => {
    c.budget = { ...(c.budget ?? {}), calls_per_chapter: v }
  })
}
</script>

<template>
  <div class="cfg-card-head">AI 写作</div>
  <section class="cfg-card">
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">本书使用独立设定</div>
        <div class="setting-item-desc">
          当前生效 {{ effSummary }}{{ bookOverride ? '' : '（跟随全局默认）' }}
        </div>
      </div>
      <div class="setting-item-control">
        <label class="switch">
          <input type="checkbox" aria-label="本书使用独立设定" :checked="bookOverride" @change="onOverrideToggle($event)" />
          <span class="switch-slider"></span>
        </label>
      </div>
    </div>
    <template v-if="bookOverride">
      <div class="setting-item sub">
        <div class="setting-item-info">
          <div class="setting-item-name">文风注入</div>
        </div>
        <div class="setting-item-control">
          <div class="seg">
            <button :class="{ on: bookInjection === 'light' }" @click="setBookInjection('light')">轻</button>
            <button :class="{ on: bookInjection === 'heavy' }" @click="setBookInjection('heavy')">重</button>
          </div>
        </div>
      </div>
      <div class="setting-item sub">
        <div class="setting-item-info">
          <div class="setting-item-name">自动确认细纲 <span class="tag-soon">即将支持</span></div>
        </div>
        <div class="setting-item-control">
          <label class="switch">
            <input type="checkbox" aria-label="自动确认细纲" :checked="bookConfirmOutline ?? effConfirmOutline" @change="onBookConfirmToggle($event)" />
            <span class="switch-slider"></span>
          </label>
        </div>
      </div>
      <div class="setting-item sub">
        <div class="setting-item-info">
          <div class="setting-item-name">批量写作章数</div>
        </div>
        <div class="setting-item-control">
          <input class="num-input" type="number" min="1" max="20" step="1" aria-label="批量写作章数" :value="bookBatchSize ?? effBatchSize" @change="onBookBatchInput($event)" />
          <span class="val-suffix">章</span>
        </div>
      </div>
      <div class="setting-item sub">
        <div class="setting-item-info">
          <div class="setting-item-name">单章调用上限</div>
        </div>
        <div class="setting-item-control">
          <input class="num-input" type="number" min="1" max="50" step="1" aria-label="单章调用上限" :value="bookCalls ?? effCalls" @change="onBookCallsInput($event)" />
          <span class="val-suffix">次</span>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.tag-soon {
  padding: 1px 7px;
  font-size: var(--font-size-xxs);
  font-weight: 600;
  border-radius: 99px;
  background: var(--background-modifier-hover);
  color: var(--text-faint);
}
</style>
