<script setup lang="ts">
// 编辑态中栏：文件编辑器（CodeMirror）。保留 script（读/写/回滚 全真实 API）；改写/生成走工作台（块2.3 剥离编辑器 AI 入口）。
// template 对齐 mockup renderFileMid（.editor-inner/.edit-info/.et-btn/.et-wc/.doc-status + SVG 图标）。
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import CodeEditor from '../components/CodeEditor.vue'
import RevertMask from '../components/RevertMask.vue'
import { useHint } from '../composables/useHint'
import { useEditorState } from '../composables/useEditorState'
import { useBookStore } from '../stores/book'

const route = useRoute()
const router = useRouter()
const book = useBookStore()
const { hint } = useHint()
const { dirty: sharedDirty, saving: sharedSaving, saveTick } = useEditorState()
const name = computed(() => (typeof route.params.name === 'string' ? route.params.name : ''))

// CodeEditor 组件实例 ref（wrapSel/linePrefix 给 md 工具栏）
const codeRef = ref<{
  wrapSel: (before: string, after?: string) => void
  linePrefix: (prefix: string) => void
} | null>(null)

// 操作下拉菜单（保存主按钮 + ⋮ 展开 改写/回滚）
const menuOpen = ref(false)
const menuRef = ref<HTMLElement>()
function toggleMenu(): void { menuOpen.value = !menuOpen.value }
function closeMenu(e: MouseEvent): void {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) menuOpen.value = false
}
onMounted(() => document.addEventListener('click', closeMenu))
onUnmounted(() => {
  document.removeEventListener('click', closeMenu)
  clearAutoSave()
})

// 编辑器态走 store（files/selected/loading/saving/reverting/error/savedMsg 适配 slot）
const files = computed(() => book.data.editor.files)
const selected = computed(() => book.data.editor.selected)
const loading = computed(() => book.data.editor.loading)
const saving = computed(() => book.data.editor.saving)
const reverting = computed(() => book.data.editor.reverting)
const error = computed(() => book.data.editor.error)
const savedMsg = computed(() => book.data.editor.savedMsg)
// content 双向绑 store（CodeEditor @update:model-value）
const content = computed({
  get: () => book.data.editor.content,
  set: (v: string) => {
    book.data.editor.content = v
  },
})
const original = computed(() => book.data.editor.original)
const dirty = computed(() => content.value !== original.value)
const selectedMode = computed<'text' | 'md'>(() => {
  const f = book.data.editor.files.find((x) => x.path === book.data.editor.selected)
  return f?.mode ?? 'md'
})

// kind 走 config（loadConfig 拿）
const kind = computed<'long' | 'short'>(() =>
  (book.data.config.value?.kind ?? 'long') === 'short' ? 'short' : 'long',
)

/** 目标字数（全书 target_words；章级目标 core 后补） */
const targetWords = computed(() => Number(book.data.config.value?.book?.target_words) || 0)
/** 设定/大纲文件：结构化表单待 core（sfield/ol-act），当前用 CodeMirror 编辑原始 md */
const isSettingFile = computed(() => /定稿[\/\\]设定[\/\\]/.test(selected.value))
const isOutlineFile = computed(() => /^大纲[\/\\]/.test(selected.value))
/** 定稿态（对齐 mockup doc-status：草稿/已定稿，按文件路径推断） */
const docStatus = computed<{ label: string; cls: 'draft' | 'done' | 'idle' }>(() => {
  const p = selected.value
  if (!p) return { label: '—', cls: 'idle' }
  if (/工作区/.test(p)) return { label: '草稿', cls: 'draft' }
  if (/定稿[\/\\]正文/.test(p)) return { label: '已定稿', cls: 'done' }
  return { label: '文档', cls: 'idle' }
})
/** 实时字数（去空白）——对齐 mockup et-wc */
const words = computed(() => content.value.replace(/\s/g, '').length)
/** 字数占目标比（不封顶；进度条三色与百分比共用） */
const ratio = computed(() => (targetWords.value > 0 ? Math.round((words.value / targetWords.value) * 100) : 0))
const pct = computed(() => Math.min(ratio.value, 100))
/** 进度条三色：<70% 不够→cinnabar / >130% 超标→ochre / 正常→cyan（对齐 mockup bindEditor） */
const barColor = computed(() => {
  if (ratio.value < 70) return 'var(--cinnabar)'
  if (ratio.value > 130) return 'var(--ochre)'
  return 'var(--ink-cyan)'
})
/** 当前文件标题（章号/篇号/文件名）——对齐 mockup chapter-title */
const fileTitle = computed(() => {
  const p = selected.value
  if (!p) return ''
  const chM = p.match(/ch(\d+)/i)
  if (chM) return `第 ${Number(chM[1])} 章`
  const pM = p.match(/sp(\d+)/i) ?? p.match(/篇[\\/](\d+)/)
  if (pM) return `第 ${Number(pM[1])} 篇`
  return (p.split(/[\\/]/).pop() ?? p).replace(/\.md$/i, '')
})
/** 标题下辅助行（对齐 mockup chapter-meta-line）：按文件类型给描述；钩子/情绪/反转待 core */
const metaLine = computed(() => {
  const p = selected.value
  if (!p) return ''
  if (/sp\d/i.test(p) || /篇[\\/]\d/.test(p)) return '核心反转 —'
  if (/定稿[\/\\]正文[\/\\]/.test(p)) return '钩子 — · 情绪 —'
  if (/定稿[\/\\]设定[\/\\]/.test(p)) return '设定文档 · 设定模式 · 可编辑'
  if (/^大纲[\/\\]/.test(p)) return '大纲文档 · 大纲模式 · 可编辑'
  return '文档 · 可编辑'
})
async function save(): Promise<void> {
  if (!selected.value || !dirty.value) return
  await book.save(name.value)
}

// 同步编辑态到共享状态（顶栏保存按钮读取）+ 监听顶栏触发保存
watch(saving, (v) => (sharedSaving.value = v))
watch(saveTick, (t) => { if (t > 0) void save() })

// 自动保存倒计时：dirty 后 30s 自动落盘；手动保存/切文件/保存完成时清零
const AUTO_SAVE_SEC = 30
const autoSaveLeft = ref(0)
let autoSaveTimer: ReturnType<typeof setInterval> | null = null
function clearAutoSave(): void {
  autoSaveLeft.value = 0
  if (autoSaveTimer) {
    clearInterval(autoSaveTimer)
    autoSaveTimer = null
  }
}
function startAutoSave(): void {
  clearAutoSave()
  autoSaveLeft.value = AUTO_SAVE_SEC
  autoSaveTimer = setInterval(() => {
    autoSaveLeft.value--
    if (autoSaveLeft.value <= 0) {
      clearAutoSave()
      void save()
    }
  }, 1000)
}
watch(dirty, (v) => {
  sharedDirty.value = v
  if (v) startAutoSave()
  else clearAutoSave()
}, { immediate: true })

const revertShow = ref(false)
function revert(): void {
  // 打开回滚历史面板（RevertMask）；版本列表/diff 待 core git 备份 ref API
  revertShow.value = true
}
async function revertConfirm(chapter: number): Promise<void> {
  if (!Number.isFinite(chapter) || chapter < 1) {
    book.data.editor.error = '章号/篇号得是正整数'
    return
  }
  if (!window.confirm(`确认回滚到第 ${chapter} 章/篇？之后的内容将被丢弃。`)) return
  await book.revert(name.value, chapter)
}

watch(
  () => route.params.name,
  async (n) => {
    if (typeof n !== 'string') return
    // 文件导航归左栏 FileTree：无 query 时设默认 file，让 FileTree 高亮与 selected 一致
    await book.loadFiles(n)
    void book.loadConfig(n)
    if (book.data.editor.files.length > 0 && !route.query.file) {
      void router.replace({ query: { file: book.data.editor.files[0]!.path } })
    }
  },
  { immediate: true },
)
watch(selected, () => {
  void book.loadFile(name.value)
})

// 左栏 FileTree 选文件 → 跳 /edit?file=xxx → 同步 selected 打开（第二刀联动）
watch(
  () => route.query.file,
  (f) => {
    if (typeof f === 'string' && f && f !== book.data.editor.selected) {
      book.data.editor.selected = f
    }
  },
  { immediate: true },
)
</script>

<template>
  <section class="editor">
    <div class="editor-inner">
      <!-- 章节标题（楷体居中）/ 未选提示 -->
      <h1 v-if="selected" class="chapter-title">{{ fileTitle }}</h1>
      <div v-else class="ei-crumbs" style="text-align:center;padding:32px 0">（从左侧选一个文件）</div>
      <!-- chapter-meta-line：状态+面包屑(左) + 字数(居中) + 保存▾(右)；底部虚线分隔编辑区 -->
      <div v-if="selected && !loading && content" class="chapter-meta-line">
        <div class="cm-left">
          <span v-if="dirty" class="et-dirty">● 未保存</span>
          <span v-else-if="savedMsg" class="et-dirty saved">✓ {{ savedMsg }}</span>
          <span class="doc-status" :class="docStatus.cls">{{ docStatus.label }}</span>
          <span class="ei-crumbs">{{ kind === 'short' ? '短篇' : '长篇' }} › <b>{{ fileTitle }}</b></span>
          <span class="score-tag" title="本章体验分（待 core 接口）">体验 —</span>
        </div>
        <span class="et-wc">
          <b>{{ words.toLocaleString() }}</b> / {{ targetWords ? targetWords.toLocaleString() : '—' }} 字<span class="et-bar"><div :style="{ width: pct + '%', background: barColor }"></div></span><span>{{ pct }}%</span>
        </span>
        <span class="et-split" ref="menuRef">
          <span v-if="autoSaveLeft > 0" class="auto-save-tip">{{ autoSaveLeft }}s 自动保存</span>
          <button class="et-btn save" :disabled="!dirty || saving" @click="save">
            <svg class="ico" viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>
            {{ saving ? '保存中…' : '保存' }}
          </button>
          <button class="et-btn dropdown" :class="{ disabled: !dirty || saving }" :disabled="!dirty || saving" @click="toggleMenu">
            <svg class="ico" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          <div v-if="menuOpen" class="et-menu">
            <button class="et-menu-item" :disabled="reverting" @click="menuOpen = false; revert()">
              <svg class="ico" viewBox="0 0 24 24"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/></svg>
              {{ reverting ? '回滚中…' : '回滚' }}
            </button>
          </div>
        </span>
      </div>

      <p v-if="error" class="error">{{ error }}</p>
      <template v-else-if="selected && !loading && !content">
        <!-- 空文件：对齐 mockup renderFileMid（words===0 分支）的 fm-bar + state-empty -->
        <div class="fm-bar">
          <span class="fm cyan">{{ kind === 'short' ? '篇' : '章' }} · <b>{{ fileTitle }}</b></span>
          <span class="fm">字数 · <b>0</b></span>
          <span class="fm">场景 · <b style="color: var(--text-3)">—</b></span>
          <span class="fm">视角 · <b style="color: var(--text-3)">—</b></span>
          <span class="fm">钩子 · <b style="color: var(--text-3)">—</b></span>
          <span class="fm">情绪 · <b style="color: var(--text-3)">—</b></span>
        </div>
        <div class="state-empty">
          <div class="se-icon">✍️</div>
          <div class="se-text">本{{ kind === 'short' ? '篇' : '章' }}尚未开写</div>
          <div class="se-sub">在此开始写作，输入的正文将自动保存</div>
        </div>
      </template>
      <template v-else-if="selected && !loading">
        <div v-if="isSettingFile || isOutlineFile" class="sform-hint">
          {{ isSettingFile ? '设定' : '大纲' }}结构化表单待 core · 当前编辑原始 markdown
        </div>
        <!-- markdown 工具栏（设定/大纲 md 模式；正文纯文本不显示）-->
        <div v-if="selectedMode === 'md'" class="md-toolbar">
          <button class="md-btn" title="粗体 **" @click="codeRef?.wrapSel('**')"><b>B</b></button>
          <button class="md-btn" title="斜体 *" @click="codeRef?.wrapSel('*')"><i>I</i></button>
          <button class="md-btn" title="标题 ###" @click="codeRef?.linePrefix('### ')">H</button>
          <button class="md-btn" title="列表 -" @click="codeRef?.linePrefix('- ')">•</button>
          <button class="md-btn" title="引用 >" @click="codeRef?.linePrefix('> ')">❝</button>
          <button class="md-btn" title="代码 `" @click="codeRef?.wrapSel('`')">&lt;/&gt;</button>
        </div>
        <CodeEditor
          ref="codeRef"
          :key="selected"
          :model-value="content"
          :mode="selectedMode"
          @update:model-value="content = $event"
        />
      </template>
      <!-- 加载骨架屏（对齐 mockup pages-edit.js:19-24，文件切换时闪烁占位） -->
      <div v-else-if="loading" class="sk-wrap">
        <div class="sk-toolbar"><div class="sk-line"></div><div class="sk-spacer"></div><div class="sk-btn"></div></div>
        <div class="sk-title"></div>
        <div class="sk-line"></div>
        <div class="sk-line"></div>
        <div class="sk-line"></div>
      </div>
      <p v-else class="hint">从左侧选一个文件开始编辑。</p>

    </div>
    <RevertMask v-model:show="revertShow" @confirm="revertConfirm" />
  </section>
</template>

<style scoped>
/* mockup 覆盖 .editor-inner/.edit-info/.et-btn/.et-wc/.doc-status；此处仅补 mockup 无的提示与工具栏。 */
.error{color:var(--cinnabar);font-size:13px}
.sform-hint{font-size:12.5px;color:var(--ink-cyan);padding:10px 14px;background:var(--cyan-10);border-radius:8px;margin-bottom:12px;line-height:1.6}
.hint{color:var(--text-2);font-size:13px;padding:24px 0;text-align:center}

/* edit-info / chapter-title(楷体) / chapter-meta-line / et-btn 走 v5-components.css 全局；
   此处仅补 split button（保存▾合体，替代 mockup 三个独立 et-btn）与禁用态。 */
/* 标题区：文章名加大 + 整体收紧间距（edit-info 16→8 / meta-line 24·14→14·8） */
.editor-inner{padding-top:14px}
.chapter-title{font-size:28px;line-height:1.1;margin:0 0 14px}
/* meta-line 三栏：状态+面包屑(左) / 字数(居中) / 保存▾(右) */
.chapter-meta-line{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:12px;margin-bottom:18px;padding-bottom:12px}
.cm-left{display:flex;align-items:center;gap:8px;justify-self:start;min-width:0;flex-wrap:wrap}
.chapter-meta-line .et-wc{justify-self:center;white-space:nowrap;transform:translateY(1px)}
.chapter-meta-line .et-split{justify-self:end}
/* 体验分占位（待 core） + 自动保存倒计时 */
.score-tag{font-size:11.5px;color:var(--text-3);padding:2px 7px;border:1px solid var(--border);border-radius:6px;white-space:nowrap}
.auto-save-tip{font-size:11px;color:var(--text-3);align-self:center;padding:0 6px;white-space:nowrap;font-variant-numeric:tabular-nums}
/* split button：保存 + ▾ 合为一体（Cyan 底无缝贴合，替代 mockup 三个独立 .et-btn） */
.et-split{display:flex;align-items:stretch;flex-shrink:0;position:relative}
.et-split .et-btn.save{background:var(--ink-cyan);border:1px solid var(--ink-cyan);color:#fff;display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border-radius:8px 0 0 8px;margin-right:-1px;font-size:12px;font-weight:500;line-height:1;cursor:pointer;user-select:none;transition:filter .15s}
.et-split .et-btn.save .ico{width:13px;height:13px;stroke:#fff;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.et-split .et-btn.dropdown{background:var(--ink-cyan);border:1px solid var(--ink-cyan);border-radius:0 8px 8px 0;color:#fff;padding:5px 8px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;gap:0}
.et-split .et-btn.dropdown .ico{width:13px;height:13px;stroke:#fff;fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
.et-split .et-btn.dropdown:hover:not(.disabled),.et-split .et-btn.save:hover:not(:disabled){filter:brightness(1.06)}
.et-split .et-btn.dropdown.disabled,.et-split .et-btn.save:disabled{opacity:.4;cursor:default}
.et-split .et-btn:active{transform:none}
.et-menu{position:absolute;top:calc(100% + 4px);right:0;min-width:160px;background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.12);z-index:50;display:flex;flex-direction:column;gap:2px}
.et-menu-item{display:flex;align-items:center;gap:8px;padding:7px 10px;border:none;background:transparent;border-radius:6px;font-size:12.5px;color:var(--ink);cursor:pointer;text-align:left;width:100%;font-family:inherit}
.et-menu-item .ico{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
.et-menu-item:hover:not(:disabled){background:var(--hover)}
.et-menu-item:disabled{opacity:.4;cursor:default}

/* markdown 工具栏（设定/大纲 md 模式）：格式按钮 */
.md-toolbar{display:flex;gap:4px;padding:6px 4px;margin-bottom:8px;border-bottom:1px solid var(--border)}
.md-btn{min-width:30px;height:28px;padding:0 8px;border:1px solid var(--border);background:var(--paper);border-radius:6px;cursor:pointer;font-size:13px;color:var(--ink);display:inline-flex;align-items:center;justify-content:center;transition:background .15s,border-color .15s;font-family:inherit}
.md-btn:hover{background:var(--hover);border-color:var(--ink-cyan)}
.md-btn:active{transform:scale(.96)}
</style>
