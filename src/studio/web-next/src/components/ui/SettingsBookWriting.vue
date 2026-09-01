<script setup lang="ts">
// 「本书」页 · 写作默认覆盖组（IA 重组前是 SettingsBook 书籍与目标子页的本书组）：
// 题材/每卷章数/目标字数/每章字数的「本书使用独立设定」覆盖，全局默认在「写作默认」页。
// 生效链 book.yaml book 段对应键 → global.json default*（prefs store）→ 硬编码回落。
// 父组件（本书页）已用 v-if="hasBook" 保证有书打开；本组件独立拉 config（raw watch），
// 设置打开时本书页四个子组件共 4 次 getConfig——不引入父级统一状态（KISS）。
import { ref, computed, watch, inject } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import { useUiStore } from '../../stores/ui'
import { usePrefsStore } from '../../stores/prefs'
import { getConfig } from '../../api/books'
import { parseNumericInput } from '../../shared/numeric-input'
import { SAVE_CONFIG_KEY } from './settings-context'

const ui = useUiStore()
const ws = useWorkspaceStore()
// 全局默认值来自 prefs store（main.ts 在 mount 前 await init()，设置打开时必已就绪）
const prefs = usePrefsStore()
const saveConfig = inject(SAVE_CONFIG_KEY)!

/** 书类型：短篇隐藏「每卷章数」子项（该子项对短篇无意义） */
const bookKind = ref<'long' | 'short'>('long')

// ── 本书覆盖（book.yaml book 段四键；null / 空串 = 未设 = 跟随全局）──
// 题材以空串表达未设（服务端 raw 契约：genre 空串=未设），与数值键的 null 同义。
const bookGenre = ref('')
const bookVolumeSize = ref<number | null>(null)
const bookTargetWords = ref<number | null>(null)
const bookChapterTargetWords = ref<number | null>(null)

// 当前生效值（本书覆盖 ?? 全局默认）：本书开关 desc 与覆盖初始化用
const effGenre = computed(() => bookGenre.value || prefs.defaultGenre)
const effVolumeSize = computed(() => bookVolumeSize.value ?? prefs.defaultVolumeSize)
const effTargetWords = computed(() => bookTargetWords.value ?? prefs.defaultTargetWords)
const effChapterTargetWords = computed(() => bookChapterTargetWords.value ?? prefs.defaultChapterTargetWords)
// 组开关判定：组内任一键在 raw config 中已设（题材空串=未设）即算覆盖
const bookOverride = computed(
  () =>
    bookGenre.value !== '' ||
    bookVolumeSize.value !== null ||
    bookTargetWords.value !== null ||
    bookChapterTargetWords.value !== null,
)

/** 本书开关 desc：组内生效值拼成一行可读摘要（短篇不提每卷——该子项对短篇无意义且已隐藏） */
const effSummary = computed(() => {
  const parts: string[] = [`题材 ${effGenre.value || '未设'}`]
  if (bookKind.value !== 'short') parts.push(`每卷 ${effVolumeSize.value} 章`)
  parts.push(`目标 ${effTargetWords.value ? effTargetWords.value.toLocaleString() + ' 字' : '未设'}`)
  parts.push(`每章 ${effChapterTargetWords.value ? effChapterTargetWords.value.toLocaleString() + ' 字' : '未设'}`)
  return parts.join(' · ')
})

// R64-4（十二轮）：配置加载代守卫（R63-3 只修了兄弟组件 SettingsBookAnalysis）——本组件
// 在途旧响应迟到落地 B 书面板后，组开关（onOverrideToggle）以 stale 派生值 eff* 调
// saveConfig(name=B) → A 的配置值持久写进 B 的 book.yaml（跨书配置污染，同款风险面）
let loadGen = 0

watch(
  () => [ui.settingsOpen, ws.bookName] as const,
  async ([open, name]) => {
    if (!open) return
    const gen = ++loadGen
    // 无书打开：覆盖复位（父组件此时整页空态，本组不可见，复位只为切书不留旧值）
    if (!name) {
      bookKind.value = 'long'
      bookGenre.value = ''
      bookVolumeSize.value = null
      bookTargetWords.value = null
      bookChapterTargetWords.value = null
      return
    }
    try {
      const cfg = await getConfig(name)
      if (gen !== loadGen || ws.bookName !== name) return // R64-4 双复检：代 + 书名
      bookKind.value = cfg.kind ?? 'long'
      // raw 形态契约：13 键未设时为 undefined（genre 空串=未设）——只认合法值，脏值按跟随全局展示
      bookGenre.value = cfg.book?.genre ?? ''
      bookVolumeSize.value =
        typeof cfg.book?.volume_size === 'number' && cfg.book.volume_size >= 5 ? cfg.book.volume_size : null
      bookTargetWords.value =
        typeof cfg.book?.target_words === 'number' && cfg.book.target_words >= 0 ? cfg.book.target_words : null
      bookChapterTargetWords.value =
        typeof cfg.book?.chapter_target_words === 'number' && cfg.book.chapter_target_words >= 0
          ? cfg.book.chapter_target_words
          : null
    } catch {
      /* 读不到就按跟随全局展示 */
    }
  },
  { immediate: true },
)

/** 「本书使用独立设定」开关：off = 跟随全局（删 book.yaml book 段四键，genre 置 undefined）；
 *  on = 组内全部键用当前生效值（书级 ?? 全局）写入——防呆：从生效值起步，切换本身不改变行为。 */
function onOverrideToggle(e: Event): void {
  const on = (e.target as HTMLInputElement).checked
  if (on) {
    bookGenre.value = effGenre.value
    bookVolumeSize.value = effVolumeSize.value
    bookTargetWords.value = effTargetWords.value
    bookChapterTargetWords.value = effChapterTargetWords.value
    void saveConfig((c) => {
      if (!c.book) c.book = {}
      c.book.genre = effGenre.value
      c.book.volume_size = effVolumeSize.value
      c.book.target_words = effTargetWords.value
      c.book.chapter_target_words = effChapterTargetWords.value
    })
  } else {
    bookGenre.value = ''
    bookVolumeSize.value = null
    bookTargetWords.value = null
    bookChapterTargetWords.value = null
    void saveConfig((c) => {
      if (!c.book) c.book = {}
      c.book.genre = undefined
      delete c.book.volume_size
      delete c.book.target_words
      delete c.book.chapter_target_words
    })
  }
}

// ── 本书覆盖子项（override 已开；空/非法输入 = 清键回跟随全局）──

function onBookGenreChange(): void {
  bookGenre.value = bookGenre.value.trim()
  void saveConfig((c) => {
    if (!c.book) c.book = {}
    c.book.genre = bookGenre.value
  })
}
function onBookVolumeSizeInput(e: Event): void {
  const raw = Number((e.target as HTMLInputElement).value)
  bookVolumeSize.value = Number.isFinite(raw) && raw >= 5 ? Math.round(raw) : null
  void saveConfig((c) => {
    if (!c.book) c.book = {}
    c.book.volume_size = bookVolumeSize.value ?? undefined
  })
}
function onBookTargetWordsInput(e: Event): void {
  // R36-20（三十六轮）：接 R72-11 helper（全库数值输入唯一偏离点）——原 `Number('')===0`
  // 穿过 `>= 0` 闸把清空输入写成 0，注释自称「空/非法 = 清键回跟随」与行为相反。
  // 空/非法 → null → 清键回跟随全局；合法数字（含 0 = 显式未设）维持原语义。
  const raw = parseNumericInput(e)
  bookTargetWords.value = raw !== null && raw >= 0 ? Math.round(raw) : null
  void saveConfig((c) => {
    if (!c.book) c.book = {}
    c.book.target_words = bookTargetWords.value ?? undefined
  })
}
function onBookChapterTargetInput(e: Event): void {
  // R36-20：同 onBookTargetWordsInput——空输入清键而非写 0（R72-11 helper 统一口径）
  const raw = parseNumericInput(e)
  bookChapterTargetWords.value = raw !== null && raw >= 0 ? Math.round(raw) : null
  void saveConfig((c) => {
    if (!c.book) c.book = {}
    c.book.chapter_target_words = bookChapterTargetWords.value ?? undefined
  })
}
</script>

<template>
  <div class="cfg-card-head">写作默认</div>
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
          <div class="setting-item-name">题材</div>
        </div>
        <div class="setting-item-control">
          <input v-model="bookGenre" class="text-input" type="text" placeholder="题材" aria-label="题材" @change="onBookGenreChange" />
        </div>
      </div>
      <div v-if="bookKind !== 'short'" class="setting-item sub">
        <div class="setting-item-info">
          <div class="setting-item-name">每卷章数</div>
        </div>
        <div class="setting-item-control">
          <input class="num-input" type="number" min="5" max="100" step="1" placeholder="未设" aria-label="每卷章数" :value="bookVolumeSize ?? ''" @change="onBookVolumeSizeInput($event)" />
          <span class="val-suffix">章</span>
        </div>
      </div>
      <div class="setting-item sub">
        <div class="setting-item-info">
          <div class="setting-item-name">目标字数</div>
        </div>
        <div class="setting-item-control">
          <input class="num-input" type="number" min="0" step="1000" placeholder="未设" aria-label="目标字数" :value="bookTargetWords ?? ''" @change="onBookTargetWordsInput($event)" />
          <span class="val-suffix">字</span>
        </div>
      </div>
      <div class="setting-item sub">
        <div class="setting-item-info">
          <div class="setting-item-name">每章字数</div>
        </div>
        <div class="setting-item-control">
          <input class="num-input" type="number" min="0" step="100" placeholder="未设" aria-label="每章字数" :value="bookChapterTargetWords ?? ''" @change="onBookChapterTargetInput($event)" />
          <span class="val-suffix">字</span>
        </div>
      </div>
    </template>
  </section>
</template>
