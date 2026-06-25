<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import CodeEditor from '../components/CodeEditor.vue'
import DiffView from '../components/DiffView.vue'
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

const codeRef = ref<{ getSelection: () => { text: string; from: number; to: number } | null } | null>(null)

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
async function loadKind(): Promise<void> {
  try {
    const config = await getConfig(name.value)
    kind.value = (config.kind ?? 'long') === 'short' ? 'short' : 'long'
  } catch {
    /* ignore */
  }
}

const selectedMode = computed<'text' | 'md'>(() => {
  const f = files.value.find((x) => x.path === selected.value)
  return f?.mode ?? 'md'
})
const dirty = computed(() => content.value !== original.value)

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

async function revert(): Promise<void> {
  const input = window.prompt('回滚到第几章/篇？\n（该章/篇之后的定稿 + 工作区将被丢弃；丢弃内容进 git 备份 ref，可找回）')
  if (input === null) return
  const chapter = Number(input)
  if (!Number.isFinite(chapter) || chapter < 1) {
    error.value = '章号/篇号得是正整数'
    return
  }
  if (!window.confirm(`确认回滚到第 ${chapter} 章/篇？之后的内容将被丢弃。`)) return
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
    <div class="edit-area">
      <div class="toolbar">
        <span class="cur">{{ selected || '（从左侧选一个文件）' }}</span>
        <span v-if="dirty" class="dirty">● 未保存</span>
        <span v-else-if="savedMsg" class="saved">{{ savedMsg }}</span>
        <button class="btn danger" :disabled="reverting" @click="revert">{{ reverting ? '回滚中…' : '⏪ 回滚' }}</button>
        <button class="btn primary" :disabled="!dirty || saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
      </div>

      <p v-if="error" class="error">{{ error }}</p>
      <CodeEditor
        v-else-if="selected && !loading"
        ref="codeRef"
        :key="selected"
        :model-value="content"
        :mode="selectedMode"
        @update:model-value="content = $event"
      />
      <p v-else-if="loading" class="hint">加载中…</p>
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
  </section>
</template>

<style scoped>
.editor {
  margin: 0 auto;
  text-align: left;
}
.edit-area {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  font-size: 13px;
}
.toolbar .cur {
  color: var(--ink);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toolbar .dirty {
  color: var(--ochre);
}
.toolbar .saved {
  color: var(--ink-cyan);
}
.toolbar .btn {
  font-size: 12px;
  padding: 4px 12px;
}
.error {
  color: var(--cinnabar);
  font-size: 13px;
}
.hint {
  color: var(--text-2);
  font-size: 13px;
  padding: 24px 0;
  text-align: center;
}
.rewrite-panel {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px dashed var(--border);
}
.rewrite-panel h4 {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--ink);
}
.rewrite-instr {
  width: 100%;
  min-height: 56px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
  resize: vertical;
  box-sizing: border-box;
  background: var(--paper);
  color: var(--ink);
  outline: none;
}
.rewrite-instr:focus {
  border-color: var(--ink-cyan);
}
.rewrite-btns {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
</style>
