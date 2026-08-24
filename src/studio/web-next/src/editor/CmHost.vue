<script setup lang="ts">
// CodeMirror 6 封装（细案 §5 editor/CmHost.vue）：Obsidian 风格正文编辑器。
// 无行号/无卡片边框、lineWrapping、正文字体（--prose-* 偏好）；md 模式加 markdown() 高亮。
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { defaultKeymap, history, historyKeymap, isolateHistory, undo, redo } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import {
  HighlightStyle,
  bracketMatching,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap, openSearchPanel } from '@codemirror/search'
import { autocompletion, startCompletion, completionKeymap, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { getCompletionNames } from '../api/settings'
import { useWorkspaceStore } from '../stores/workspace'
import { useUiStore } from '../stores/ui'
import { typewriterExt, centerCursorLine } from './typewriter'
import { Compartment, EditorState, Transaction, type Extension } from '@codemirror/state'
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  rectangularSelection,
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

const props = defineProps<{ modelValue: string; mode: 'text' | 'md'; readonly?: boolean; typewriter?: boolean; historyKey?: string }>()
const emit = defineEmits<{
  'update:modelValue': [string]
  'selectionChange': []
}>()
const el = ref<HTMLElement>()
let view: EditorView | null = null

// 墨色为主的高亮（md 模式生效；text 模式纯文本）
const monoHighlight = HighlightStyle.define([
  { tag: t.heading, color: 'var(--text-normal)', fontWeight: '700' },
  { tag: t.strong, color: 'var(--text-normal)', fontWeight: '600' },
  { tag: t.emphasis, color: 'var(--text-normal)', fontStyle: 'italic' },
  { tag: [t.link, t.url], color: 'var(--text-accent)' },
  { tag: t.list, color: 'var(--text-accent)' },
  { tag: t.quote, color: 'var(--text-muted)' },
  { tag: t.meta, color: 'var(--text-faint)' },
  { tag: t.monospace, color: 'var(--text-muted)' },
])

// 外观：透明底贴 --background-primary，正文居中限宽，无焦点边框（Obsidian 风）
const editorTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    height: '100%',
    fontSize: 'var(--prose-size)',
    color: 'var(--text-normal)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--prose-font)', lineHeight: 'var(--prose-lh)' },
  '.cm-content': { caretColor: 'var(--text-accent)', padding: '0', maxWidth: 'var(--prose-max-width, 720px)', margin: '0 auto' },
  '.cm-line': { padding: '0' },
  '.cm-activeLine': { backgroundColor: 'var(--background-modifier-hover)' },
  // Autocomplete tooltip 美化（圆角卡片 + 阴影 + 选中高亮）
  '.cm-tooltip.cm-tooltip-autocomplete': {
    border: '1px solid var(--background-modifier-border)',
    borderRadius: '8px',
    background: 'var(--background-primary)',
    boxShadow: '0 6px 24px rgba(0,0,0,0.10)',
  },
  '.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-ui)',
    fontSize: '14px',
  },
  '.cm-tooltip-autocomplete > ul > li': {
    padding: '5px 14px',
    borderRadius: '4px',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    background: 'var(--interactive-accent)',
    color: 'var(--text-on-accent)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--background-modifier-active-hover)',
  },
})

const editorSetup: Extension[] = [
  // history() 不在此裸挂载（X-1 清理）：唯一挂载点是下方 historyConf Compartment，
  // 双挂载是混淆源（historyKeymap 在 keymap.of 内，不受影响）
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(monoHighlight),
  bracketMatching(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSpecialChars(),
  highlightSelectionMatches(),
  autocompletion({ override: [characterCompletion], activateOnTyping: true, icons: false }),
  EditorView.updateListener.of((u) => {
    // @ 触发角色名补全（CM6 默认 activateOnTyping 只认 \w，@ 不触发）
    if (!u.docChanged || !completionEntries.value.length) return
    const head = u.state.selection.main.head
    if (u.state.doc.sliceString(head - 1, head) === '@') startCompletion(u.view)
  }),
  keymap.of([
    { key: 'Mod-i', run: (v) => { startCompletion(v); return true } },
    ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap,
  ]),
]

// 补全名称：输入 @ 自动触发 或 Cmd+I 手动触发
interface NameEntry { label: string; detail: string }
const completionEntries = ref<NameEntry[]>([])
function characterCompletion(context: CompletionContext): CompletionResult | null {
  const entries = completionEntries.value
  if (!entries.length) return null

  // @ 触发：光标前有 @ 开头的文本
  const at = context.matchBefore(/@[一-鿿\w]*/)
  if (at && at.text.length >= 1) {
    const query = at.text.slice(1)
    const filtered = query ? entries.filter((e) => e.label.includes(query)) : entries
    if (filtered.length) {
      return {
        from: at.from,
        options: filtered.map((e) => ({ label: e.label, type: 'variable', detail: e.detail })),
        validFor: /^@?[一-鿿\w]*$/,
      }
    }
  }

  // 显式触发（Cmd+I / Ctrl+Space）：总是弹出全部名称，在光标位置插入
  if (!context.explicit) return null
  return {
    from: context.pos,
    options: entries.map((e) => ({ label: e.label, type: 'variable', detail: e.detail })),
    validFor: /^[一-鿿\w]*$/,
  }
}

// 打字机滚动实现收编 editor/typewriter.ts 单源（含 CM6 更新中禁 dispatch 的根因注释与回归测试）
const typewriterConf = new Compartment()
// P1-9：mode/readonly 用 Compartment 管理，切文档时动态重配（非仅在 mount 时读取）
const modeConf = new Compartment()
const readonlyConf = new Compartment()
// RB-FE-P1-1（X-1 口径校正）：history() 唯一挂载点在此 Compartment——注意 reconfigure
// 对已存在的 historyField 携带旧值不重建（CM6 reconfigure 语义），单靠重配并**不**清栈；
// 真清栈靠切文档时的「卸载 → 重挂」两步（字段重新 init，见下方 watch），全量替换事务
// 仅丢弃被替换区间覆盖的旧事件（文档边界插入事件存活，不承担清栈）。
const historyConf = new Compartment()

onMounted(() => {
  if (!el.value) return
  view = new EditorView({
    doc: props.modelValue,
    extensions: [
      historyConf.of(history()),
      editorSetup,
      editorTheme,
      EditorView.lineWrapping,
      readonlyConf.of(EditorState.readOnly.of(props.readonly ?? false)),
      modeConf.of(props.mode === 'md' ? [markdown()] : []),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) emit('update:modelValue', u.state.doc.toString())
        if (u.selectionSet || u.focusChanged) emit('selectionChange')
      }),
      // F5（五十九轮）：组合态标记 + 组合结束后（延迟一拍让 CM6 先冲排组合文本插入）
      // 应用挂起的外部全量替换（挂起只作「有外部变更待应用」的标记，应用时取最新值——B-1）
      EditorView.domEventHandlers({
        compositionstart: () => {
          composing = true
        },
        compositionend: () => {
          composing = false
          if (pendingExternal === null || !view) return
          pendingExternal = null
          // B-1（第六十轮）：应用「当下最新 modelValue」而非登记时的快照——组合期每次
          // emit 已把已组文本同步进 store（回写后 v === doc，watch 不再刷新挂起值），
          // 登记快照冻结在旧时点，应用旧值会抹掉快照点之后续打的整段组合文本（且
          // addToHistory=false 不可 undo、回写 store 触发 autosave 落盘）。最新值若与
          // 当前 doc 一致（用户续打已覆盖外部变更，同 dirty 本地优先口径）则不替换。
          setTimeout(() => {
            const latest = props.modelValue
            if (!view || latest === view.state.doc.toString()) return
            applyExternalReplace(latest)
          }, 0)
        },
      }),
      typewriterConf.of(typewriterExt(props.typewriter ?? false)),
    ],
    parent: el.value,
  })
})

// mode 切换（text ↔ md）：动态重配扩展
watch(
  () => props.mode,
  (m) => {
    if (!view) return
    view.dispatch({ effects: modeConf.reconfigure(m === 'md' ? [markdown()] : []) })
  },
)

// readonly 切换：动态重配
watch(
  () => props.readonly,
  (r) => {
    if (!view) return
    view.dispatch({ effects: readonlyConf.reconfigure(EditorState.readOnly.of(r ?? false)) })
  },
)

// 外部 modelValue 变（切文档 / doc.refresh / SSE sync）→ 同步；同文档外部同步仅当差异时
// 替换避免光标跳，切文档则恒替换（见下方 X-1 注释）
// F-P1-3：addToHistory.of(false) 标记为外部同步，不清空 undo 历史（标题提交后 ⌘Z 仍可回退）
// RB-FE-P1-1 + X-1：historyKey（docId）变化 = 切文档——「卸载 → 重挂」两步真重置 undo/redo
// 栈 + 恒派发全量替换事务（内容相同也替换为 v，同步文档内容）。旧版仅 reconfigure + 差异
// 替换：同内容切换时旧 undo 栈完整残留，⌘Z 把旧文档逆编辑回灌进新文档 → dirty → autosave
// 落盘污染；undo 后切换时 redo 栈的边界插入事件亦残留。isolateHistory('full') 只切断新旧
// 事件编组，不承担清栈。
let lastHistoryKey: string | undefined = props.historyKey
// F5（五十九轮）：IME 组合态守卫——外部全量替换（refresh/SSE 同步）落在组合输入中
// 会吞掉正在组合的中文（组合文本被整段替换打断）。组合标记本地维护
// （compositionstart/end 事件对）+ view.composing 双判：CM6 的 composing>0 要等组合期
// 内真实输入事件，只挂 compositionstart（尚无键入）时它仍为 false——本地标记补齐这个
// 窗口。compositionend 后延迟一拍（setTimeout 0）再应用挂起值：CM6 的 MutationObserver
// 在微任务里冲排组合文本插入，先于我们的全量替换才不会把组合文本算进替换 diff。
let composing = false
let pendingExternal: string | null = null
/** 同文档外部全量替换的执行体（composing 守卫解耦出）。 */
function applyExternalReplace(v: string): void {
  if (!view) return
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: v },
    annotations: Transaction.addToHistory.of(false),
  })
}
watch(
  [() => props.modelValue, () => props.historyKey],
  ([v, key]) => {
    if (!view) return
    const docSwitch = key !== lastHistoryKey
    lastHistoryKey = key
    if (!docSwitch) {
      // 同文档外部同步：仅差异时替换，避免光标跳（此分支不得恒替换）
      if (v !== view.state.doc.toString()) {
        // F5（五十九轮）：组合输入中不立即替换——挂起到 compositionend 后
        //（B-1：挂起登记仅标记「有待应用的外部变更」，应用时取当下最新 modelValue）
        if (view.composing || composing) {
          pendingExternal = v
          return
        }
        applyExternalReplace(v)
      }
      return
    }
    // 切文档：两步真重置历史（X-1）——reconfigure(history()) 对已存在 historyField 携带
    // 旧值不重建（CM6 reconfigure 语义），实测两条残留路径：同内容切换无替换事务时旧
    // undo 栈整体残留；切换前 undo 过一次时，redo 栈的文档边界插入事件不被全量替换的
    // addMapping 丢弃（mapPos 边界存活，redo 仍可回灌）。故先卸载 history 扩展（字段随
    // compartment 移除、旧值即丢弃），下一事务重挂——字段重新 init，栈必然为空；第二步
    // 恒派发全量替换（同文亦替换，内容同步 + 二次保险），注解保持原口径。
    view.dispatch({ effects: historyConf.reconfigure([]) })
    view.dispatch({
      effects: historyConf.reconfigure(history()),
      changes: { from: 0, to: view.state.doc.length, insert: v },
      annotations: [Transaction.addToHistory.of(false), isolateHistory.of('full')],
    })
  },
)

// 补全名称列表（从设定 API 加载：角色名 + 物品名；@ / Cmd+I 触发用）
// F-P1-5：请求序号防竞态（快速切书时旧请求晚于新请求 resolve 不覆盖）
const ws = useWorkspaceStore()
let compReqId = 0
watch(
  () => ws.bookName,
  async (name) => {
    if (!name || props.readonly) { completionEntries.value = []; return }
    const myId = ++compReqId
    try {
      const r = await getCompletionNames(name)
      if (myId !== compReqId) return // 旧请求，丢弃
      completionEntries.value = [
        ...r.characters.map((n) => ({ label: n, detail: '角色' })),
        ...r.items.map((n) => ({ label: n, detail: '物品' })),
      ]
    } catch { /* 无设定数据 */ }
  },
  { immediate: true },
)

// 打字机开关（专注模式切换）：动态重配；进入时立即把当前行居中
watch(
  () => props.typewriter,
  (v) => {
    if (!view) return
    view.dispatch({ effects: typewriterConf.reconfigure(typewriterExt(v ?? false)) })
    if (v) centerCursorLine(view)
  },
)

/** 在光标处插入文本（右栏速查「插入」经 EditorView 调用；替换选区 + 滚动 + 回焦）。 */
function insertText(text: string): void {
  if (!view) return
  const sel = view.state.selection.main
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from + text.length },
    scrollIntoView: true,
  })
  view.focus()
}

/** 取当前选区文本（空选区 → 空串；选段改写经 EditorView 调用）。 */
function getSelection(): string {
  if (!view) return ''
  const sel = view.state.selection.main
  return sel.from === sel.to ? '' : view.state.sliceDoc(sel.from, sel.to)
}
/** 取选区矩形（视口坐标），失焦或空选区返回 null（浮动工具栏定位用）*/
function getSelectionRect(): { left: number; top: number; right: number; bottom: number } | null {
  if (!view || !view.hasFocus) return null
  const sel = view.state.selection.main
  if (sel.from === sel.to) return null
  const a = view.coordsAtPos(sel.from)
  const b = view.coordsAtPos(sel.to)
  if (!a || !b) return null
  return {
    left: Math.min(a.left, b.left),
    right: Math.max(a.right, b.right),
    top: Math.min(a.top, b.top),
    bottom: Math.max(a.bottom, b.bottom),
  }
}
/** 是否有非空选区（右键菜单判断剪切/复制启用） */
function hasSelection(): boolean {
  if (!view) return false
  const sel = view.state.selection.main
  return sel.from !== sel.to
}
/** 剪切：复制选区到剪贴板并删除 */
async function clipboardCut(): Promise<void> {
  if (!view) return
  const sel = view.state.selection.main
  if (sel.from === sel.to) return
  try { await navigator.clipboard.writeText(view.state.sliceDoc(sel.from, sel.to)) } catch { useUiStore().toast('剪贴板权限被拒绝，剪切未生效', 'error') /* Z-26：不再静默 */ }
  view.dispatch({ changes: { from: sel.from, to: sel.to, insert: '' } })
  view.focus()
}
/** 复制：复制选区到剪贴板 */
async function clipboardCopy(): Promise<void> {
  if (!view) return
  const sel = view.state.selection.main
  if (sel.from === sel.to) return
  try { await navigator.clipboard.writeText(view.state.sliceDoc(sel.from, sel.to)) } catch { useUiStore().toast('剪贴板权限被拒绝，复制未生效', 'error') /* Z-26：不再静默 */ }
  view.focus()
}
/** 粘贴：从剪贴板读取并替换选区 */
async function clipboardPaste(): Promise<void> {
  if (!view) return
  try {
    const text = await navigator.clipboard.readText()
    const sel = view.state.selection.main
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert: text }, selection: { anchor: sel.from + text.length }, scrollIntoView: true })
  } catch { useUiStore().toast('剪贴板权限被拒绝，粘贴未生效', 'error') /* Z-26：不再静默 */ }
  view.focus()
}
/** 全选 */
function selectAll(): void {
  if (!view) return
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
  view.focus()
}
/** 撤销 */
function undoAction(): void {
  if (!view) return
  undo(view)
  view.focus()
}
/** 重做 */
function redoAction(): void {
  if (!view) return
  redo(view)
  view.focus()
}
/** 打开查找面板 */
function openSearch(): void {
  if (!view) return
  openSearchPanel(view)
  view.focus()
}
defineExpose({ insertText, getSelection, getSelectionRect, hasSelection, clipboardCut, clipboardCopy, clipboardPaste, selectAll, undoAction, redoAction, openSearch })

// B-25（第六十轮）：销毁后置 null——compositionend 已排定的 setTimeout 与挂起的
// watch 回调靠 `if (!view) return` 短路，不留对 destroyed view 的 dispatch
onUnmounted(() => {
  view?.destroy()
  view = null
})
</script>

<template>
  <div ref="el" class="cm-host"></div>
</template>

<style scoped>
.cm-host {
  height: 100%;
}
.cm-host :deep(.cm-editor) {
  height: 100%;
}
.cm-host :deep(.cm-scroller) {
  overflow: auto;
}
/* 编辑器滚动条：比全局更细（6px → 近 Obsidian 极简风） */
.cm-host :deep(.cm-scroller)::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
.cm-host :deep(.cm-scroller)::-webkit-scrollbar-thumb {
  background: var(--background-modifier-border);
  border-radius: 3px;
}
.cm-host :deep(.cm-scroller)::-webkit-scrollbar-thumb:hover {
  background: var(--background-modifier-border-hover);
}
</style>
