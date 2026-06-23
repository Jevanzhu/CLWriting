<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import CodeEditor from '../components/CodeEditor.vue'
import DiffView from '../components/DiffView.vue'
import BookTabs from '../components/BookTabs.vue'

interface FileEntry {
  path: string
  mode: 'text' | 'md'
}
interface DiffLine {
  type: 'same' | 'add' | 'del'
  text: string
}
interface RewriteResult {
  mode: 'local' | 'whole'
  original: string
  rewritten: string
  diff: DiffLine[]
}

const route = useRoute()
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
    const r = await fetch(`/api/books/${encodeURIComponent(name.value)}/config`)
    const d = (await r.json()) as { config?: { kind?: string } }
    kind.value = (d.config?.kind ?? 'long') === 'short' ? 'short' : 'long'
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
    const r = await fetch(`/api/books/${encodeURIComponent(name.value)}/files`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = (await r.json()) as { files: FileEntry[] }
    files.value = data.files ?? []
    if (files.value.length > 0 && !files.value.some((f) => f.path === selected.value)) {
      selected.value = files.value[0]!.path
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
    const r = await fetch(
      `/api/books/${encodeURIComponent(name.value)}/file?file=${encodeURIComponent(selected.value)}`,
    )
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = (await r.json()) as { content: string }
    content.value = data.content
    original.value = data.content
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
    const r = await fetch(
      `/api/books/${encodeURIComponent(name.value)}/file?file=${encodeURIComponent(selected.value)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: content.value }),
      },
    )
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
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
    const r = await fetch(`/api/books/${encodeURIComponent(name.value)}/revert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chapter }),
    })
    const data = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string }
    if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`)
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
    const body: Record<string, unknown> = {
      chapter: draftChapter.value,
      mode,
      instruction: rewriteInstruction.value.trim(),
    }
    if (mode === 'local') body.selection = selection
    const r = await fetch(`/api/books/${encodeURIComponent(name.value)}/rewrite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const d = (await r.json().catch(() => ({}))) as {
      ok?: boolean
      mode?: 'local' | 'whole'
      original?: string
      rewritten?: string
      diff?: DiffLine[]
      error?: string
    }
    if (r.ok && d.ok) {
      rewriteResult.value = {
        mode: d.mode ?? mode,
        original: d.original ?? '',
        rewritten: d.rewritten ?? '',
        diff: d.diff ?? [],
      }
    } else {
      error.value = d.error ?? `HTTP ${r.status}`
    }
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
    const r = await fetch(`/api/books/${encodeURIComponent(name.value)}/rewrite-apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chapter: draftChapter.value, content: rewriteResult.value.rewritten, accept }),
    })
    const d = (await r.json().catch(() => ({}))) as { ok?: boolean; applied?: boolean; error?: string }
    if (r.ok && d.ok) {
      if (accept && d.applied) {
        content.value = rewriteResult.value.rewritten
        original.value = rewriteResult.value.rewritten
        savedMsg.value = '改写已落盘(原稿备份 草稿-' + draftChapter.value + '.bak.md)'
        setTimeout(() => (savedMsg.value = ''), 3000)
      }
      rewriteResult.value = null
    } else {
      error.value = d.error ?? `HTTP ${r.status}`
    }
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
</script>

<template>
  <section class="editor">
    <BookTabs :name="name" active="edit" />
    <div class="layout">
      <aside class="file-list">
        <div class="file-list-head">
          <h3>文件</h3>
          <button class="btn-revert" :disabled="reverting" @click="revert">
            {{ reverting ? '回滚中…' : '⏪ 回滚' }}
          </button>
        </div>
        <ul>
          <li
            v-for="f in files"
            :key="f.path"
            :class="{ active: f.path === selected }"
            @click="selected = f.path"
          >
            <span class="path">{{ f.path }}</span>
            <span class="mode">{{ f.mode === 'text' ? '正文' : '设定' }}</span>
          </li>
        </ul>
      </aside>
      <div class="edit-area">
        <div class="toolbar">
          <span class="cur">{{ selected || '（选一个文件）' }}</span>
          <span v-if="dirty" class="dirty">● 未保存</span>
          <span v-else-if="savedMsg" class="saved">{{ savedMsg }}</span>
          <button class="btn-save" :disabled="!dirty || saving" @click="save">
            {{ saving ? '保存中…' : '保存' }}
          </button>
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

        <!-- 改写入口(仅草稿 工作区/草稿-N.md)-->
        <div v-if="draftChapter && selected && !loading" class="rewrite-panel">
          <h4>✍ 改写 · 第 {{ draftChapter }} {{ kind === 'short' ? '篇' : '章' }}草稿</h4>
          <textarea
            v-model="rewriteInstruction"
            class="rewrite-instr"
            :placeholder="`改写指令,如「更紧张」「压到 300 字」;整${kind === 'short' ? '篇' : '章'}返修可粘贴审稿意见`"
          ></textarea>
          <div class="rewrite-btns">
            <button class="btn-rw" :disabled="rewriteRunning || !rewriteInstruction.trim()" @click="rewriteRun('local')">
              局部改写选段
            </button>
            <button class="btn-rw" :disabled="rewriteRunning || !rewriteInstruction.trim()" @click="rewriteRun('whole')">
              {{ rewriteRunning ? '生成中…' : '整' + (kind === 'short' ? '篇' : '章') + '返修' }}
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
    </div>
  </section>
</template>

<style scoped>
.editor {
  max-width: 1100px;
  margin: 0 auto;
  text-align: left;
}
.layout {
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: 16px;
}
.file-list {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 12px;
  height: fit-content;
}
.file-list-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.file-list h3 {
  margin: 0;
  font-size: 13px;
  color: #6b7280;
}
.btn-revert {
  padding: 3px 10px;
  border: 1px solid #fca5a5;
  border-radius: 4px;
  background: #fff;
  color: #dc2626;
  cursor: pointer;
  font-size: 12px;
}
.btn-revert:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-revert:hover:not(:disabled) {
  background: #fef2f2;
}
.file-list ul {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 2px;
}
.file-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}
.file-list li:hover {
  background: #f3f4f6;
}
.file-list li.active {
  background: #eff6ff;
  color: #3b82f6;
}
.file-list .path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-list .mode {
  color: #9ca3af;
  font-size: 11px;
  flex-shrink: 0;
  margin-left: 8px;
}
.edit-area {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 12px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
  font-size: 13px;
}
.toolbar .cur {
  color: #374151;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toolbar .dirty {
  color: #d97706;
}
.toolbar .saved {
  color: #059669;
}
.btn-save {
  padding: 5px 16px;
  border: none;
  border-radius: 5px;
  background: #3b82f6;
  color: #fff;
  cursor: pointer;
  font-size: 13px;
}
.btn-save:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.error {
  color: #dc2626;
  font-size: 13px;
}
.hint {
  color: #6b7280;
  font-size: 13px;
  padding: 24px 0;
  text-align: center;
}

/* 改写面板 */
.rewrite-panel {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px dashed #e5e7eb;
}
.rewrite-panel h4 {
  margin: 0 0 8px;
  font-size: 13px;
  color: #374151;
}
.rewrite-instr {
  width: 100%;
  min-height: 56px;
  padding: 8px 10px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
  resize: vertical;
  box-sizing: border-box;
}
.rewrite-btns {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.btn-rw {
  padding: 6px 14px;
  border: 1px solid #7c3aed;
  border-radius: 6px;
  background: #fff;
  color: #7c3aed;
  cursor: pointer;
  font-size: 13px;
}
.btn-rw:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
