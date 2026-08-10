<script setup lang="ts">
// 文风视图（文风系统重整 S7）：定标 / 条目库 / 候选箱 / 验收 四段式。
// 候选箱是四源管线的汇流可视化；确认/新增是仅有的入库通道（品味归人）。
// 机检重扫零 AI；AI 语义分析耗 token 且完成时后端自动落源3候选。
import { computed, onMounted, ref, watch } from 'vue'
import {
  SlidersHorizontal,
  LibraryBig,
  Inbox,
  ClipboardCheck,
  Snowflake,
  Sparkles,
  GraduationCap,
  Plus,
  X,
  Check,
  Trash2,
  RefreshCw,
  ChevronRight,
  TriangleAlert,
} from 'lucide-vue-next'
import { useStyleStore } from '../stores/style'
import { useUiStore } from '../stores/ui'
import { useWorkspaceStore } from '../stores/workspace'
import { getConfig, putConfig } from '../api/books'
import { getContent, putContent } from '../api/documents'
import { ApiError } from '../api/client'
import { runStyleAnalysis, type StylePayload } from '../api/analysis'
import EmptyState from '../components/ui/EmptyState.vue'
import type { EntryKindFE, StyleCandidateFE } from '../api/style'
import { friendlyError } from '../shared/error'

const props = defineProps<{ bookName: string }>()
const style = useStyleStore()
const ui = useUiStore()
const ws = useWorkspaceStore()

const ENTRY_KINDS: EntryKindFE[] = ['样章', '手法', '反例', '禁词']

// ── 加载（切书/进视图；迁移发生时 toast 告知）──
async function load(): Promise<void> {
  try {
    const migration = await style.load(props.bookName)
    if (migration) {
      ui.toast(`文风库已升级：${migration.migrated}项旧数据迁入条目库`, 'success')
    }
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  }
}
onMounted(load)
watch(() => props.bookName, load)

// ══ ① 定标 ══════════════════════════════════
const rules = computed(() => style.config?.rules ?? {})
const baseline = computed(() => style.config?.baseline ?? null)
const freezing = ref(false)

function fmtDate(iso: string): string {
  return iso.slice(0, 10)
}
async function onFreeze(): Promise<void> {
  if (freezing.value) return
  const ok = await ui.ask({
    title: baseline.value ? '重新建立文风基准' : '建立文风基准',
    message: '以当前样章按场景重新提取你的文风特征，替换之前的基准。后续偏差检测将以新基准为准。',
    confirmText: '建立',
  })
  if (!ok) return
  freezing.value = true
  try {
    await style.freeze()
    ui.toast('文风基准已建立', 'success')
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  } finally {
    freezing.value = false
  }
}

// 注入强度（book.yaml style.injection；从设置 AI 区挪入定标段）
const injection = computed(() => style.config?.injection ?? 'light')
async function onInjection(v: 'light' | 'heavy'): Promise<void> {
  if (injection.value === v) return
  try {
    const cfg = await getConfig(props.bookName)
    if (!cfg.style) cfg.style = {}
    cfg.style.injection = v
    await putConfig(props.bookName, cfg)
    if (style.config) style.config.injection = v
    ui.toast('参考强度已保存', 'success')
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  }
}

// 铁律原文编辑（文风/文风铁律.md 纯配置；折叠展开，保存后重拉阈值）
const RULES_PATH = '文风/文风铁律.md'
const editingRules = ref(false)
const rulesText = ref('')
const rulesOrig = ref('')
const rulesMissing = ref(false)
const rulesSaving = ref(false)
const rulesDirty = computed(() => rulesText.value !== rulesOrig.value)
async function toggleRulesEdit(): Promise<void> {
  if (editingRules.value) {
    editingRules.value = false
    return
  }
  rulesMissing.value = false
  try {
    rulesText.value = await getContent(props.bookName, RULES_PATH)
    rulesOrig.value = rulesText.value
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      rulesMissing.value = true
      rulesText.value = ''
      rulesOrig.value = ''
    } else {
      ui.toast(friendlyError(e), 'error')
      return
    }
  }
  editingRules.value = true
}
async function saveRules(): Promise<void> {
  if (rulesSaving.value) return
  rulesSaving.value = true
  try {
    if (rulesMissing.value) {
      await putContent(props.bookName, RULES_PATH, '')
      rulesMissing.value = false
    }
    await putContent(props.bookName, RULES_PATH, rulesText.value)
    rulesOrig.value = rulesText.value
    ui.toast('文风铁律已保存', 'success')
    await style.load(props.bookName) // 阈值可能已改，重拉定标数据
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  } finally {
    rulesSaving.value = false
  }
}

// ══ ② 条目库 ════════════════════════════════
const kindFilter = ref<EntryKindFE | 'all'>('all')
const sceneFilter = ref<string>('all')
const sourceFilter = ref<string>('all')

const scenes = computed(() => [...new Set(style.entries.map((e) => e.场景))])
const sources = computed(() => [...new Set(style.entries.map((e) => e.来源))])
const filteredEntries = computed(() =>
  style.entries.filter(
    (e) =>
      (kindFilter.value === 'all' || e.类型 === kindFilter.value) &&
      (sceneFilter.value === 'all' || e.场景 === sceneFilter.value) &&
      (sourceFilter.value === 'all' || e.来源 === sourceFilter.value),
  ),
)

// 新增表单（源4 作者手动直达入库）
const adding = ref(false)
const draft = ref<{ 类型: EntryKindFE; 场景: string; 说明: string; 正文: string }>({
  类型: '手法',
  场景: '',
  说明: '',
  正文: '',
})
async function submitAdd(): Promise<void> {
  if (!draft.value.正文.trim()) {
    ui.toast('正文不能为空', 'error')
    return
  }
  try {
    await style.add({
      类型: draft.value.类型,
      正文: draft.value.正文.trim(),
      ...(draft.value.场景.trim() ? { 场景: draft.value.场景.trim() } : {}),
      ...(draft.value.说明.trim() ? { 说明: draft.value.说明.trim() } : {}),
    })
    ui.toast('已存入条目库', 'success')
    adding.value = false
    draft.value = { 类型: '手法', 场景: '', 说明: '', 正文: '' }
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  }
}
async function onRemove(path: string, text: string): Promise<void> {
  const ok = await ui.ask({
    title: '删除条目',
    message: `删除「${text.slice(0, 24)}${text.length > 24 ? '…' : ''}」？此操作不可撤销。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await style.remove(path)
    ui.toast('已删除', 'success')
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  }
}

// ══ ③ 候选箱 ════════════════════════════════
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

async function onHarvest(): Promise<void> {
  if (harvesting.value) return
  harvesting.value = true
  try {
    const r = await style.harvest()
    if (r.created > 0) {
      ui.toast(`收割完成：${r.created}条新候选${r.skipped > 0 ? `（${r.skipped}条重复已跳过）` : ''}`, 'success')
    } else {
      ui.toast(r.skipped > 0 ? `无新候选（${r.skipped}条重复已跳过）` : '暂无可收割的信号', 'info')
    }
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  } finally {
    harvesting.value = false
  }
}
async function onConfirm(c: StyleCandidateFE): Promise<void> {
  if (acting.value) return
  acting.value = c._path
  try {
    await style.confirm(c._path)
    ui.toast(`已收录：${c.类型}`, 'success')
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  } finally {
    acting.value = null
  }
}
async function onIgnore(c: StyleCandidateFE): Promise<void> {
  if (acting.value) return
  acting.value = c._path
  try {
    await style.ignore(c._path)
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  } finally {
    acting.value = null
  }
}

// ══ ④ 验收 ══════════════════════════════════
const rescanning = ref(false)
async function onRescan(): Promise<void> {
  if (rescanning.value) return
  rescanning.value = true
  try {
    await style.rescan()
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  } finally {
    rescanning.value = false
  }
}

const aiOff = computed(() => ui.aiAvailable === false)
const analyzing = ref(false)
const aiResult = ref<StylePayload | null>(null)
async function onAnalyze(): Promise<void> {
  if (analyzing.value) return
  analyzing.value = true
  try {
    const r = await runStyleAnalysis(props.bookName)
    aiResult.value = r.envelope.payload as StylePayload
    if (r.styleCandidates > 0) {
      await style.load(props.bookName)
      ui.toast(`分析完成：口癖和建议已生成${r.styleCandidates}条候选`, 'success')
    } else {
      ui.toast('分析完成', 'success')
    }
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  } finally {
    analyzing.value = false
  }
}

/** 序列 → sparkline 折线点（min-max 归一化到 viewBox 100×24，上留 2 下留 2） */
function sparkPoints(series: number[]): string {
  if (series.length === 0) return ''
  if (series.length === 1) return '0,12 100,12'
  const min = Math.min(...series)
  const max = Math.max(...series)
  const span = max - min || 1
  return series
    .map((v, i) => {
      const x = (i / (series.length - 1)) * 100
      const y = 22 - ((v - min) / span) * 20
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}
const unit = computed(() => '章')
function avg(series: number[]): number {
  return series.length ? series.reduce((a, b) => a + b, 0) / series.length : 0
}
</script>

<template>
  <div class="sv-scroll">
    <div class="sv">
      <!-- ── ① 定标 ── -->
      <section class="panel">
        <div class="panel-head">
          <SlidersHorizontal :size="14" /> <span>定标</span>
          <span class="head-note">检测标准与参考方式</span>
        </div>
        <div class="anchor-body">
          <div class="anchor-chips">
            <span class="a-chip">单句 ≤{{ rules.maxSentenceLen ?? '—' }} 字</span>
            <span class="a-chip">形容词堆叠 ≤{{ rules.maxAdjStack ?? '—' }}</span>
            <span class="a-chip">
              对话标签 ≤{{ rules.maxDialogueTagRatio !== undefined ? Math.round(rules.maxDialogueTagRatio * 100) + '%' : '—' }}
            </span>
            <span class="a-chip">排比连续 ≤{{ rules.maxParallelStreak ?? '—' }}</span>
            <span class="a-chip">结尾总结体 {{ rules.avoidSummaryEnding ? '避免' : '不检' }}</span>
          </div>
          <div class="anchor-line">
            <Snowflake :size="13" class="al-icon" />
            <template v-if="baseline">
              <span>文风基准建立于 {{ fmtDate(baseline.frozenAt) }} · 覆盖{{ baseline.scenes.length }}个场景</span>
              <button class="btn-ghost" :disabled="freezing" @click="onFreeze">重新建立</button>
            </template>
            <template v-else>
              <span class="al-faint">尚未建立文风基准——偏差检测暂无对照，收录样章后即可建立</span>
              <button class="btn-ghost" :disabled="freezing || style.kindCounts['样章'] === 0" @click="onFreeze">
                建立基准
              </button>
            </template>
          </div>
          <div class="anchor-line">
            <span class="al-label">参考强度</span>
            <div class="seg">
              <button class="seg-btn" :class="{ on: injection === 'light' }" @click="onInjection('light')">轻</button>
              <button class="seg-btn" :class="{ on: injection === 'heavy' }" @click="onInjection('heavy')">重</button>
            </div>
            <span class="al-faint">{{ injection === 'light' ? '每章带入1段样章参考' : '每章带入3段样章参考' }}</span>
            <button class="btn-ghost rules-toggle" @click="toggleRulesEdit">
              {{ editingRules ? '收起铁律原文' : '编辑铁律原文' }}
            </button>
          </div>
          <div v-if="editingRules" class="rules-edit">
            <textarea
              v-model="rulesText"
              class="rules-textarea"
              rows="12"
              spellcheck="false"
              :placeholder="rulesMissing ? '尚无铁律——留空新建。检测标准、删除分级等规则配置。' : ''"
            ></textarea>
            <div class="af-actions">
              <span v-if="rulesDirty" class="al-faint">未保存</span>
              <button class="btn-primary" :disabled="rulesSaving || !rulesDirty" @click="saveRules">
                {{ rulesSaving ? '保存中…' : '保存' }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- ── ② 条目库 ── -->
      <section class="panel">
        <div class="panel-head">
          <LibraryBig :size="14" /> <span>条目库</span>
          <span class="head-note">{{ style.entries.length }}条 · 供AI参考的文风知识</span>
          <span v-if="style.entryErrors > 0" class="head-warn">{{ style.entryErrors }}个文件损坏</span>
          <div class="head-actions">
            <button
              class="btn-ghost"
              data-tip="批量收割：扫定稿正文挑样章/金句"
              data-tip-dir="bottom"
              @click="ws.setActiveView('learn')"
            >
              <GraduationCap :size="13" /> 批量收割
            </button>
            <button class="btn-primary" @click="adding = !adding">
              <Plus :size="13" /> 新增
            </button>
          </div>
        </div>

        <div v-if="adding" class="add-form">
          <div class="af-row">
            <select v-model="draft.类型" class="af-select">
              <option v-for="k in ENTRY_KINDS" :key="k" :value="k">{{ k }}</option>
            </select>
            <input v-model="draft.场景" class="af-input" placeholder="场景（留空=通用）" />
            <input v-model="draft.说明" class="af-input af-grow" placeholder="说明（可选，样章的技法指令/禁词的替换方向）" />
          </div>
          <textarea
            v-model="draft.正文"
            class="af-textarea"
            rows="3"
            :placeholder="draft.类型 === '禁词' ? '要禁用的词或短语' : '条目正文'"
          ></textarea>
          <div class="af-actions">
            <button class="btn-ghost" @click="adding = false"><X :size="13" /> 取消</button>
            <button class="btn-primary" @click="submitAdd"><Check :size="13" /> 存入条目库</button>
          </div>
        </div>

        <div v-if="style.entries.length > 0" class="filters">
          <div class="f-group">
            <button class="f-chip" :class="{ on: kindFilter === 'all' }" @click="kindFilter = 'all'">全部</button>
            <button
              v-for="k in ENTRY_KINDS"
              :key="k"
              class="f-chip"
              :class="{ on: kindFilter === k }"
              @click="kindFilter = kindFilter === k ? 'all' : k"
            >
              {{ k }} {{ style.kindCounts[k] }}
            </button>
          </div>
          <div v-if="scenes.length > 1" class="f-group">
            <button class="f-chip" :class="{ on: sceneFilter === 'all' }" @click="sceneFilter = 'all'">全部场景</button>
            <button
              v-for="s in scenes"
              :key="s"
              class="f-chip"
              :class="{ on: sceneFilter === s }"
              @click="sceneFilter = sceneFilter === s ? 'all' : s"
            >
              {{ s }}
            </button>
          </div>
          <div v-if="sources.length > 1" class="f-group">
            <button class="f-chip" :class="{ on: sourceFilter === 'all' }" @click="sourceFilter = 'all'">全部来源</button>
            <button
              v-for="s in sources"
              :key="s"
              class="f-chip"
              :class="{ on: sourceFilter === s }"
              @click="sourceFilter = sourceFilter === s ? 'all' : s"
            >
              {{ s }}
            </button>
          </div>
        </div>

        <div v-if="filteredEntries.length > 0" class="entry-grid">
          <div v-for="e in filteredEntries" :key="e._path" class="entry-card">
            <div class="ec-top">
              <span class="kind-badge" :data-kind="e.类型">{{ e.类型 }}</span>
              <span class="ec-scene">{{ e.场景 }}</span>
              <button class="ec-del" data-tip="删除" data-tip-dir="bottom" @click="onRemove(e._path, e.正文)">
                <Trash2 :size="13" />
              </button>
            </div>
            <div v-if="e.说明" class="ec-note">{{ e.说明 }}</div>
            <div class="ec-text">{{ e.正文 }}</div>
            <div class="ec-foot">
              <span class="src-dot">{{ e.来源 }}</span>
              <span v-if="e.出处" class="ec-origin">{{ e.出处 }}</span>
              <span v-if="e.标签?.length" class="ec-tags">{{ e.标签.join(' · ') }}</span>
            </div>
          </div>
        </div>
        <EmptyState
          v-else
          :icon="LibraryBig"
          :title="style.entries.length === 0 ? '条目库为空' : '无匹配条目'"
          :text="style.entries.length === 0 ? '确认候选、批量收割或手动新增，都会存入这里' : '换个筛选条件试试'"
        />
      </section>

      <!-- ── ③ 候选箱 ── -->
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

      <!-- ── ④ 验收 ── -->
      <section class="panel">
        <div class="panel-head">
          <ClipboardCheck :size="14" /> <span>验收</span>
          <span class="head-note">写出去的东西还像不像你</span>
        </div>
        <div class="accept-grid">
          <!-- 机检重扫（零 AI） -->
          <div class="accept-block">
            <div class="ab-head">
              <span class="ab-title">规则检测</span>
              <span class="token-chip free">免费</span>
              <button class="btn-ghost" :disabled="rescanning" @click="onRescan">
                <RefreshCw :size="12" :class="{ spin: rescanning }" />
                {{ style.trend ? '重扫' : '扫描' }}
              </button>
            </div>
            <template v-if="style.trend && style.trend.count > 0">
              <div class="ab-meta">
                基于{{ style.trend.count }}{{ unit }}定稿 ·
                {{ style.trend.baseline ? `对照 ${fmtDate(style.trend.baseline.frozenAt)} 基准` : '无基准（仅检测当前值）' }}
              </div>
              <div class="spark-rows">
                <div class="spark-row">
                  <span class="sr-label">对话标签占比</span>
                  <svg class="spark" viewBox="0 0 100 24" preserveAspectRatio="none" role="img" aria-label="趋势图">
                    <polyline :points="sparkPoints(style.trend.dialogueTagSeries)" />
                  </svg>
                  <span class="sr-val">均值{{ Math.round(avg(style.trend.dialogueTagSeries) * 100) }}%</span>
                </div>
                <div class="spark-row">
                  <span class="sr-label">句长方差</span>
                  <svg class="spark" viewBox="0 0 100 24" preserveAspectRatio="none" role="img" aria-label="趋势图">
                    <polyline :points="sparkPoints(style.trend.varianceSeries)" />
                  </svg>
                  <span class="sr-val">均值{{ Math.round(avg(style.trend.varianceSeries)) }}</span>
                </div>
                <div class="spark-row">
                  <span class="sr-label">复读率</span>
                  <svg class="spark" viewBox="0 0 100 24" preserveAspectRatio="none" role="img" aria-label="趋势图">
                    <polyline :points="sparkPoints(style.trend.repeatSeries)" />
                  </svg>
                  <span class="sr-val">均值{{ Math.round(avg(style.trend.repeatSeries) * 100) }}%</span>
                </div>
              </div>
              <div class="ab-stats">
                <span>单句超限 {{ style.trend.overlongChapters.length }}/{{ style.trend.count }}{{ unit }}</span>
                <span>堆叠命中 {{ style.trend.adjStackChapters.length }}{{ unit }}</span>
                <span>总结体结尾 {{ style.trend.summaryEndingChapters.length }}{{ unit }}</span>
              </div>
              <div v-if="style.trend.drifts.length > 0" class="drift-list">
                <div v-for="(d, i) in style.trend.drifts" :key="i" class="drift-item"><TriangleAlert :size="11" /> {{ d.message }}</div>
              </div>
              <div v-else class="ab-ok">未发现文风偏差</div>
            </template>
            <div v-else-if="style.trend" class="ab-empty">尚无定稿正文可扫</div>
            <div v-else class="ab-empty">点「扫描」按铁律标准检查全部定稿</div>
          </div>

          <!-- AI 语义分析（耗 token） -->
          <div class="accept-block">
            <div class="ab-head">
              <span class="ab-title">AI深度分析</span>
              <span class="token-chip cost">消耗额度</span>
              <button class="btn-ghost" :disabled="aiOff || analyzing" @click="onAnalyze">
                <RefreshCw :size="12" :class="{ spin: analyzing }" />
                {{ analyzing ? '分析中…' : '分析' }}
              </button>
            </div>
            <template v-if="aiResult">
              <div class="ai-drift">{{ aiResult.drift }}</div>
              <div v-if="aiResult.口癖?.length" class="ai-tags">
                <span v-for="(t, i) in aiResult.口癖" :key="i" class="ai-tag">{{ t }}</span>
              </div>
              <div v-if="aiResult.重复度评价" class="ai-line">{{ aiResult.重复度评价 }}</div>
              <div v-if="aiResult.建议?.length" class="ai-suggestions">
                <div v-for="(s, i) in aiResult.建议" :key="i" class="ai-suggestion">{{ s }}</div>
              </div>
            </template>
            <div v-else class="ab-empty">
              {{ aiOff ? 'AI暂不可用' : '读最近定稿做全书文风总结；口癖和建议会自动进候选箱' }}
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.sv-scroll {
  height: 100%;
  overflow: auto;
  padding: var(--size-4-5) var(--size-4-6);
}
.sv {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-4);
  max-width: 940px;
  margin: 0 auto;
}

/* ══ 面板基础（对齐 OverviewView 卡片语言）══ */
.panel {
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  padding: 18px 20px;
  animation: fade-up var(--dur-fast) var(--ease-out) both;
}
.panel-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 14px;
}
.panel-head svg {
  opacity: 0.5;
  flex-shrink: 0;
}
.head-note {
  font-weight: 400;
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.head-count {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-accent);
}
.head-warn {
  font-size: var(--font-size-xs);
  font-weight: 400;
  color: var(--text-warning);
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
  animation: sv-spin 1s linear infinite;
}
@keyframes sv-spin {
  to {
    transform: rotate(360deg);
  }
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
.token-chip.cost {
  color: var(--dv-warn);
  background: color-mix(in srgb, var(--dv-warn) 12%, transparent);
}

/* ══ ① 定标 ══ */
.anchor-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.anchor-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.a-chip {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  padding: 3px 10px;
}
.anchor-line {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: var(--font-size-s);
  color: var(--text-normal);
}
.al-icon {
  color: var(--text-faint);
  flex-shrink: 0;
}
.al-label {
  font-size: var(--font-size-s);
  color: var(--text-muted);
}
.al-faint {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.seg {
  display: inline-flex;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  overflow: hidden;
}
.seg-btn {
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  padding: 3px 14px;
  cursor: pointer;
}
.seg-btn.on {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
}
.rules-toggle {
  margin-left: auto;
}
.rules-edit {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rules-textarea {
  width: 100%;
  resize: vertical;
  padding: 10px 12px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--font-size-xs);
  line-height: 1.6;
  color: var(--text-normal);
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  outline: none;
}
.rules-textarea:focus {
  border-color: var(--interactive-accent);
}

/* ══ ② 条目库 ══ */
.add-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  margin-bottom: 14px;
  border: 1px dashed var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: var(--background-secondary);
}
.af-row {
  display: flex;
  gap: 8px;
}
.af-select,
.af-input,
.af-textarea {
  font-size: var(--font-size-s);
  padding: 5px 9px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  outline: none;
}
.af-select:focus,
.af-input:focus,
.af-textarea:focus {
  border-color: var(--interactive-accent);
}
.af-grow {
  flex: 1;
}
.af-textarea {
  resize: vertical;
  font-family: inherit;
  line-height: 1.7;
}
.af-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.filters {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}
.f-group {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.f-chip {
  font-size: var(--font-size-xs);
  padding: 2px 10px;
  border-radius: 99px;
  border: 1px solid var(--background-modifier-border);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.f-chip:hover {
  color: var(--text-normal);
  background: var(--background-modifier-hover);
}
.f-chip.on {
  color: var(--text-accent);
  border-color: var(--text-accent);
  background: color-mix(in srgb, var(--text-accent) 8%, transparent);
}

.entry-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
}
.entry-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: var(--background-secondary);
}
.ec-top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ec-scene {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.ec-del {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  padding: 2px;
  border-radius: var(--radius-s);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.entry-card:hover .ec-del {
  opacity: 1;
}
.ec-del:hover {
  color: var(--text-error);
  background: var(--background-modifier-hover);
}
.ec-note {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.ec-text {
  font-size: var(--font-size-s);
  color: var(--text-normal);
  line-height: 1.7;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.ec-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: auto;
}
.ec-origin,
.ec-tags {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
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

/* ══ ④ 验收 ══ */
.accept-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
@media (max-width: 860px) {
  .accept-grid {
    grid-template-columns: 1fr;
  }
  .cc-compare {
    grid-template-columns: 1fr;
  }
}
.accept-block {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: var(--background-secondary);
}
.ab-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ab-title {
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-normal);
}
.ab-head .btn-ghost {
  margin-left: auto;
}
.ab-meta {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.ab-empty {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  line-height: 1.6;
  padding: 6px 0;
}
.ab-ok {
  font-size: var(--font-size-xs);
  color: var(--dv-good);
}
.spark-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.spark-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sr-label {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  width: 84px;
  flex-shrink: 0;
}
.spark {
  flex: 1;
  height: 24px;
  min-width: 0;
}
.spark polyline {
  fill: none;
  stroke: var(--text-accent);
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
}
.sr-val {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  width: 64px;
  text-align: right;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.ab-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.drift-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.drift-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
  color: var(--text-warning);
  line-height: 1.6;
}
.ai-drift {
  font-size: var(--font-size-s);
  color: var(--text-normal);
  line-height: 1.7;
}
.ai-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ai-tag {
  font-size: var(--font-size-xs);
  color: var(--text-error);
  background: color-mix(in srgb, var(--text-error) 10%, transparent);
  border-radius: 99px;
  padding: 1px 9px;
}
.ai-line {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.ai-suggestions {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ai-suggestion {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  line-height: 1.6;
  padding-left: 12px;
  position: relative;
}
.ai-suggestion::before {
  content: '·';
  position: absolute;
  left: 2px;
  color: var(--text-accent);
}

@keyframes fade-up {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
