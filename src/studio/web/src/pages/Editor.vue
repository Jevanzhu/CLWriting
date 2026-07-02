<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import CodeEditor from '../components/CodeEditor.vue'
import DiffView from '../components/DiffView.vue'
import { useBookStore } from '../stores/book'

const route = useRoute()
const router = useRouter()
const book = useBookStore()
const name = computed(() => (typeof route.params.name === 'string' ? route.params.name : ''))

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

// 改写（仅草稿 工作区/草稿-N.md）：指令双向绑 store，结果/运行态读 slot
const rewriteInstruction = computed({
  get: () => book.data.editor.rewriteInstruction,
  set: (v: string) => {
    book.data.editor.rewriteInstruction = v
  },
})
const rewriteResult = computed(() => book.data.editor.rewriteResult)
const rewriteRunning = computed(() => book.data.editor.rewriteRunning)
const rewriteApplying = computed(() => book.data.editor.rewriteApplying)
const draftChapter = computed<number | null>(() => {
  const m = selected.value.match(/工作区[\/\\]草稿-(\d+)\.md$/)
  return m ? Number(m[1]) : null
})

// CodeEditor 组件实例 ref（getSelection 用于局部改写，非数据态）
const codeRef = ref<{ getSelection: () => { text: string; from: number; to: number } | null } | null>(null)

async function save(): Promise<void> {
  if (!selected.value || !dirty.value) return
  await book.save(name.value)
}

async function revert(): Promise<void> {
  const input = window.prompt('回滚到第几章/篇？\n（该章/篇之后的定稿 + 工作区将被丢弃；丢弃内容进 git 备份 ref，可找回）')
  if (input === null) return
  const chapter = Number(input)
  if (!Number.isFinite(chapter) || chapter < 1) {
    book.data.editor.error = '章号/篇号得是正整数'
    return
  }
  if (!window.confirm(`确认回滚到第 ${chapter} 章/篇？之后的内容将被丢弃。`)) return
  await book.revert(name.value, chapter)
}

/** 改写:local(选段)/ whole(整章)→ POST /rewrite → DiffView */
async function rewriteRun(mode: 'local' | 'whole'): Promise<void> {
  if (!draftChapter.value || !name.value || rewriteRunning.value) return
  if (!rewriteInstruction.value.trim()) {
    book.data.editor.error = '请填改写指令'
    return
  }
  let selection: string | undefined
  if (mode === 'local') {
    const sel = codeRef.value?.getSelection()
    if (!sel || !sel.text.trim()) {
      book.data.editor.error = '局部改写需先在编辑器选中段落'
      return
    }
    selection = sel.text
  }
  await book.rewriteRun(name.value, draftChapter.value, mode, rewriteInstruction.value.trim(), selection)
}

/** 应用改写:accept 落盘(更新编辑器),false 丢弃 */
async function rewriteApply(accept: boolean): Promise<void> {
  if (!draftChapter.value || !name.value || !rewriteResult.value) return
  await book.rewriteApply(name.value, draftChapter.value, accept)
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
