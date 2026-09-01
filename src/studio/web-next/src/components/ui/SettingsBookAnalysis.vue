<script setup lang="ts">
// 「本书」页 · 智能分析覆盖组 ×3（IA 重组前是 SettingsAnalysis 的本书部分）：
// AI 机检（短篇严格模式，仅短篇书显示）/ 关系图 / 知识检索的「本书使用独立设定」覆盖，全局默认在「智能分析」页。
// 三组生效链均为 book.yaml 对应键 → global.json（prefs store）→ 硬编码回落（服务端合并同链）。
// 知识检索：书里只存「选哪个提供方 + 开不开启」；endpoint/model/key 归应用级 RAG 提供方管。
// 本组还承载建索引入口与状态轮询（原交互不变）。父组件已用 v-if="hasBook" 保证有书打开。
import { ref, computed, watch, inject, onUnmounted, onDeactivated, onActivated } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import { useUiStore } from '../../stores/ui'
import { usePrefsStore } from '../../stores/prefs'
import { parseNumericInput } from '../../shared/numeric-input'
import { getConfig, getRagStatus, triggerRagBuild, type RagStatus } from '../../api/books'
import { useProviderStore } from '../../stores/provider'
import { friendlyError } from '../../shared/error'
import { SAVE_CONFIG_KEY } from './settings-context'
import BetaBadge from './BetaBadge.vue'

const ui = useUiStore()
const ws = useWorkspaceStore()
// 全局默认值来自 prefs store（main.ts 在 mount 前 await init()，设置打开时必已就绪）
const prefs = usePrefsStore()
// 阶段 14 §6.3：RAG 提供方读统一 provider store（与服务提供方页共享一份）
const pstore = useProviderStore()
const saveConfig = inject(SAVE_CONFIG_KEY)!

/** 短篇严格模式：把短篇专属黄项提升为红项（book.yaml short.strict），仅短篇书显示本书组 */
const bookKind = ref<'long' | 'short'>('long')
const bookShortStrict = ref<boolean | null>(null)
const effShortStrict = computed(() => bookShortStrict.value ?? prefs.defaultShortStrict)
const shortOverride = computed(() => bookShortStrict.value !== null)

// 关系图 AI 梳理：手动按钮为主（控成本，方案③决策）；自动梳理默认关，作者可自行开启
const bookAutoMine = ref<boolean | null>(null)
const bookMineThreshold = ref<number | null>(null)
const effAutoMine = computed(() => bookAutoMine.value ?? prefs.relationAutoMine)
const effMineThreshold = computed(() => bookMineThreshold.value ?? prefs.relationMineThreshold)
const relationOverride = computed(() => bookAutoMine.value !== null || bookMineThreshold.value !== null)

// 知识检索（组键 = rag.enabled + rag.provider；endpoint/model 是旧版内联遗留，不参与组开关判定）
const bookRagEnabled = ref<boolean | null>(null)
const bookRagProvider = ref<string | null>(null)
const effRagEnabled = computed(() => bookRagEnabled.value ?? prefs.ragEnabled)
const effRagProvider = computed(() => bookRagProvider.value ?? (prefs.ragProvider || null))
const ragOverride = computed(() => bookRagEnabled.value !== null || bookRagProvider.value !== null)

/** 旧版内联配置（endpoint/model 直存 book.yaml）——本书子项展示「沿用」伪选项，选中提供方即迁移清除 */
const ragLegacy = ref(false)
const ragProviders = computed(() => pstore.ragProviders)
// RAG 建索引状态
const ragStatus = ref<RagStatus | null>(null)
const ragBuilding = ref(false)
const ragStatusText = ref('')
let ragPollTimer: ReturnType<typeof setInterval> | undefined
let ragPolling = false
// R28-26（二十八轮）：轮询在途旗标——interval 回调是 async，单拍 refreshRagStatus 慢于
// 1.5s 时下一拍照发、多拍并发：同一失败被并发响应重复计数（ragFailStreak 连加），
// 提前误进 RAG_POLL_MAX_FAILS 失败终态。上一拍未 settle 则本拍跳过（不并发）；
// stopRagPolling 一并复位（停表时可能在途，否则下次轮询永久跳拍）。
let ragPollInFlight = false
// R26-14（二十六轮）：轮询连续失败计数与上限——原轮询对失败无感知（refreshRagStatus
// catch 静默），服务端持续 5xx/网络断时 ragBuilding 恒 true：按钮永久置灰、状态卡死
// 「构建中…」再无出路。连续 RAG_POLL_MAX_FAILS 次（1.5s 间隔 ≈ 7.5s）即停表给失败终态
const RAG_POLL_MAX_FAILS = 5
let ragFailStreak = 0

// R28-22（二十八轮）：「重建已清空旧索引、未完成」提示。数据可行性：RagStatus.lastResult
// 只有 ok/error/chunk/chapter，无「索引已清空」显式字段（服务端 api/rag.ts 本轮不动，
// 先清库再后台建的阶段信息前端拿不到）——最小实现走文案条件渲染：以「本组件触发过
// 重建且尚未见到成功结果」为条件（ragRebuildTriggered），失败文案旁补一句人话。
// 局限如实记：他窗口触发/刷新页面后该本地记忆丢失，退回普通失败文案（保守面，不误报）。
const ragRebuildTriggered = ref(false)
// 提示按书隔离：切书复位，防 A 书重建记忆串到 B 书（ws.bookName 为 string|null，一并收留无书态）
let ragHintBook: string | null = ''
const ragRebuildFailedHint = computed(
  () => ragRebuildTriggered.value && !ragBuilding.value && ragStatus.value?.lastResult?.ok === false,
)

// R63-3（十一轮）：配置加载代守卫（style store M-2 / AnalysisPanel M-11 的 reqGen 惯例）——
// 此前 watch 无代守卫、await getConfig 后无书名复检：A 书在途响应迟到落地 B 书面板，
// 组开关（onShortOverrideToggle 等）以 stale 派生值 eff* 调 saveConfig(name=B) →
// A 的配置值持久写进 B 的 book.yaml（跨书配置污染）。
let loadGen = 0

watch(
  () => [ui.settingsOpen, ws.bookName] as const,
  async ([open, name]) => {
    if (!open) return
    const gen = ++loadGen
    // R28-22：重建触发记忆按书隔离——换书（含切到无书）才复位，防 A 书「重建中失败」
    // 提示串到 B 书；同书重开弹窗不触发复位，失败提示不因关/开弹窗丢失
    if (name !== ragHintBook) {
      ragHintBook = name
      ragRebuildTriggered.value = false
    }
    // 无书打开：覆盖复位（父组件此时整页空态，本组不可见，复位只为切书不留旧值）
    if (!name) {
      bookKind.value = 'long'
      bookShortStrict.value = null
      bookAutoMine.value = null
      bookMineThreshold.value = null
      bookRagEnabled.value = null
      bookRagProvider.value = null
      ragLegacy.value = false
      return
    }
    try {
      const cfg = await getConfig(name)
      // 双复检：代（期间又切书/重开触发新加载）+ 书名（配置页开着他书未触发 watch 的极端窗口）
      if (gen !== loadGen || ws.bookName !== name) return
      // raw 形态契约：13 键未设时为 undefined——只认合法类型，脏值按跟随全局展示
      bookKind.value = cfg.kind ?? 'long'
      bookShortStrict.value = typeof cfg.short?.strict === 'boolean' ? cfg.short.strict : null
      bookAutoMine.value = typeof cfg.auto?.relation_auto_mine === 'boolean' ? cfg.auto.relation_auto_mine : null
      bookMineThreshold.value =
        typeof cfg.auto?.relation_mine_threshold === 'number' && cfg.auto.relation_mine_threshold >= 1
          ? cfg.auto.relation_mine_threshold
          : null
      bookRagEnabled.value = typeof cfg.rag?.enabled === 'boolean' ? cfg.rag.enabled : null
      bookRagProvider.value = cfg.rag?.provider || null
      ragLegacy.value = !!(cfg.rag?.endpoint && !cfg.rag?.provider)
      // 拉一次建索引状态 + 提供方列表（都不阻塞配置读取）
      void refreshRagStatus(name)
      void loadRagProviders()
    } catch {
      /* 读不到就按跟随全局展示 */
    }
  },
  { immediate: true },
)

function loadRagProviders(): void {
  void pstore.refreshRag()
}

/** 提供方 id → 显示名（下拉数据源里找；已删的提供方回退显示原 id） */
function providerLabel(id: string | null): string {
  if (!id) return '未选择'
  const p = ragProviders.value.find((x) => x.id === id)
  return p ? p.name : id
}

// ── 组开关：off = 组内全部键 delete；on = 组内全部键用当前生效值（书级 ?? 全局）写入 ──
// auto 段展开保留段内他键（confirm_outline/batch_size 归「本书」页的 AI 写作组管，互不覆盖）。

function onShortOverrideToggle(e: Event): void {
  const on = (e.target as HTMLInputElement).checked
  if (on) {
    bookShortStrict.value = effShortStrict.value
    void saveConfig((c) => {
      c.short = { ...(c.short ?? {}), strict: effShortStrict.value }
    })
  } else {
    bookShortStrict.value = null
    void saveConfig((c) => {
      if (c.short) delete c.short.strict
    })
  }
}

function onRelationOverrideToggle(e: Event): void {
  const on = (e.target as HTMLInputElement).checked
  if (on) {
    bookAutoMine.value = effAutoMine.value
    bookMineThreshold.value = effMineThreshold.value
    void saveConfig((c) => {
      c.auto = { ...(c.auto ?? {}), relation_auto_mine: effAutoMine.value, relation_mine_threshold: effMineThreshold.value }
    })
  } else {
    bookAutoMine.value = null
    bookMineThreshold.value = null
    void saveConfig((c) => {
      if (c.auto) {
        delete c.auto.relation_auto_mine
        delete c.auto.relation_mine_threshold
      }
    })
  }
}

function onRagOverrideToggle(e: Event): void {
  const on = (e.target as HTMLInputElement).checked
  if (on) {
    bookRagEnabled.value = effRagEnabled.value
    bookRagProvider.value = effRagProvider.value
    void saveConfig((c) => {
      // provider 生效值为空（全局未选）→ 置 undefined = 不落键，与「未设」等义
      c.rag = { ...(c.rag ?? {}), enabled: effRagEnabled.value, provider: effRagProvider.value ?? undefined }
    })
  } else {
    bookRagEnabled.value = null
    bookRagProvider.value = null
    void saveConfig((c) => {
      if (c.rag) {
        delete c.rag.enabled
        delete c.rag.provider
      }
    })
  }
}

// ── 本书覆盖子项（override 已开）──

function onShortStrictToggle(e: Event): void {
  const v = (e.target as HTMLInputElement).checked
  bookShortStrict.value = v
  void saveConfig((c) => {
    c.short = { ...(c.short ?? {}), strict: v }
  })
}
function onBookAutoMineToggle(e: Event): void {
  const v = (e.target as HTMLInputElement).checked
  bookAutoMine.value = v
  void saveConfig((c) => {
    c.auto = { ...(c.auto ?? {}), relation_auto_mine: v }
  })
}
function onMineThresholdInput(e: Event): void {
  // R72-11（二十轮 E-2）：空串/非数字走共享 helper 挡掉（原 Number('')=0 过闸被钳成 1）
  const raw = parseNumericInput(e)
  if (raw === null) return
  const v = Math.min(20, Math.max(1, Math.round(raw)))
  bookMineThreshold.value = v
  void saveConfig((c) => {
    c.auto = { ...(c.auto ?? {}), relation_mine_threshold: v }
  })
}
function onBookRagToggle(e: Event): void {
  const v = (e.target as HTMLInputElement).checked
  bookRagEnabled.value = v
  void saveConfig((c) => {
    c.rag = { ...(c.rag ?? {}), enabled: v }
  })
}

/** 选本书检索提供方：写 rag.provider 并清旧内联 endpoint/model（一次性迁移；
 *  选「未选择」= 清干净 → 本书不再指定提供方） */
function onBookRagProviderChange(e: Event): void {
  const v = (e.target as HTMLSelectElement).value
  if (v === '__legacy__') return // 「旧版内联配置（沿用）」= 保持现状
  bookRagProvider.value = v || null
  ragLegacy.value = false
  void saveConfig((c) => {
    if (!c.rag) c.rag = { enabled: true }
    c.rag.provider = v || undefined
    delete c.rag.endpoint
    delete c.rag.model
  })
}

/** 刷新建索引状态（读 .cache/rag.db 现状 + 最近结果）。
 *  R26-14：返回成败——true = 拿到状态且已落地（连续失败计数随之归零）；
 *  false = 请求失败或在途切书（书名复检不过），轮询侧据此计失败。 */
async function refreshRagStatus(name?: string): Promise<boolean> {
  const book = name ?? ws.bookName
  if (!book) return false
  try {
    const s = await getRagStatus(book)
    // R63-3：await 后书名复检——在途响应迟到时 ws.bookName 已切换，不得把旧书状态
    // 落到新书面板（轮询入口 pollRagStatus 有同款检查，此处覆盖直调入口）
    if (ws.bookName !== book) return false
    ragFailStreak = 0 // R26-14：成功归零（下一轮失败从头计）
    ragStatus.value = s
    ragBuilding.value = s.running
    // R28-22：见到「不在构建 + 最近结果成功」即认定重建已完成，撤销触发记忆
    if (!s.running && s.lastResult?.ok) ragRebuildTriggered.value = false
    if (s.running) {
      ragStatusText.value = '索引构建中…'
    } else if (s.lastResult && s.lastResult.ok) {
      // 增量结果：本次有新增报本次数，纯增量（0 新块）报库内总数
      ragStatusText.value =
        s.lastResult.chapterCount > 0
          ? `已索引 ${s.lastResult.chapterCount} 章 / ${s.lastResult.chunkCount} 块`
          : `索引已是最新：共 ${s.indexedChapters} 章 / ${s.chunkCount} 块`
    } else if (s.lastResult) {
      ragStatusText.value = `索引失败：${s.lastResult.error ?? '未知错误'}`
    } else if (s.indexedChapters > 0) {
      ragStatusText.value = `已索引 ${s.indexedChapters} 章 / ${s.chunkCount} 块`
    } else {
      ragStatusText.value = '尚未建立索引'
    }
    return true
  } catch {
    return false /* 状态拉不到不打扰（如书未配置）；轮询侧计连续失败 */
  }
}

/** 触发建索引：后台任务，轮询 status 直到完成（组件卸载时清理定时器） */
async function startRagBuild(): Promise<void> {
  const name = ws.bookName
  if (!name || ragBuilding.value) return
  // R33-81（三十三轮）：在途锁前置——原在 await 之后才置位，POST 往返窗内双击双发
  ragBuilding.value = true
  try {
    await triggerRagBuild(name)
    // R28-22：本组件触发过重建（服务端先清库再后台建）——此后若以失败收场，
    // ragRebuildFailedHint 据此补「索引已清空、重建未完成」的提示
    ragRebuildTriggered.value = true
    ragStatusText.value = '索引构建中…'
    void pollRagStatus(name)
  } catch (e) {
    ragBuilding.value = false // R33-81：锁前置后失败路径须复位，否则按钮永久置灰
    ui.toast(friendlyError(e), 'error')
  }
}

async function pollRagStatus(name: string): Promise<void> {
  if (ragPolling) return
  ragPolling = true
  ragPollTimer = setInterval(async () => {
    if (!ragBuilding.value || ws.bookName !== name) {
      clearInterval(ragPollTimer)
      ragPollTimer = undefined
      ragPolling = false
      return
    }
    // R28-26（二十八轮）：重叠去重——上一拍 refreshRagStatus 未 settle（慢响应 >1.5s）
    // 则本拍直接跳过：并发多拍会把同一失败重复计数（ragFailStreak 连加），提前误进
    // RAG_POLL_MAX_FAILS 失败终态
    if (ragPollInFlight) return
    ragPollInFlight = true
    try {
      // R26-14（二十六轮）：连续失败终态——refreshRagStatus 内部成功已归零，此处只累加
      const ok = await refreshRagStatus(name)
      if (!ok && ws.bookName !== name) return // 在途切书：不计失败，下一拍书名检查自会停表
      if (!ok) ragFailStreak++
      if (ragFailStreak >= RAG_POLL_MAX_FAILS) {
        // 失败终态：停轮询 + 按钮解禁（作者可手动重试）+ 可行动提示
        clearInterval(ragPollTimer)
        ragPollTimer = undefined
        ragPolling = false
        ragBuilding.value = false
        ragStatusText.value = '索引状态获取失败，请稍后重试'
      } else if (!ragBuilding.value) {
        clearInterval(ragPollTimer)
        ragPollTimer = undefined
        ragPolling = false
      }
    } finally {
      ragPollInFlight = false
    }
  }, 1500)
}

function stopRagPolling(): void {
  if (ragPollTimer) {
    clearInterval(ragPollTimer)
    ragPollTimer = undefined
  }
  ragPolling = false
  // R28-26：停表时可能有在途 refresh（其 settle 落在停表后）——复位在途旗标，
  // 否则下次 pollRagStatus 每拍都被跳过、轮询空转
  ragPollInFlight = false
  ragFailStreak = 0 // R26-14：停表一并清失败计数（下次轮询从头计）
}

// dd-P2：SettingsModal 用 keep-alive 包 tab——关弹窗只 deactivated 不 unmount，
// 此前轮询挂 onUnmounted = 关窗后 1.5s interval 继续打旧书 status 直到构建结束；
// 改 deactivate 停表 / activate 续表（回窗时刷新状态，仍构建中才续轮询）
onDeactivated(stopRagPolling)
onActivated(() => {
  const name = ws.bookName
  if (!name) return
  void refreshRagStatus(name).then(() => {
    if (ragBuilding.value) void pollRagStatus(name)
  })
})
onUnmounted(stopRagPolling)
</script>

<template>
  <!-- 本书组仅短篇书显示（严格模式只对短篇机检有意义） -->
  <template v-if="bookKind === 'short'">
    <div class="cfg-card-head">AI 机检</div>
    <section class="cfg-card">
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">本书使用独立设定</div>
          <div class="setting-item-desc">
            当前生效 {{ effShortStrict ? '严格' : '常规' }}{{ shortOverride ? '' : '（跟随全局默认）' }}
          </div>
        </div>
        <div class="setting-item-control">
          <label class="switch">
            <input type="checkbox" aria-label="AI 机检使用独立设定" :checked="shortOverride" @change="onShortOverrideToggle($event)" />
            <span class="switch-slider"></span>
          </label>
        </div>
      </div>
      <div v-if="shortOverride" class="setting-item sub">
        <div class="setting-item-info">
          <div class="setting-item-name">短篇严格模式</div>
        </div>
        <div class="setting-item-control">
          <label class="switch">
            <input type="checkbox" aria-label="短篇严格模式" :checked="bookShortStrict ?? effShortStrict" @change="onShortStrictToggle($event)" />
            <span class="switch-slider"></span>
          </label>
        </div>
      </div>
    </section>
  </template>

  <div class="cfg-card-head">关系图 <BetaBadge /></div>
  <section class="cfg-card">
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">本书使用独立设定</div>
        <div class="setting-item-desc">
          当前生效 自动梳理{{ effAutoMine ? '开' : '关' }} · 增量 {{ effMineThreshold }} 章{{ relationOverride ? '' : '（跟随全局默认）' }}
        </div>
      </div>
      <div class="setting-item-control">
        <label class="switch">
          <input type="checkbox" aria-label="关系图使用独立设定" :checked="relationOverride" @change="onRelationOverrideToggle($event)" />
          <span class="switch-slider"></span>
        </label>
      </div>
    </div>
    <template v-if="relationOverride">
      <div class="setting-item sub">
        <div class="setting-item-info">
          <div class="setting-item-name">自动梳理</div>
        </div>
        <div class="setting-item-control">
          <label class="switch">
            <input type="checkbox" aria-label="关系图自动梳理" :checked="bookAutoMine ?? effAutoMine" @change="onBookAutoMineToggle($event)" />
            <span class="switch-slider"></span>
          </label>
        </div>
      </div>
      <div class="setting-item sub">
        <div class="setting-item-info">
          <div class="setting-item-name">章节增量阈值</div>
        </div>
        <div class="setting-item-control">
          <input class="num-input" type="number" min="1" max="20" step="1" aria-label="章节增量阈值" :value="bookMineThreshold ?? effMineThreshold" @change="onMineThresholdInput($event)" />
          <span class="val-suffix">章</span>
        </div>
      </div>
    </template>
  </section>

  <div class="cfg-card-head">知识检索 <BetaBadge /></div>
  <section class="cfg-card">
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">本书使用独立设定</div>
        <div class="setting-item-desc">
          当前生效 {{ effRagEnabled ? '已启用' : '未启用' }} · 提供方 {{ ragLegacy ? '旧版内联配置' : providerLabel(effRagProvider) }}{{ ragOverride ? '' : '（跟随全局默认）' }}
        </div>
      </div>
      <div class="setting-item-control">
        <label class="switch">
          <input type="checkbox" aria-label="知识检索使用独立设定" :checked="ragOverride" @change="onRagOverrideToggle($event)" />
          <span class="switch-slider"></span>
        </label>
      </div>
    </div>
    <template v-if="ragOverride">
      <div class="setting-item sub">
        <div class="setting-item-info">
          <div class="setting-item-name">启用检索</div>
        </div>
        <div class="setting-item-control">
          <label class="switch">
            <input type="checkbox" aria-label="启用知识检索" :checked="bookRagEnabled ?? effRagEnabled" @change="onBookRagToggle($event)" />
            <span class="switch-slider"></span>
          </label>
        </div>
      </div>
      <div v-if="bookRagEnabled" class="setting-item sub">
        <div class="setting-item-info">
          <div class="setting-item-name">检索提供方</div>
          <div class="setting-item-desc">
            {{ ragProviders.length ? '嵌入提供方在「服务提供方」页管理，此处选本书用哪个' : '尚未配置嵌入提供方——请先到「服务提供方」页添加 RAG 提供方' }}
          </div>
        </div>
        <div class="setting-item-control">
          <select
            class="rag-prov-select"
            aria-label="检索提供方"
            :value="bookRagProvider || (ragLegacy ? '__legacy__' : '')"
            @change="onBookRagProviderChange($event)"
          >
            <option value="" disabled>{{ ragProviders.length ? '请选择' : '暂无可选提供方' }}</option>
            <option v-if="ragLegacy" value="__legacy__">旧版内联配置（沿用）</option>
            <option v-for="p in ragProviders" :key="p.id" :value="p.id">{{ p.name }}（{{ p.model }}）</option>
          </select>
        </div>
      </div>
    </template>
    <!-- 建索引：书级生效启用即可建（含跟随全局默认启用）；挂在两组之后（原交互不变） -->
    <div v-if="effRagEnabled" class="rag-build-row">
      <button class="save-btn" @click="startRagBuild" :disabled="ragBuilding">{{ ragBuilding ? '构建中…' : '建立索引' }}</button>
      <span class="rag-status" :class="{ running: ragBuilding }">{{ ragStatusText }}</span>
      <!-- R28-22：重建先清库再后台建——建索引期失败时旧索引已删、新索引未成，检索归零
           但普通「索引失败」文案不说明这一点。此处如实补一句 + 给出路（重试/正文不受影响） -->
      <span v-if="ragRebuildFailedHint" class="rag-rebuild-hint" role="status">
        上次重建已清空旧索引、新索引未建成——检索暂时查不到内容。可重新点「建立索引」重试；书稿正文不受影响。
      </span>
    </div>
  </section>
</template>

<style scoped>
/* 检索提供方下拉（对齐设置页输入控件风格） */
.rag-prov-select {
  max-width: 260px;
  padding: 6px 10px;
  font-size: var(--font-size-s);
  color: var(--text-normal);
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}

.rag-prov-select:hover {
  border-color: var(--interactive-accent);
}

.rag-prov-select:focus {
  outline: none;
  border-color: var(--interactive-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive-accent) 18%, transparent);
}

.rag-build-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap; /* R28-22：重建失败提示整行折行显示 */
  gap: 10px;
  margin-top: 10px;
}

.rag-status {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}

/* R28-22：「索引已清空、重建未完成」提示（占整行，警示色但低刺激） */
.rag-rebuild-hint {
  width: 100%;
  font-size: var(--font-size-xs);
  line-height: 1.6;
  color: var(--text-warning);
}

.rag-status.running {
  color: var(--text-accent);
}
</style>
