<script setup lang="ts">
// 设置弹窗（Obsidian 风格：左侧分类导航 + 右侧列表项）。
// 分类：外观 / 编辑器 / 备份 / 书籍 / AI。
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { X, Palette, Type, History, BookOpen, Sparkles, Feather } from 'lucide-vue-next'
import { useUiStore } from '../../stores/ui'
import { usePrefsStore } from '../../stores/prefs'
import { useTheme } from '../../composables/useTheme'
import { useWorkspaceStore } from '../../stores/workspace'
import { getConfig, putConfig, type BookConfig } from '../../api/books'
import { getContent, putContent } from '../../api/documents'
import { ApiError } from '../../api/client'

const ui = useUiStore()
const prefs = usePrefsStore()
const { theme, setTheme } = useTheme()
const ws = useWorkspaceStore()

type Tab = 'appearance' | 'editor' | 'backup' | 'book' | 'ai' | 'style'
const activeTab = ref<Tab>('appearance')
const hasDesktop = computed(() => typeof window !== 'undefined' && !!window.clwritingDesktop)
const hasBook = computed(() => !!ws.bookName)
/** 当前 tab 的配置归属：外观/编辑器 → 全局（跨书共享）；备份/书籍/AI/文风 → 本书（跟随当前书） */
const tabScope = computed<'global' | 'book'>(() =>
  activeTab.value === 'appearance' || activeTab.value === 'editor' ? 'global' : 'book',
)

// ── 系统字体（桌面版 IPC）──
const systemFonts = ref<string[]>([])
onMounted(async () => {
  if (!window.clwritingDesktop) return
  try {
    systemFonts.value = await window.clwritingDesktop.getSystemFonts()
  } catch (e) {
    console.error('加载系统字体失败：', e)
  }
})
const CJK_RE = /[一-鿿㐀-䶿぀-ヿ가-힯]/
const CN_KW =
  /\b(SC|TC|HK|GB|Hans|Hant|Hei|Kai|Heiti|Songti|Kaiti|Yuanti|Libian|Xingkai|Weibei|Baoli|Wawati|Yuppy|Hannotate|HanziPen|Lantinghei|LingWai|FangSong|STHeiti|STSong|STKaiti|STFangsong|STXihei|STXingkai|STXinwei|STHupo|STCaiyun|STZhongsong|Hiragino Sans GB|Source Han Sans|Source Han Serif|Noto Sans SC|Noto Serif SC|Noto Sans CJK|Noto Serif CJK|LXGW WenKai)\b/i
const FONT_CN_LABEL: Record<string, string> = {
  'PingFang SC': '苹方', 'PingFang TC': '苹方', 'PingFang HK': '苹方',
  'Heiti SC': '黑体', 'Heiti TC': '黑体', Hei: '黑体',
  'Songti SC': '宋体', 'Songti TC': '宋体',
  'Kaiti SC': '楷体', 'Kaiti TC': '楷体', Kai: '楷体',
  'Yuanti SC': '圆体', 'Yuanti TC': '圆体',
  'Xingkai SC': '行楷', 'Xingkai TC': '行楷',
  'Weibei SC': '魏碑', 'Weibei TC': '魏碑',
  'Libian SC': '隶变', 'Libian TC': '隶变',
  'Baoli SC': '报隶', 'Baoli TC': '报隶',
  'Yuppy SC': '雅痞', 'Yuppy TC': '雅痞',
  'Wawati SC': '娃娃体', 'Wawati TC': '娃娃体',
  'Hannotate SC': '手札体', 'Hannotate TC': '手札体',
  'HanziPen SC': '汉字笔', 'HanziPen TC': '汉字笔',
  'Lantinghei SC': '兰亭黑', 'Lantinghei TC': '兰亭黑',
  'LingWai SC': '翎外', 'LingWai TC': '翎外',
  'Hiragino Sans GB': '冬青黑体',
  STHeiti: '华文黑体', STSong: '华文宋体', STKaiti: '华文楷体',
  STFangsong: '华文仿宋', STXihei: '华文细黑', STXingkai: '华文行楷',
  STXinwei: '华文新魏', STHupo: '华文琥珀', STCaiyun: '华文彩云',
  STZhongsong: '华文中宋',
  'Source Han Sans SC': '思源黑体', 'Source Han Serif SC': '思源宋体',
  'Noto Sans SC': '思源黑体', 'Noto Serif SC': '思源宋体',
  'Noto Sans CJK SC': '思源黑体', 'Noto Serif CJK SC': '思源宋体',
  'LXGW WenKai': '霞鹜文楷',
}
function isChineseFont(name: string): boolean {
  return CJK_RE.test(name) || CN_KW.test(name) || name in FONT_CN_LABEL
}
function fontDisplayName(name: string): string {
  return FONT_CN_LABEL[name] ?? name
}
const chineseFonts = computed(() => systemFonts.value.filter(isChineseFont))
const englishFonts = computed(() => systemFonts.value.filter((f) => !isChineseFont(f)))
function selValue(e: Event): string {
  return (e.target as HTMLSelectElement).value
}

async function openBookDir(): Promise<void> {
  if (!ws.bookName) return
  await window.clwritingDesktop?.openBookDir(ws.bookName)
}

// ── 书籍 / AI 配置（book.yaml）──
const targetWords = ref<number | null>(null)
const chapterTargetWords = ref<number | null>(null)
const SNAPSHOT_DEFAULTS = { maxDays: 14, maxCount: 30 }
const snapDays = ref(SNAPSHOT_DEFAULTS.maxDays)
const snapCount = ref(SNAPSHOT_DEFAULTS.maxCount)
// AI 配置
const aiHost = ref<'cc' | 'codex'>('cc')
const aiWorkflow = ref<'free' | 'assist' | 'strict'>('strict')
const aiCallsPerChapter = ref(8)
const aiStyleInjection = ref<'light' | 'heavy'>('light')
const ragEnabled = ref(false)
const ragEndpoint = ref('')
const ragModel = ref('')

watch(
  () => [ui.settingsOpen, ws.bookName] as const,
  async ([open, name]) => {
    if (!open || !name) return
    try {
      const cfg = await getConfig(name)
      targetWords.value = cfg.book?.target_words ?? null
      chapterTargetWords.value = cfg.book?.chapter_target_words ?? null
      snapDays.value = cfg.snapshots?.max_days ?? SNAPSHOT_DEFAULTS.maxDays
      snapCount.value = cfg.snapshots?.max_count ?? SNAPSHOT_DEFAULTS.maxCount
      aiHost.value = (cfg.host as 'cc' | 'codex') ?? 'cc'
      aiWorkflow.value = (cfg.workflow as 'free' | 'assist' | 'strict') ?? 'strict'
      aiCallsPerChapter.value = cfg.budget?.calls_per_chapter ?? 8
      aiStyleInjection.value = (cfg.style?.injection as 'light' | 'heavy') ?? 'light'
      ragEnabled.value = cfg.rag?.enabled ?? false
      ragEndpoint.value = cfg.rag?.endpoint ?? ''
      ragModel.value = cfg.rag?.model ?? ''
    } catch {
      /* 读不到就用默认值展示 */
    }
  },
  { immediate: true },
)

/** 通用：读 → 改 → 写 book.yaml */
async function saveConfig(mutate: (cfg: BookConfig) => void): Promise<void> {
  const name = ws.bookName
  if (!name) return
  try {
    const cfg = await getConfig(name)
    mutate(cfg)
    await putConfig(name, cfg)
    ui.toast('已保存', 'success')
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e), 'error')
  }
}

function onTargetWordsInput(e: Event): void {
  const raw = Number((e.target as HTMLInputElement).value)
  targetWords.value = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null
  void saveConfig((c) => {
    if (!c.book) c.book = {}
    c.book.target_words = targetWords.value ?? undefined
  })
}
function onChapterTargetInput(e: Event): void {
  const raw = Number((e.target as HTMLInputElement).value)
  chapterTargetWords.value = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null
  void saveConfig((c) => {
    if (!c.book) c.book = {}
    c.book.chapter_target_words = chapterTargetWords.value ?? undefined
  })
}
function onSnapInput(which: 'days' | 'count', e: Event): void {
  const raw = Number((e.target as HTMLInputElement).value)
  if (!Number.isFinite(raw)) return
  if (which === 'days') snapDays.value = Math.min(365, Math.max(1, Math.round(raw)))
  else snapCount.value = Math.min(200, Math.max(1, Math.round(raw)))
  void saveConfig((c) => {
    c.snapshots = { max_days: snapDays.value, max_count: snapCount.value }
  })
}

// AI 配置操作（即时保存）
function onAiHost(v: 'cc' | 'codex'): void {
  aiHost.value = v
  void saveConfig((c) => { c.host = v })
}
function onAiWorkflow(v: 'free' | 'assist' | 'strict'): void {
  aiWorkflow.value = v
  void saveConfig((c) => { c.workflow = v })
}
function onAiCalls(e: Event): void {
  const raw = Number((e.target as HTMLInputElement).value)
  if (!Number.isFinite(raw)) return
  aiCallsPerChapter.value = Math.min(50, Math.max(1, Math.round(raw)))
  void saveConfig((c) => {
    if (!c.budget) c.budget = {}
    c.budget.calls_per_chapter = aiCallsPerChapter.value
  })
}
function onAiStyle(v: 'light' | 'heavy'): void {
  aiStyleInjection.value = v
  void saveConfig((c) => {
    if (!c.style) c.style = {}
    c.style.injection = v
  })
}
function onRagToggle(e: Event): void {
  ragEnabled.value = (e.target as HTMLInputElement).checked
  void saveConfig((c) => {
    if (!c.rag) c.rag = {}
    c.rag.enabled = ragEnabled.value
  })
}
function onRagEndpoint(e: Event): void {
  ragEndpoint.value = (e.target as HTMLInputElement).value
  void saveConfig((c) => {
    if (!c.rag) c.rag = {}
    c.rag.endpoint = ragEndpoint.value || undefined
  })
}
function onRagModel(e: Event): void {
  ragModel.value = (e.target as HTMLInputElement).value
  void saveConfig((c) => {
    if (!c.rag) c.rag = {}
    c.rag.model = ragModel.value || undefined
  })
}

// ── 文风铁律（文风/文风铁律.md，撤出编辑树后的编辑入口；复用 /file 读写全文）──
const STYLE_RULES_PATH = '文风/文风铁律.md'
const styleRules = ref('')
const styleRulesOrig = ref('') // 上次保存的内容，用于「未保存」提示
const styleRulesLoading = ref(false)
const styleRulesSaving = ref(false)
const styleRulesMissing = ref(false) // 文件不存在（旧书未生成）
const styleRulesDirty = computed(() => styleRules.value !== styleRulesOrig.value)

async function loadStyleRules(name: string): Promise<void> {
  styleRulesLoading.value = true
  styleRulesMissing.value = false
  try {
    styleRules.value = await getContent(name, STYLE_RULES_PATH)
    styleRulesOrig.value = styleRules.value
  } catch (e) {
    // 404 = 旧书/onboard 未生成铁律；展示空稿占位，允许作者新建
    if (e instanceof ApiError && e.status === 404) {
      styleRulesMissing.value = true
      styleRules.value = ''
      styleRulesOrig.value = ''
    } else {
      ui.toast(e instanceof Error ? e.message : String(e), 'error')
    }
  } finally {
    styleRulesLoading.value = false
  }
}

async function onSaveStyleRules(): Promise<void> {
  const name = ws.bookName
  if (!name) return
  // 文件不存在时先建空文件（putContent 要求文件已存在）
  if (styleRulesMissing.value) {
    try {
      await putContent(name, STYLE_RULES_PATH, '')
      styleRulesMissing.value = false
    } catch (e) {
      ui.toast('新建铁律失败：' + (e instanceof Error ? e.message : String(e)), 'error')
      return
    }
  }
  styleRulesSaving.value = true
  try {
    await putContent(name, STYLE_RULES_PATH, styleRules.value)
    styleRulesOrig.value = styleRules.value
    ui.toast('文风铁律已保存', 'success')
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e), 'error')
  } finally {
    styleRulesSaving.value = false
  }
}

// 切到文风 tab 时拉取；切书/重开弹窗时重置（配合上面的 watch）
watch(
  () => [ui.settingsOpen, ws.bookName, activeTab.value] as const,
  ([open, name, tab], prev) => {
    if (!open || !name) return
    if (tab !== 'style') return
    // 仅在首次进入或切书后重拉（避免同会话内重复请求）
    const prevName = prev?.[1]
    if (prev && prev[0] === open && prev[1] === name && prev[2] === tab) return
    void loadStyleRules(name)
  },
)

/** range 配套数字输入：clamp 到范围后调 setter */
function numInput(min: number, max: number, setter: (v: number) => void, e: Event): void {
  const v = Number((e.target as HTMLInputElement).value)
  if (!Number.isFinite(v)) return
  setter(Math.min(max, Math.max(min, v)))
}

// ── 书级覆盖（纸张宽度/自动保存 可选"仅本书"）──
const pageWidthBookOnly = computed(() => prefs.bookPageWidth !== null)
const autosaveBookOnly = computed(() => prefs.bookAutosaveInterval !== null)
function onPageWidthInput(v: number): void {
  prefs.setPageWidth(v, pageWidthBookOnly.value)
}
function onAutosaveInput(v: number): void {
  prefs.setAutosaveInterval(v, autosaveBookOnly.value)
}
function togglePageWidthScope(): void {
  prefs.setPageWidth(prefs.effectivePageWidth, !pageWidthBookOnly.value)
}
function toggleAutosaveScope(): void {
  prefs.setAutosaveInterval(prefs.effectiveAutosaveInterval, !autosaveBookOnly.value)
}

// Esc 关闭
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && ui.settingsOpen) ui.closeSettings()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="ui.settingsOpen" class="modal-mask" @click.self="ui.closeSettings">
      <div class="settings-modal">
        <div class="modal-head">
          <span class="modal-title">设置</span>
          <button class="close-btn" data-tip="关闭（Esc）" @click="ui.closeSettings"><X :size="18" /></button>
        </div>
        <div class="settings-split">
          <!-- 左侧分类导航 -->
          <nav class="settings-nav">
            <button :class="{ active: activeTab === 'appearance' }" @click="activeTab = 'appearance'">
              <Palette :size="16" /><span>外观</span>
            </button>
            <button :class="{ active: activeTab === 'editor' }" @click="activeTab = 'editor'">
              <Type :size="16" /><span>编辑器</span>
            </button>
            <button :class="{ active: activeTab === 'backup' }" @click="activeTab = 'backup'">
              <History :size="16" /><span>备份</span>
            </button>
            <button :class="{ active: activeTab === 'book' }" @click="activeTab = 'book'">
              <BookOpen :size="16" /><span>书籍</span>
            </button>
            <button :class="{ active: activeTab === 'ai' }" @click="activeTab = 'ai'">
              <Sparkles :size="16" /><span>AI</span>
            </button>
            <button :class="{ active: activeTab === 'style' }" @click="activeTab = 'style'">
              <Feather :size="16" /><span>文风</span>
            </button>
          </nav>

          <!-- 右侧设置内容 -->
          <div class="settings-content" :data-tab-scope="tabScope">
            <!-- ═══ 外观 ═══ -->
            <template v-if="activeTab === 'appearance'">
              <div class="setting-item">
                <div class="setting-item-info">
                  <div class="setting-item-name">主题</div>
                  <div class="setting-item-desc">亮色或暗色外观</div>
                </div>
                <div class="setting-item-control">
                  <div class="seg">
                    <button :class="{ on: theme === 'light' }" @click="setTheme('light', $event)">亮色</button>
                    <button :class="{ on: theme === 'dark' }" @click="setTheme('dark', $event)">暗色</button>
                  </div>
                </div>
              </div>
              <div v-if="hasDesktop" class="setting-item">
                <div class="setting-item-info">
                  <div class="setting-item-name">界面字体</div>
                  <div class="setting-item-desc">侧栏与菜单等 UI 文字</div>
                </div>
                <div class="setting-item-control">
                  <div class="font-pair">
                    <select class="font-select" :value="prefs.uiFontCn" @change="prefs.setUiFontCn(selValue($event))">
                      <option value="">中文 · 默认</option>
                      <option v-for="f in chineseFonts" :key="'cn-' + f" :value="f" :style="{ fontFamily: f }">{{ fontDisplayName(f) }}</option>
                    </select>
                    <select class="font-select" :value="prefs.uiFontEn" @change="prefs.setUiFontEn(selValue($event))">
                      <option value="">英文 · 默认</option>
                      <option v-for="f in englishFonts" :key="'en-' + f" :value="f" :style="{ fontFamily: f }">{{ fontDisplayName(f) }}</option>
                    </select>
                  </div>
                </div>
              </div>
            </template>

            <!-- ═══ 编辑器 ═══ -->
            <template v-else-if="activeTab === 'editor'">
              <div v-if="hasDesktop" class="group-title">字体</div>
              <div v-if="hasDesktop" class="setting-item">
                <div class="setting-item-info">
                  <div class="setting-item-name">编辑器字体</div>
                  <div class="setting-item-desc">正文编辑区文字</div>
                </div>
                <div class="setting-item-control">
                  <div class="font-pair">
                    <select class="font-select" :value="prefs.proseFontCn" @change="prefs.setProseFontCn(selValue($event))">
                      <option value="">中文 · 默认</option>
                      <option v-for="f in chineseFonts" :key="'pcn-' + f" :value="f" :style="{ fontFamily: f }">{{ fontDisplayName(f) }}</option>
                    </select>
                    <select class="font-select" :value="prefs.proseFontEn" @change="prefs.setProseFontEn(selValue($event))">
                      <option value="">英文 · 默认</option>
                      <option v-for="f in englishFonts" :key="'pen-' + f" :value="f" :style="{ fontFamily: f }">{{ fontDisplayName(f) }}</option>
                    </select>
                  </div>
                </div>
              </div>

              <div class="group-title">排版</div>
              <div class="setting-item">
                <div class="setting-item-info">
                  <div class="setting-item-name">正文字号</div>
                  <div class="setting-item-desc">编辑区字体大小</div>
                </div>
                <div class="setting-item-control">
                  <input type="range" min="13" max="24" :value="prefs.proseSize" @input="prefs.setSize(Number(($event.target as HTMLInputElement).value))" />
                  <input class="val-input" type="number" min="13" max="24" :value="prefs.proseSize" @change="numInput(13, 24, prefs.setSize, $event)" />
                  <span class="val-suffix">px</span>
                </div>
              </div>
              <div class="setting-item">
                <div class="setting-item-info">
                  <div class="setting-item-name">行距</div>
                  <div class="setting-item-desc">行间距倍数</div>
                </div>
                <div class="setting-item-control">
                  <input type="range" min="1.4" max="2.4" step="0.05" :value="prefs.proseLh" @input="prefs.setLh(Number(($event.target as HTMLInputElement).value))" />
                  <input class="val-input" type="number" min="1.4" max="2.4" step="0.05" :value="prefs.proseLh" @change="numInput(1.4, 2.4, prefs.setLh, $event)" />
                  <span class="val-suffix">×</span>
                </div>
              </div>
              <div class="setting-item">
                <div class="setting-item-info">
                  <div class="setting-item-name">段距</div>
                  <div class="setting-item-desc">段落间距</div>
                </div>
                <div class="setting-item-control">
                  <input type="range" min="0.5" max="2.5" step="0.1" :value="prefs.proseGap" @input="prefs.setGap(Number(($event.target as HTMLInputElement).value))" />
                  <input class="val-input" type="number" min="0.5" max="2.5" step="0.1" :value="prefs.proseGap" @change="numInput(0.5, 2.5, prefs.setGap, $event)" />
                  <span class="val-suffix">em</span>
                </div>
              </div>

              <div class="group-title">纸张</div>
              <div class="setting-item">
                <div class="setting-item-info">
                  <div class="setting-item-name">纸张宽度</div>
                  <div class="setting-item-desc">
                    写作区纸张的最大宽度
                    <button class="scope-btn" :class="{ on: pageWidthBookOnly }" @click="togglePageWidthScope">仅本书</button>
                  </div>
                </div>
                <div class="setting-item-control">
                  <input type="range" min="600" max="1400" step="20" :value="prefs.effectivePageWidth" @input="onPageWidthInput(Number(($event.target as HTMLInputElement).value))" />
                  <input class="val-input" type="number" min="600" max="1400" step="20" :value="prefs.effectivePageWidth" @change="numInput(600, 1400, onPageWidthInput, $event)" />
                  <span class="val-suffix">px</span>
                </div>
              </div>
              <div class="setting-item">
                <div class="setting-item-info">
                  <div class="setting-item-name">自动保存</div>
                  <div class="setting-item-desc">
                    编辑后自动保存的间隔
                    <button class="scope-btn" :class="{ on: autosaveBookOnly }" @click="toggleAutosaveScope">仅本书</button>
                  </div>
                </div>
                <div class="setting-item-control">
                  <input type="range" min="5" max="120" step="5" :value="prefs.effectiveAutosaveInterval" @input="onAutosaveInput(Number(($event.target as HTMLInputElement).value))" />
                  <input class="val-input" type="number" min="5" max="120" step="5" :value="prefs.effectiveAutosaveInterval" @change="numInput(5, 120, onAutosaveInput, $event)" />
                  <span class="val-suffix">s</span>
                </div>
              </div>
            </template>

            <!-- ═══ 备份 ═══ -->
            <template v-else-if="activeTab === 'backup'">
              <div v-if="!hasBook" class="empty-tab">
                <History :size="28" />
                <p>请先打开一本书</p>
              </div>
              <template v-else>
                <div class="book-banner">
                  <BookOpen :size="16" />
                  <span>{{ ws.bookName }}</span>
                </div>
                <div class="setting-item">
                  <div class="setting-item-info">
                    <div class="setting-item-name">版本保留</div>
                    <div class="setting-item-desc">每章历史版本的保留规则</div>
                  </div>
                  <div class="setting-item-control">
                    <span class="backup-summary">{{ snapDays }} 天 · {{ snapCount }} 个</span>
                  </div>
                </div>
                <div class="setting-item sub">
                  <div class="setting-item-info">
                    <div class="setting-item-name">保留天数</div>
                  </div>
                  <div class="setting-item-control">
                    <input class="num-input" type="number" min="1" max="365" :value="snapDays" @change="onSnapInput('days', $event)" />
                    <span class="val-suffix">天</span>
                  </div>
                </div>
                <div class="setting-item sub">
                  <div class="setting-item-info">
                    <div class="setting-item-name">保留数量</div>
                  </div>
                  <div class="setting-item-control">
                    <input class="num-input" type="number" min="1" max="200" :value="snapCount" @change="onSnapInput('count', $event)" />
                    <span class="val-suffix">个</span>
                  </div>
                </div>
              </template>
            </template>

            <!-- ═══ 书籍 ═══ -->
            <template v-else-if="activeTab === 'book'">
              <div v-if="!hasBook" class="empty-tab">
                <BookOpen :size="28" />
                <p>请先打开一本书</p>
              </div>
              <template v-else>
                <div class="book-banner">
                  <BookOpen :size="16" />
                  <span>{{ ws.bookName }}</span>
                </div>
                <div class="setting-item">
                  <div class="setting-item-info">
                    <div class="setting-item-name">目标字数</div>
                    <div class="setting-item-desc">全书完稿目标，用于进度追踪</div>
                  </div>
                  <div class="setting-item-control">
                    <input class="num-input" type="number" min="0" step="1000" placeholder="未设" :value="targetWords ?? ''" @change="onTargetWordsInput($event)" />
                    <span class="val-suffix">字</span>
                  </div>
                </div>
                <div class="setting-item">
                  <div class="setting-item-info">
                    <div class="setting-item-name">每章字数</div>
                    <div class="setting-item-desc">新建章节的默认字数目标；单章可单独覆盖</div>
                  </div>
                  <div class="setting-item-control">
                    <input class="num-input" type="number" min="0" step="100" placeholder="未设" :value="chapterTargetWords ?? ''" @change="onChapterTargetInput($event)" />
                    <span class="val-suffix">字</span>
                  </div>
                </div>
                <div v-if="hasDesktop" class="setting-item">
                  <div class="setting-item-info">
                    <div class="setting-item-name">书库目录</div>
                    <div class="setting-item-desc">在文件管理器中打开</div>
                  </div>
                  <div class="setting-item-control">
                    <button class="link-btn" @click="openBookDir">打开</button>
                  </div>
                </div>
              </template>
            </template>

            <!-- ═══ AI ═══ -->
            <template v-else-if="activeTab === 'ai'">
              <div v-if="!hasBook" class="empty-tab">
                <Sparkles :size="28" />
                <p>请先打开一本书</p>
              </div>
              <template v-else>
                <div class="group-title">宿主与工作流</div>
                <div class="setting-item">
                  <div class="setting-item-info">
                    <div class="setting-item-name">AI 宿主</div>
                    <div class="setting-item-desc">AI 调用的后端驱动</div>
                  </div>
                  <div class="setting-item-control">
                    <div class="seg">
                      <button :class="{ on: aiHost === 'cc' }" @click="onAiHost('cc')">Claude Code</button>
                      <button :class="{ on: aiHost === 'codex' }" @click="onAiHost('codex')">Codex</button>
                    </div>
                  </div>
                </div>
                <div class="setting-item">
                  <div class="setting-item-info">
                    <div class="setting-item-name">工作流模式</div>
                    <div class="setting-item-desc">门禁强度：自由不拦、辅助提醒、严格拦截</div>
                  </div>
                  <div class="setting-item-control">
                    <div class="seg">
                      <button :class="{ on: aiWorkflow === 'free' }" @click="onAiWorkflow('free')">自由</button>
                      <button :class="{ on: aiWorkflow === 'assist' }" @click="onAiWorkflow('assist')">辅助</button>
                      <button :class="{ on: aiWorkflow === 'strict' }" @click="onAiWorkflow('strict')">严格</button>
                    </div>
                  </div>
                </div>

                <div class="group-title">生成控制</div>
                <div class="setting-item">
                  <div class="setting-item-info">
                    <div class="setting-item-name">每章调用上限</div>
                    <div class="setting-item-desc">单章 AI 调用次数上限</div>
                  </div>
                  <div class="setting-item-control">
                    <input class="num-input" type="number" min="1" max="50" :value="aiCallsPerChapter" @change="onAiCalls($event)" />
                    <span class="val-suffix">次</span>
                  </div>
                </div>
                <div class="setting-item">
                  <div class="setting-item-info">
                    <div class="setting-item-name">文风注入</div>
                    <div class="setting-item-desc">AI 生成时文风参考的强度</div>
                  </div>
                  <div class="setting-item-control">
                    <div class="seg">
                      <button :class="{ on: aiStyleInjection === 'light' }" @click="onAiStyle('light')">轻度</button>
                      <button :class="{ on: aiStyleInjection === 'heavy' }" @click="onAiStyle('heavy')">重度</button>
                    </div>
                  </div>
                </div>

                <div class="group-title">知识检索（RAG）</div>
                <div class="setting-item">
                  <div class="setting-item-info">
                    <div class="setting-item-name">启用 RAG</div>
                    <div class="setting-item-desc">开启后 AI 可检索已有章节作为上下文</div>
                  </div>
                  <div class="setting-item-control">
                    <label class="switch">
                      <input type="checkbox" :checked="ragEnabled" @change="onRagToggle($event)" />
                      <span class="switch-slider"></span>
                    </label>
                  </div>
                </div>
                <template v-if="ragEnabled">
                  <div class="setting-item">
                    <div class="setting-item-info">
                      <div class="setting-item-name">Embedding 端点</div>
                      <div class="setting-item-desc">向量嵌入服务的 base URL</div>
                    </div>
                    <div class="setting-item-control">
                      <input class="text-input" type="text" placeholder="https://..." :value="ragEndpoint" @change="onRagEndpoint($event)" />
                    </div>
                  </div>
                  <div class="setting-item">
                    <div class="setting-item-info">
                      <div class="setting-item-name">Embedding 模型</div>
                      <div class="setting-item-desc">向量嵌入模型名称</div>
                    </div>
                    <div class="setting-item-control">
                      <input class="text-input" type="text" placeholder="如 text-embedding-3-small" :value="ragModel" @change="onRagModel($event)" />
                    </div>
                  </div>
                </template>
              </template>
            </template>

            <!-- ═══ 文风 ═══ -->
            <template v-else-if="activeTab === 'style'">
              <div v-if="!hasBook" class="empty-tab">
                <Feather :size="28" />
                <p>请先打开一本书</p>
              </div>
              <template v-else>
                <div class="book-banner">
                  <BookOpen :size="16" />
                  <span>{{ ws.bookName }}</span>
                </div>
                <div class="group-title">文风铁律</div>
                <div class="style-rules-card">
                  <div class="style-rules-head">
                    <div class="style-rules-meta">
                      <span v-if="styleRulesMissing" class="style-rules-empty">尚无铁律——开书时未生成，留空新建</span>
                      <span v-else-if="styleRulesDirty" class="style-rules-dirty">未保存</span>
                      <span v-else class="style-rules-saved">已保存</span>
                    </div>
                    <button
                      class="btn primary save-btn"
                      :disabled="styleRulesSaving || !styleRulesDirty"
                      @click="onSaveStyleRules"
                    >{{ styleRulesSaving ? '保存中…' : '保存' }}</button>
                  </div>
                  <textarea
                    class="style-rules-editor"
                    v-model="styleRules"
                    :disabled="styleRulesLoading"
                    :placeholder="styleRulesMissing ? '正文规范、对话标签占比上限、句长方差、重复率上限、题材专属禁忌……' : '加载中…'"
                    spellcheck="false"
                  ></textarea>
                </div>
                <div class="setting-item-desc style-rules-hint">
                  文风铁律是校对判定与 AI 写章文风对齐的依据；原存于文章树「文风」目录，现收入设置区集中维护。
                </div>
              </template>
            </template>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  z-index: 150;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: clw-overlay var(--dur-norm) var(--ease-out);
}
.settings-modal {
  width: min(1024px, calc(100vw - 32px));
  height: min(760px, calc(100vh - 48px));
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: clw-appear var(--dur-norm) var(--ease-out);
}

/* ── 顶栏 ── */
.modal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--size-4-4) var(--size-4-6);
  border-bottom: 1px solid var(--background-modifier-border);
  flex-shrink: 0;
}
.modal-title {
  font-size: var(--font-size-l);
  font-weight: 700;
  color: var(--text-normal);
  letter-spacing: -0.01em;
}
.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  color: var(--text-faint);
  border-radius: var(--radius-s);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.close-btn:hover {
  color: var(--text-normal);
  background: var(--background-modifier-hover);
}

/* ── 左右分栏 ── */
.settings-split {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* ── 左侧导航 ── */
.settings-nav {
  width: 184px;
  flex-shrink: 0;
  border-right: 1px solid var(--background-modifier-border);
  padding: var(--size-4-3);
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--background-secondary);
}
.settings-nav button {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border: none;
  border-radius: var(--radius-m);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--font-size-s);
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.settings-nav button:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.settings-nav button.active {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  font-weight: 600;
}

/* ── 右侧内容 ── */
.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: var(--size-4-5) var(--size-4-6);
}

/* ── 空状态 ── */
.empty-tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--size-4-3);
  padding: var(--size-4-8) 0;
  color: var(--text-faint);
  font-size: var(--font-size-s);
}

/* ── 分组标题 ── */
.group-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-faint);
  padding: var(--size-4-4) 0 var(--size-4-1);
}
.group-title:first-child {
  padding-top: 0;
}

/* ── 书籍 banner ── */
.book-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-accent);
  padding: var(--size-4-3) var(--size-4-4);
  margin-bottom: var(--size-4-2);
  border: 1px solid color-mix(in srgb, var(--text-accent) 20%, transparent);
  border-radius: var(--radius-m);
  background: color-mix(in srgb, var(--text-accent) 6%, transparent);
}

/* ── 设置项 ── */
.setting-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--size-4-4);
  padding: var(--size-4-3) var(--size-4-1);
  border-bottom: 1px solid var(--background-modifier-border);
}
.setting-item:last-child {
  border-bottom: none;
}
.setting-item-info {
  flex: 1;
  min-width: 0;
}
.setting-item-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-size-s);
  font-weight: 500;
  color: var(--text-normal);
}
/* 配置归属标签（::after 由 data-tab-scope 驱动，非 .sub 项才显示） */
.settings-content[data-tab-scope] .setting-item:not(.sub) .setting-item-name::after {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 99px;
  letter-spacing: 0.02em;
  white-space: nowrap;
  flex-shrink: 0;
}
.settings-content[data-tab-scope="global"] .setting-item:not(.sub) .setting-item-name::after {
  content: "全局";
  color: var(--text-faint);
  background: var(--background-modifier-hover);
}
.settings-content[data-tab-scope="book"] .setting-item:not(.sub) .setting-item-name::after {
  content: "本书";
  color: var(--text-on-accent);
  background: color-mix(in srgb, var(--interactive-accent) 22%, transparent);
}
.setting-item-desc {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  margin-top: 3px;
  line-height: 1.4;
}
/* "仅本书"覆盖开关 */
.scope-btn {
  margin-left: 8px;
  padding: 1px 8px;
  font-size: 10px;
  font-weight: 600;
  border: 1px solid var(--background-modifier-border);
  border-radius: 99px;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.scope-btn:hover {
  color: var(--text-normal);
  border-color: var(--background-modifier-border-active);
}
.scope-btn.on {
  background: color-mix(in srgb, var(--interactive-accent) 22%, transparent);
  border-color: transparent;
  color: var(--text-on-accent);
}
.setting-item-control {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  flex-shrink: 0;
}
.setting-item.sub {
  padding-left: var(--size-4-4);
}
.setting-item.sub .setting-item-name {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  font-weight: 400;
}

/* ── 数值标签 ── */
.val {
  color: var(--text-normal);
  font-variant-numeric: tabular-nums;
  font-size: var(--font-size-xs);
  min-width: 44px;
  text-align: right;
  font-weight: 500;
}
.val-suffix {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.val-input {
  width: 52px;
  padding: 4px 6px;
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
  color: var(--text-normal);
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  text-align: center;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.val-input:focus {
  outline: none;
  border-color: var(--interactive-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive-accent) 18%, transparent);
}
.val-input::-webkit-inner-spin-button,
.val-input::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.backup-summary {
  font-size: var(--font-size-s);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

/* ── range slider ── */
.setting-item input[type='range'] {
  width: 168px;
  height: 4px;
  accent-color: var(--interactive-accent);
  cursor: pointer;
}

/* ── segmented control ── */
.seg {
  display: inline-flex;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  overflow: hidden;
  background: var(--background-secondary);
}
.seg button {
  padding: 6px 18px;
  font-size: var(--font-size-s);
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.seg button:hover:not(.on) {
  color: var(--text-normal);
}
.seg button.on {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  font-weight: 600;
}

/* ── number / text input ── */
.num-input,
.text-input {
  padding: 6px 10px;
  font-size: var(--font-size-s);
  color: var(--text-normal);
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.num-input {
  width: 104px;
  font-variant-numeric: tabular-nums;
}
.text-input {
  width: 220px;
}
.num-input:focus,
.text-input:focus {
  outline: none;
  border-color: var(--interactive-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive-accent) 18%, transparent);
}

/* ── link button ── */
.link-btn {
  padding: 6px 18px;
  font-size: var(--font-size-s);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-secondary);
  color: var(--text-normal);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.link-btn:hover {
  background: var(--background-modifier-hover);
}

/* ── font pair ── */
.font-pair {
  display: flex;
  gap: var(--size-4-2);
}
.font-select {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  font-size: var(--font-size-s);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-secondary);
  color: var(--text-normal);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.font-select:focus {
  border-color: var(--interactive-accent);
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive-accent) 18%, transparent);
}

/* ── toggle switch ── */
.switch {
  position: relative;
  display: inline-block;
  width: 38px;
  height: 22px;
  cursor: pointer;
}
.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}
.switch-slider {
  position: absolute;
  inset: 0;
  background: var(--background-modifier-border-active);
  border-radius: 22px;
  transition: background var(--dur-fast) var(--ease-out);
}
.switch-slider::before {
  content: '';
  position: absolute;
  width: 16px;
  height: 16px;
  left: 3px;
  bottom: 3px;
  background: var(--text-on-accent);
  border-radius: 50%;
  transition: transform var(--dur-fast) var(--ease-out);
}
.switch input:checked + .switch-slider {
  background: var(--interactive-accent);
}
.switch input:checked + .switch-slider::before {
  transform: translateX(16px);
}

/* ── 文风铁律编辑区 ── */
.style-rules-card {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  padding: var(--size-4-3);
  background: var(--background-secondary);
}
.style-rules-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--size-4-3);
}
.style-rules-meta {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.style-rules-dirty {
  color: var(--text-warning, var(--text-accent));
}
.style-rules-saved {
  color: var(--dv-good, var(--text-muted));
}
.style-rules-empty {
  color: var(--text-faint);
  font-style: italic;
}
.save-btn {
  padding: 6px 16px;
  font-size: var(--font-size-s);
  font-weight: 600;
  border: 1px solid var(--interactive-accent);
  border-radius: var(--radius-s);
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  cursor: pointer;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.style-rules-editor {
  width: 100%;
  min-height: 320px;
  resize: vertical;
  padding: 12px 14px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--font-size-s);
  line-height: 1.6;
  color: var(--text-normal);
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  resize: vertical;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.style-rules-editor:focus {
  outline: none;
  border-color: var(--interactive-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive-accent) 18%, transparent);
}
.style-rules-hint {
  margin-top: var(--size-4-2);
}
</style>
