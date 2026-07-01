<script setup lang="ts">
// 编辑态中栏：文件编辑器（CodeMirror）。B 策略保留 script（读/写/回滚/改写/应用 全真实 API）。
// template 对齐 mockup renderFileMid（.editor-inner/.edit-info/.et-btn/.et-wc/.doc-status + SVG 图标）。
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import CodeEditor from '../components/CodeEditor.vue'
import DiffView from '../components/DiffView.vue'
import RevertMask from '../components/RevertMask.vue'
import { useHint } from '../composables/useHint'
import { useEditorState } from '../composables/useEditorState'
import type { FileEntry, RewriteResult } from '../types'
import {
  applyRewrite,
  getConfig,
  listFiles,
  readFile,
  revertBook,
  rewriteDraft,
  writeFile,
} from '../api/books'

const route = useRoute()
const router = useRouter()
const { hint } = useHint()
const { dirty: sharedDirty, saving: sharedSaving, saveTick } = useEditorState()
const name = computed(() => (typeof route.params.name === 'string' ? route.params.name : ''))
const files = ref<FileEntry[]>([])
const selected = ref('')
const content = ref('')
const original = ref('')
const loading = ref(false)
const saving = ref(false)
const reverting = ref(false)
const error = ref('')
const savedMsg = ref('')

const codeRef = ref<{
  getSelection: () => { text: string; from: number; to: number } | null
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
onUnmounted(() => document.removeEventListener('click', closeMenu))

// 改写(2.5):仅草稿 工作区/草稿-N.md 可用
const rewriteInstruction = ref('')
const rewriteResult = ref<RewriteResult | null>(null)
const rewriteRunning = ref(false)
const rewriteApplying = ref(false)
const draftChapter = computed<number | null>(() => {
  const m = selected.value.match(/工作区[\/\\]草稿-(\d+)\.md$/)
  return m ? Number(m[1]) : null
})

const kind = ref<'long' | 'short'>('long')
const targetWords = ref(0)
async function loadKind(): Promise<void> {
  try {
    const config = await getConfig(name.value)
    kind.value = (config.kind ?? 'long') === 'short' ? 'short' : 'long'
    targetWords.value = Number(config.book?.target_words) || 0
  } catch {
    /* ignore */
  }
}

const selectedMode = computed<'text' | 'md'>(() => {
  const f = files.value.find((x) => x.path === selected.value)
  return f?.mode ?? 'md'
})
/** 设定/大纲文件：结构化表单待 core（sfield/ol-act），当前用 CodeMirror 编辑原始 md */
const isSettingFile = computed(() => /定稿[\/\\]设定[\/\\]/.test(selected.value))
const isOutlineFile = computed(() => /^大纲[\/\\]/.test(selected.value))
const dirty = computed(() => content.value !== original.value)
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
/** 字数进度（vs 全书 target_words；章级目标 core 后补） */
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

/** 工具栏「改写」：聚焦下方改写指令框（仅草稿可用，联动 rewrite-panel） */
function focusRewrite(): void {
  document.querySelector<HTMLTextAreaElement>('.rewrite-instr')?.focus()
}

async function loadFiles(): Promise<void> {
  error.value = ''
  try {
    files.value = await listFiles(name.value)
    // 文件导航归左栏 FileTree：无 query 时设默认 file，让 FileTree 高亮与 selected 一致
    if (files.value.length > 0 && !route.query.file) {
      void router.replace({ query: { file: files.value[0]!.path } })
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function loadFile(): Promise<void> {
  if (!selected.value) return
  loading.value = true
  error.value = ''
  rewriteResult.value = null
  try {
    const data = await readFile(name.value, selected.value)
    content.value = data
    original.value = data
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function save(): Promise<void> {
  if (!selected.value || !dirty.value) return
  saving.value = true
  error.value = ''
  try {
    await writeFile(name.value, selected.value, content.value)
    original.value = content.value
    savedMsg.value = '已保存'
    setTimeout(() => (savedMsg.value = ''), 1500)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

// 同步编辑态到共享状态（顶栏保存按钮读取）+ 监听顶栏触发保存
watch(dirty, (v) => (sharedDirty.value = v), { immediate: true })
watch(saving, (v) => (sharedSaving.value = v))
watch(saveTick, (t) => { if (t > 0) void save() })

const revertShow = ref(false)
function revert(): void {
  // 打开回滚历史面板（RevertMask）；版本列表/diff 待 core git 备份 ref API
  revertShow.value = true
}
async function revertConfirm(chapter: number): Promise<void> {
  if (!Number.isFinite(chapter) || chapter < 1) {
    error.value = '章号/篇号得是正整数'
    return
  }
  reverting.value = true
  error.value = ''
  try {
    const data = await revertBook(name.value, chapter)
    savedMsg.value = data.message ?? '已回滚'
    setTimeout(() => (savedMsg.value = ''), 3000)
    await loadFiles()
    if (selected.value) await loadFile()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    reverting.value = false
  }
}

/** 改写:local(选段)/ whole(整章)→ POST /rewrite → DiffView */
async function rewriteRun(mode: 'local' | 'whole'): Promise<void> {
  if (!draftChapter.value || !name.value || rewriteRunning.value) return
  if (!rewriteInstruction.value.trim()) {
    error.value = '请填改写指令'
    return
  }
  let selection = ''
  if (mode === 'local') {
    const sel = codeRef.value?.getSelection()
    if (!sel || !sel.text.trim()) {
      error.value = '局部改写需先在编辑器选中段落'
      return
    }
    selection = sel.text
  }
  rewriteRunning.value = true
  error.value = ''
  rewriteResult.value = null
  try {
    const body: { chapter: number; mode: 'local' | 'whole'; instruction: string; selection?: string } = {
      chapter: draftChapter.value,
      mode,
      instruction: rewriteInstruction.value.trim(),
    }
    if (mode === 'local') body.selection = selection
    rewriteResult.value = await rewriteDraft(name.value, body)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
  rewriteRunning.value = false
}

/** 应用改写:accept 落盘(更新编辑器),false 丢弃 */
async function rewriteApply(accept: boolean): Promise<void> {
  if (!draftChapter.value || !name.value || !rewriteResult.value) return
  rewriteApplying.value = true
  error.value = ''
  try {
    const d = await applyRewrite(name.value, {
      chapter: draftChapter.value,
      content: rewriteResult.value.rewritten,
      accept,
    })
    if (accept && d.applied) {
      content.value = rewriteResult.value.rewritten
      original.value = rewriteResult.value.rewritten
      savedMsg.value = '改写已落盘(原稿备份 草稿-' + draftChapter.value + '.bak.md)'
      setTimeout(() => (savedMsg.value = ''), 3000)
    }
    rewriteResult.value = null
    if (!accept) hint('已丢弃改写')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
  rewriteApplying.value = false
}

watch(
  () => route.params.name,
  (n) => {
    if (typeof n === 'string') {
      loadFiles()
      void loadKind()
    }
  },
  { immediate: true },
)
watch(selected, () => {
  void loadFile()
})

// 左栏 FileTree 选文件 → 跳 /edit?file=xxx → 同步 selected 打开（第二刀联动）
watch(
  () => route.query.file,
  (f) => {
    if (typeof f === 'string' && f && f !== selected.value) {
      selected.value = f
    }
  },
  { immediate: true },
)
</script>

<template>
  <section class="editor">
    <div class="editor-inner">
      <!-- edit-info：单行流式 [面包屑+状态] —gap— [字数]，底部实线（保存▾移至标题右下） -->
      <div v-if="selected && !loading && content" class="edit-info">
        <span class="ei-crumbs">{{ kind === 'short' ? '短篇' : '长篇' }} › <b>{{ fileTitle }}</b></span>
        <span v-if="dirty" class="et-dirty">● 未保存</span>
        <span v-else-if="savedMsg" class="et-dirty saved">✓ {{ savedMsg }}</span>
        <span class="doc-status" :class="docStatus.cls">{{ docStatus.label }}</span>
        <span class="ei-gap"></span>
        <span class="et-wc">
          <b>{{ words.toLocaleString() }}</b> / {{ targetWords ? targetWords.toLocaleString() : '—' }} 字<span class="et-bar"><div :style="{ width: pct + '%', background: barColor }"></div></span><span>{{ pct }}%</span>
        </span>
      </div>
      <!-- 章节标题（楷体居中）/ 未选提示 -->
      <h1 v-if="selected" class="chapter-title">{{ fileTitle }}</h1>
      <div v-else class="ei-crumbs" style="text-align:center;padding:32px 0">（从左侧选一个文件）</div>
      <!-- chapter-meta-line：钩子·情绪(左) + 保存▾(右) 同排；底部虚线分隔编辑区 -->
      <div v-if="selected && !loading && content" class="chapter-meta-line">
        <span class="meta-text">{{ metaLine }}</span>
        <span class="et-split" ref="menuRef">
          <button class="et-btn save" :disabled="!dirty || saving" @click="save">
            <svg class="ico" viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>
            {{ saving ? '保存中…' : '保存' }}
          </button>
          <button class="et-btn dropdown" :class="{ disabled: !dirty || saving }" :disabled="!dirty || saving" @click="toggleMenu">
            <svg class="ico" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          <div v-if="menuOpen" class="et-menu">
            <button class="et-menu-item" :disabled="!draftChapter" @click="menuOpen = false; focusRewrite()">
              <svg class="ico" viewBox="0 0 24 24"><path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z"/></svg>
              改写{{ draftChapter ? `第 ${draftChapter} ${kind === 'short' ? '篇' : '章'}` : '（仅草稿）' }}
            </button>
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
          <div class="se-sub">细纲已就绪 · 去工作台让 AI 生成首版，或直接在此续写</div>
          <RouterLink class="btn primary" :to="`/books/${name}/workbench`">去工作台生成 →</RouterLink>
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

      <!-- 改写入口（仅草稿 工作区/草稿-N.md）-->
      <div v-if="draftChapter && selected && !loading" class="rewrite-panel">
        <h4>✍ 改写 · 第 {{ draftChapter }} {{ kind === 'short' ? '篇' : '章' }}草稿</h4>
        <textarea
          v-model="rewriteInstruction"
          class="rewrite-instr"
          :placeholder="`改写指令，如「更紧张」「压到 300 字」；整${kind === 'short' ? '篇' : '章'}返修可粘贴审稿意见`"
        ></textarea>
        <div class="rewrite-btns">
          <button class="btn" :disabled="rewriteRunning || !rewriteInstruction.trim()" @click="rewriteRun('local')">局部改写选段</button>
          <button class="btn" :disabled="rewriteRunning || !rewriteInstruction.trim()" @click="rewriteRun('whole')">
            {{ rewriteRunning ? '生成中…' : `整${kind === 'short' ? '篇' : '章'}返修` }}
          </button>
        </div>
        <DiffView
          v-if="rewriteResult"
          :diff="rewriteResult.diff"
          :applying="rewriteApplying"
          @accept="rewriteApply(true)"
          @reject="rewriteApply(false)"
        />
      </div>
    </div>
    <RevertMask v-model:show="revertShow" @confirm="revertConfirm" />
  </section>
</template>

<style scoped>
/* mockup 覆盖 .editor-inner/.edit-info/.et-btn/.et-wc/.doc-status；此处仅补 mockup 无的改写面板与提示。 */
.error{color:var(--cinnabar);font-size:13px}
.sform-hint{font-size:12.5px;color:var(--ink-cyan);padding:10px 14px;background:var(--cyan-10);border-radius:8px;margin-bottom:12px;line-height:1.6}
.hint{color:var(--text-2);font-size:13px;padding:24px 0;text-align:center}
.rewrite-panel{margin-top:18px;padding-top:16px;border-top:1px dashed var(--border)}
.rewrite-panel h4{margin:0 0 10px;font-size:13px;color:var(--ink)}
.rewrite-instr{width:100%;min-height:56px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit;resize:vertical;box-sizing:border-box;background:var(--paper);color:var(--ink);outline:none;transition:border-color .2s,box-shadow .2s}
.rewrite-instr:focus{border-color:var(--ink-cyan);box-shadow:0 0 0 3px var(--cyan-10)}
.rewrite-btns{display:flex;gap:8px;margin-top:10px}
/* mockup 用 .btn.disabled（opacity:.4）表达禁用；Vue 用原生 button :disabled，
   补禁用视觉（opacity + cursor）让禁用态与 mockup 一致。 */
.edit-info .et-btn:disabled{opacity:.4;cursor:default;pointer-events:none}
.rewrite-btns .btn:disabled{opacity:.4;cursor:default}

/* edit-info / chapter-title(楷体) / chapter-meta-line / et-btn 走 v5-components.css 全局；
   此处仅补 split button（保存▾合体，替代 mockup 三个独立 et-btn）与禁用态。 */
/* 标题区：文章名加大 + 整体收紧间距（edit-info 16→8 / meta-line 24·14→14·8） */
.editor-inner{padding-top:16px}
.edit-info{margin-bottom:8px}
.chapter-title{font-size:32px;line-height:1.05;margin-bottom:2px}
.chapter-meta-line{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;padding-bottom:8px}
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
