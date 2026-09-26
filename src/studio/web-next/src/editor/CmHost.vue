<script lang="ts">
// 对外暴露面（defineExpose）的类型
// 单源——父组件 EditorView 此前手写复制同一接口（CmHostExposed），增删方法时两侧只改
// 一处即漂移，且父侧漏改被可选链（`cmHost.value?.x`）静默吞掉，运行时才表现为
// 「点了没反应」。声明随组件走，父组件 `import type { CmHostHandle }` 引用；
// 下方 `defineExpose<CmHostHandle>(…)` 反向钉住实现面（漏暴露/多暴露/签名不符即编译期报错）。
export interface CmHostHandle {
  /** 在当前光标处插入文本（无 view 时为 no-op） */
  insertText: (t: string) => void
  /** 当前选区文本（无选区/无 view 时为空串） */
  getSelection: () => string
  hasSelection: () => boolean
  /** 光标偏移（无 view 时为 null） */
  getCursorOffset: () => number | null
  clipboardCut: () => Promise<void>
  clipboardCopy: () => Promise<void>
  clipboardPaste: () => Promise<void>
  selectAll: () => void
  undoAction: () => void
  redoAction: () => void
  openSearch: () => void
}
</script>

<script setup lang="ts">
// CodeMirror 6 封装（细案 §5 editor/CmHost.vue）：Obsidian 风格正文编辑器。
// 无行号/无卡片边框、lineWrapping、正文字体（--prose-* 偏好）；md 模式加 markdown 高亮。
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { defaultKeymap, history, historyKeymap, isolateHistory, undo, redo } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { HighlightStyle, bracketMatching, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap, openSearchPanel } from '@codemirror/search'
import {
  autocompletion,
  startCompletion,
  completionKeymap,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import { getCompletionNames } from '../api/settings'
import { useWorkspaceStore } from '../stores/workspace'
import { useUiStore } from '../stores/ui'
import { useStaleGuard } from '../composables/useStaleGuard'
import { typewriterExt, centerCursorLine } from './typewriter'
import { mapSelectionForFullReplace } from './external-replace'
import { Annotation, Compartment, EditorSelection, EditorState, Transaction, type Extension } from '@codemirror/state'
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

const props = defineProps<{
  modelValue: string
  mode: 'text' | 'md'
  readonly?: boolean
  typewriter?: boolean
  historyKey?: string
}>()
// 删 selectionChange 死契约——声明 + emit 全 src 零消费者
//（grep 含模板 @selection-change 形态核实），声明只留 update:modelValue
const emit = defineEmits<{
  'update:modelValue': [string]
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
  '.cm-content': {
    caretColor: 'var(--text-accent)',
    padding: '0',
    maxWidth: 'var(--prose-max-width, 720px)',
    margin: '0 auto',
  },
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
  // history() 不在此裸挂载（清理）：唯一挂载点是下方 historyConf Compartment，
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
    // userEvent 判别——仅用户输入事务（input.* 家族：键入/IME
    // 组合/粘贴/拖放，CM6 全量标注 userEvent）才触发；外部全量替换（SSE sync /
    // doc.refresh / 切文档）为程序事务、无 userEvent，此前 '@' 恰被替换到光标位时
    // 后台同步也会自动弹补全浮层（无输入意图的 UI 打扰）。
    if (!u.transactions.some((tr) => (tr.annotation(Transaction.userEvent) ?? '').startsWith('input'))) return
    const head = u.state.selection.main.head
    if (u.state.doc.sliceString(head - 1, head) === '@') {
      startCompletion(u.view)
      refreshCompletionNamesIfStale() // （-④）：触发即探 TTL，见函数头注
    }
  }),
  keymap.of([
    {
      key: 'Mod-i',
      run: (v) => {
        startCompletion(v)
        refreshCompletionNamesIfStale() // 同上
        return true
      },
    },
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...completionKeymap,
  ]),
]

// 补全名称：输入 @ 自动触发 或 Cmd+I 手动触发
interface NameEntry {
  label: string
  detail: string
}
const completionEntries = ref<NameEntry[]>([])
/** 补全名称响应 → 条目表（切书拉取与 TTL 补拉两处消费点单源，原两段
 *  map 逐字重复；detail 是「角色/物品」两分段的界面文案，两处须同形）。 */
function completionEntriesOf(r: { characters: string[]; items: string[] }): NameEntry[] {
  return [
    ...r.characters.map((n) => ({ label: n, detail: '角色' })),
    ...r.items.map((n) => ({ label: n, detail: '物品' })),
  ]
}
function characterCompletion(context: CompletionContext): CompletionResult | null {
  const entries = completionEntries.value
  if (!entries.length) return null

  // @ 触发：光标前有 @ 开头的文本
  // -（全量代码）：CJK 区间 [一-鿿] 是 BMP 硬编码，升
  // \p{Script=Han}/u 全 Han 脚本——扩展平面字（Ext-B「𠀀」等）@ 后可续配；
  // 下方两处 validFor 同款
  const at = context.matchBefore(/@[\p{Script=Han}\w]*/u)
  if (at && at.text.length >= 1) {
    const query = at.text.slice(1)
    const filtered = query ? entries.filter((e) => e.label.includes(query)) : entries
    if (filtered.length) {
      return {
        from: at.from,
        options: filtered.map((e) => ({ label: e.label, type: 'variable', detail: e.detail })),
        validFor: /^@?[\p{Script=Han}\w]*$/u,
      }
    }
  }

  // 显式触发（Cmd+I / Ctrl+Space）：总是弹出全部名称，在光标位置插入
  if (!context.explicit) return null
  return {
    from: context.pos,
    options: entries.map((e) => ({ label: e.label, type: 'variable', detail: e.detail })),
    validFor: /^[\p{Script=Han}\w]*$/u,
  }
}

// 打字机滚动实现收编 editor/typewriter.ts 单源（含 CM6 更新中禁 dispatch 的根因注释与回归测试）
const typewriterConf = new Compartment()
// mode/readonly 用 Compartment 管理，切文档时动态重配（非仅在 mount 时读取）
const modeConf = new Compartment()
const readonlyConf = new Compartment()
// （口径校正）：history 唯一挂载点在此 Compartment——注意 reconfigure
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
        // 单次 toString 复用——emit 值与同文档外部同步判据
        //（lastLocalEmit，见下方 watch）取同一字符串，此前 emit 一次 + watch 里
        // doc.toString 再一次，每击键 2× 全文拷贝（超大单文件可感）
        // 本行是每按键唯一剩余的全文拷贝，且是刻意
        // 留的预算边界——父层那几笔更重的全文面（mergeFm 重拼 / doc.patch / body 计算
        // 属性重切 / 本组件 watch 的全等回比）已改 200ms 尾随节流摊薄
        //（shared/body-writeback.ts 头注：不变量与窗口取舍）。此处不再延迟：emit 载荷
        // 是「已变更 + 当下最新正文」的唯一投递通道，切档瞬间父层已指向新档，晚投的
        // 正文无从按旧档路由（要按档路由须给 emit 契约带 docId，属结构改动，不在本批）。
        // 往此路径再加每次按键的全文转换/拷贝前，先读上述两处注。
        if (u.docChanged) {
          lastLocalEmit = u.state.doc.toString()
          // 程序化全量替换（applyDocSwitch 切文档 / applyExternalReplace 外部
          // 同步，替换事务带下方 programmaticReplace 注解）不回发 emit——回发值经父层
          // onBodyChange 的 mergeFm 规范形往返重组，对非规范 fm 存量文件（fence 尾随
          // 空格/BOM/CRLF，解析侧容忍）merged !== content 即 doc.patch 置脏 → autosave
          // 30s 内作者零输入重写并规范化文件。新值已同步进 lastLocalEmit（上行），watch
          // 的「同文档外部同步判据」语义不变；真实用户输入/undo/redo 事务无
          // 此注解，照常 emit。抑制按事务注解逐笔判定、只压本笔：不用「置布尔位等下次
          // docChanged 消费」的形态——空串→空串切档等空 ChangeSet 事务 docChanged=false，
          // 布尔位消费不到而粘滞，会吞掉其后首次真实键入的回写。
          if (!u.transactions.some((tr) => tr.annotation(programmaticReplace) === true)) {
            // 切文档挂起窗口内不回写——父层 onBodyChange 按当前
            // entry（已切到新章 docId）patch，挂起期间组合续打的旧章文本若照常 emit
            // 会整段写进新章（跨章污染）。挂起窗口的输入只留在本视图，随切文档替换
            // 丢弃（compositionend 消费挂起后 emit 恢复常态）。
            if (pendingDocSwitch === null) emit('update:modelValue', lastLocalEmit)
          }
        }
      }),
      // 组合态标记 + 组合结束后（延迟一拍让 CM6 先冲排组合文本插入）
      // 应用挂起的外部全量替换（挂起只作「有外部变更待应用」的标记，应用时取最新值——）
      EditorView.domEventHandlers({
        compositionstart: () => {
          composing = true
        },
        compositionend: () => {
          composing = false
          // 切文档挂起（pendingDocSwitch）与同文档外部替换挂起
          //（pendingExternal）同在此消费，两槽皆空才短路
          if (pendingExternal === null && pendingDocSwitch === null) return
          if (!view) return
          pendingExternal = null
          // 应用「当下最新 modelValue」而非登记时的快照——组合期每次
          // emit 已把已组文本同步进 store（回写后 v === doc，watch 不再刷新挂起值），
          // 登记快照冻结在旧时点，应用旧值会抹掉快照点之后续打的整段组合文本（且
          // addToHistory=false 不可 undo、回写 store 触发 autosave 落盘）。最新值若与
          // 当前 doc 一致（用户续打已覆盖外部变更，同 dirty 本地优先口径）则不替换。
          setTimeout(() => {
            // 复检组合态——两段组合间隙 <1 帧时，上段 end 排队的
            // 回调会在新组合已开始后才执行，applyExternalReplace 会打断新组合。与下方
            // update 回调（composing || composing 双判）同口径：组合期不应用
            if (!view) return
            const latest = props.modelValue
            // 丢弃分支改保留挂起——原纯 return 后 pendingExternal 已
            // 清空，若新组合期间无新的外部变更（watch 的 v === lastLocalEmit 不触发挂起），
            // 上段组合期到达的外部替换被永久丢弃（refresh/SSE 同步静默失效）。回填
            // pendingExternal = latest 让下一次 compositionend 的既有消费路径再触发
            //（自愈链）；不引入双应用——应用前有 latest === doc 等值检查兜底。
            // pendingDocSwitch 同此口径：新组合期间不清槽，留给下一次 compositionend。
            if (composing || view.composing) {
              pendingExternal = latest
              return
            }
            // 挂起的切文档优先消费——切文档必须走「卸载重挂
            // history + 全量替换」的真重置路径（applyDocSwitch），不能落到下方
            // applyExternalReplace（不重置 undo 栈、选区按同文档归位语义 clamp 也错）。
            // 取当下最新 props（同款）：挂起期间可能又有新值乃至二次切章到达。
            if (pendingDocSwitch !== null) {
              lastHistoryKey = props.historyKey
              applyDocSwitch(props.modelValue)
              return
            }
            if (latest === view.state.doc.toString()) return
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
// 替换避免光标跳，切文档则恒替换（见下方注释）
// addToHistory.of(false) 标记为外部同步，不清空 undo 历史（标题提交后 ⌘Z 仍可回退）
// historyKey（docId）变化 = 切文档——「卸载 → 重挂」两步真重置 undo/redo
// 栈 + 恒派发全量替换事务（内容相同也替换为 v，同步文档内容）。旧版仅 reconfigure + 差异
// 替换：同内容切换时旧 undo 栈完整残留，⌘Z 把旧文档逆编辑回灌进新文档 → dirty → autosave
// 落盘污染；undo 后切换时 redo 栈的边界插入事件亦残留。isolateHistory('full') 只切断新旧
// 事件编组，不承担清栈。
let lastHistoryKey: string | undefined = props.historyKey
// 本视图最近一次 emit 的正文串（与 emit 同源赋值）——同文档外部同步判据，
// 初始化为挂载时 modelValue（首拍外部同值变化不误判为外部变更触发全量替换）
let lastLocalEmit: string | null = props.modelValue
// IME 组合态守卫——外部全量替换（refresh/SSE 同步）落在组合输入中
// 会吞掉正在组合的中文（组合文本被整段替换打断）。组合标记本地维护
// （compositionstart/end 事件对）+ view.composing 双判：CM6 的 composing>0 要等组合期
// 内真实输入事件，只挂 compositionstart（尚无键入）时它仍为 false——本地标记补齐这个
// 窗口。compositionend 后延迟一拍（setTimeout 0）再应用挂起值：CM6 的 MutationObserver
// 在微任务里冲排组合文本插入，先于我们的全量替换才不会把组合文本算进替换 diff。
let composing = false
let pendingExternal: string | null = null
// 切文档挂起槽（对齐同文档分支 pendingExternal 守卫）——组合期
// 切章时立即全量替换会打断 IME 组合丢字，改挂起待 compositionend 消费。登记 {v,key}
// 原子对（props 一次 watch 回调同时到达；historyKey 可选 prop 故 key 含 undefined）；
// 后续触发刷新槽值（取最新同款口径）。
let pendingDocSwitch: { v: string; key: string | undefined } | null = null
// 程序化全量替换事务的标记注解——applyDocSwitch / applyExternalReplace 的
// 替换事务携带，mount 侧 updateListener 见注解即跳过本次回发（动机与其处注释同源）。
// 注解随事务走，天然「只抑制本笔」，无跨事务粘滞面；对空 ChangeSet 事务（docChanged
// =false）本就不产生回发，注解空挂无副作用。
const programmaticReplace = Annotation.define<boolean>()
/** 同文档外部全量替换的执行体（composing 守卫解耦出）。 */
function applyExternalReplace(v: string): void {
  if (!view) return
  // 全区间替换会把光标映射到文末——阅读中间章节的用户被 SSE sync/refresh
  // 拽到底部。替换前记 head，替换后 clamp 归位到原位置（越界→文末）。
  // 原实现只存 main.head 单点——活动选区（anchor≠head）与多光标
  // 在全量替换后坍缩为单光标。改为替换前保存完整 selection.ranges（各 range 的
  // anchor/head + mainIndex），替换后逐点按同款「归位原位置」语义映射
  //（min(pos, v.length) 逐点 clamp 到 [0, v.length]）重建 Selection。不经
  // changes.desc.mapPos：全区间替换下 mapPos 对被替换区间内任意位置一律映射到边界
  //（0 或 v.length），会回归的单光标归位语义；min-clamp 即该语义的逐点推广，
  // 单光标路径与原 Math.min(prevHead, v.length) 完全一致（回归测试钉死），多光标/
  // 非空选区的 ranges 数、anchor/head 方向与主 range 顺序语义保持。
  // 行为化（测试资产）：上述映射实现抽至 ./external-replace.ts
  // 的 mapSelectionForFullReplace（纯函数单源，回归测试直测真实实现）——逐位同式搬移，行为不变。
  const selection = mapSelectionForFullReplace(view.state.selection, v)
  // 同文档外部全量替换（SSE sync/refresh/冲突取服务端版/
  // AI 改写共用路径）此前只挂 addToHistory.of(false) 不清旧栈——撤销方向实测安全
  //（全量替换的 addMapping 把旧插入事件降为 no-op），但 **redo 方向实测回灌**：替换前
  // undo 过一次时，redo 栈的文档边界插入事件不被 addMapping 丢弃（mapPos 边界存活，
  // ⇧⌘Z 把旧编辑重插入新内容——实测 DDD→DDDXYZ，与 applyDocSwitch 头注同型污染）。
  // 按 applyDocSwitch 同款两步真重置：先卸 history 字段（旧值即丢）、下一事务重挂
  //（字段重新 init 栈必空），替换事务保持 addToHistory/false 不占用新栈；isolateHistory
  // 同口径切断替换与后续编辑的编组。的「标题提交后 ⌘Z 仍可回退」不受影响：
  // 提交回写 v === lastLocalEmit 短路不触发本路径，仅内容真实外部变化时才清栈。
  view.dispatch({ effects: historyConf.reconfigure([]) })
  view.dispatch({
    effects: historyConf.reconfigure(history()),
    changes: { from: 0, to: view.state.doc.length, insert: v },
    selection,
    // 替换事务带程序化替换注解不回发——SSE sync/refresh 落在非规范 fm
    // 存量文件时，回发经父层 mergeFm 往返即「无输入置脏」（见 updateListener 处注释）
    annotations: [Transaction.addToHistory.of(false), isolateHistory.of('full'), programmaticReplace.of(true)],
  })
}
/** 切文档执行体（抽出：组合期挂起后由 compositionend 消费同一路径）。
 * 两步真重置历史——reconfigure(history()) 对已存在 historyField 携带旧值不重建
 *  （CM6 reconfigure 语义），实测两条残留路径：同内容切换无替换事务时旧 undo 栈整体
 *  残留；切换前 undo 过一次时，redo 栈的文档边界插入事件不被全量替换的 addMapping 丢弃
 *  （mapPos 边界存活，redo 仍可回灌）。故先卸载 history 扩展（字段随 compartment 移除、
 *  旧值即丢弃），下一事务重挂——字段重新 init，栈必然为空；第二步恒派发全量替换
 *  （同文亦替换，内容同步 + 二次保险），注解保持原口径。 */
function applyDocSwitch(v: string): void {
  pendingDocSwitch = null // 实际应用即清挂起槽（幂等：防消费回调与 watch 触发双应用）
  if (!view) return
  view.dispatch({ effects: historyConf.reconfigure([]) })
  view.dispatch({
    effects: historyConf.reconfigure(history()),
    changes: { from: 0, to: view.state.doc.length, insert: v },
    // 切文档后光标锚定章首——全区间替换不显式给 selection 时，
    // 旧光标被 mapPos 到替换区间边界（旧章末位置 → 新章末注释同源语义），
    // 切章后光标落章末。对齐同文档路径的选区处理口径（applyExternalReplace 的
    // 归位/保留）；切文档内容整体换血、旧位置无可归位，章首即自然
    // 阅读起点。
    selection: EditorSelection.cursor(0),
    // 切文档替换事务同带程序化替换注解不回发——切档回发值经父层
    // mergeFm 往返，对非规范 fm 新章「零输入即置脏」（autosave 静默改写）；新章
    // 内容本就来自 store，回发纯冗余。两步真重置历史与
    // 章首锚定语义不受影响（注解只作用于回发抑制）。
    annotations: [Transaction.addToHistory.of(false), isolateHistory.of('full'), programmaticReplace.of(true)],
  })
}
watch([() => props.modelValue, () => props.historyKey], ([v, key]) => {
  if (!view) return
  const docSwitch = key !== lastHistoryKey
  const prevKey = lastHistoryKey
  lastHistoryKey = key
  if (!docSwitch) {
    // 同文档外部同步：仅差异时替换，避免光标跳（此分支不得恒替换）
    // 判据改 lastLocalEmit（本视图最近一次 emit 的同一字符串）——本视图
    // emit 引起的变化 v 恒等于 lastLocalEmit（免 doc.toString 全文拷贝）；外部
    // 变化（SSE/refresh/store patch）v 是新串 → 走替换。doc 与 lastLocalEmit 的
    // 不变式由两条更新路径共同维持（本视图 emit / applyExternalReplace 后的
    // update 监听都会刷新 lastLocalEmit）
    if (v !== lastLocalEmit) {
      // 组合输入中不立即替换——挂起到 compositionend 后
      //（挂起登记仅标记「有待应用的外部变更」，应用时取当下最新 modelValue）
      if (view.composing || composing) {
        pendingExternal = v
        return
      }
      applyExternalReplace(v)
    }
    return
  }
  // 组合期切章挂起（对齐上方同文档分支的 composing 守卫）——
  // 不立即派发替换（打断 IME 组合丢字），登记挂起待 compositionend 消费；
  // lastHistoryKey 回退旧 key：挂起未生效，后续触发仍按切文档判据刷新挂起值。
  // 挂起窗口内本视图的输入 emit 已抑制（见 mount 侧 updateListener）——父层 entry
  // 已指向新章，照常回写会把旧章文本整段写进新章（跨章污染）。
  if (view.composing || composing) {
    pendingDocSwitch = { v, key }
    lastHistoryKey = prevKey
    return
  }
  applyDocSwitch(v)
})

// 补全名称列表（从设定 API 加载：角色名 + 物品名；@ / Cmd+I 触发用）
// 请求序号防竞态（快速切书时旧请求晚于新请求 resolve 不覆盖）
const ws = useWorkspaceStore()
// 请求代守卫收敛 useStaleGuard 单源（原裸计数器 compReqId）。两处发起
// （切书 watch / TTL 补拉）本就共用同一计数——任一发起即作废另一侧在途请求——故仍只建
// 这一个实例；判定时机逐位不变（await 后先查代再落态）。
const compReqGen = useStaleGuard()
watch(
  () => ws.bookName,
  async (name) => {
    if (!name || props.readonly) {
      completionEntries.value = []
      return
    }
    const myId = compReqGen.begin()
    try {
      const r = await getCompletionNames(name)
      if (compReqGen.stale(myId)) return // 旧请求，丢弃
      completionFetchedAt = Date.now() // -④：TTL 基点（成功才计龄，失败下次触发即重试）
      completionEntries.value = completionEntriesOf(r)
    } catch {
      // 失败清空（若本请求仍是最新）——原 catch 静默吞掉后
      // completionEntries 残留上一本书的名单：A 书成功拉过 → 切 B 书恰逢请求失败
      //（服务瞬时异常窗），B 书编辑器 @ 弹 A 书角色/物品名，且 completionFetchedAt
      // 只在成功路径计龄，TTL 补拉闸使陈旧窗最长 5 分钟。名单按书作用域（readonly/
      // falsy 分支同样清空），失败清空同口径——空优于错书；下次 @ 触发即重试
      //（completionFetchedAt 未计龄，-④ 语义不变）。
      if (compReqGen.fresh(myId)) completionEntries.value = []
    }
  },
  { immediate: true },
)

// （-④）：名单 TTL 刷新——原仅切书拉取，同会话里新建角色/物品后 @ 补全
// 一直陈旧到下次切书。@ 击键 / Cmd+I 触发时超龄（5min）即后台补拉一次：竞态仍走
// 切书同一代的守卫（compReqGen——任一发起作废另一侧在途，旧请求晚归丢弃）、单飞标志
// 防触发风暴。刷新结果对「当次已弹浮层」不生效（CM6 浮层选项在 source 调用瞬间定格，
// 续打只按 validFor 过滤）——下一次触发即见新名单，陈旧窗口从「会话级」缩到 TTL 级。
const COMPLETION_TTL_MS = 5 * 60_000
let completionFetchedAt = 0
let completionTtlInflight = false
function refreshCompletionNamesIfStale(): void {
  const book = ws.bookName
  if (!book || props.readonly) return
  if (completionTtlInflight || Date.now() - completionFetchedAt < COMPLETION_TTL_MS) return
  completionTtlInflight = true
  const myId = compReqGen.begin()
  getCompletionNames(book)
    .then((r) => {
      if (compReqGen.stale(myId)) return
      completionFetchedAt = Date.now()
      completionEntries.value = completionEntriesOf(r)
    })
    .catch(() => {}) // 设定 API 不可达：保持现名单（陈旧优于清空）
    .finally(() => {
      completionTtlInflight = false
    })
}

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
/** 是否有非空选区（右键菜单判断剪切/复制启用） */
function hasSelection(): boolean {
  if (!view) return false
  const sel = view.state.selection.main
  return sel.from !== sel.to
}
/** 取当前光标偏移（编辑器正文坐标；阶段 24 章节拆分经 EditorView → workspace 透传。
 *  无视图（未挂载/已卸载）→ null。 */
function getCursorOffset(): number | null {
  if (!view) return null
  return view.state.selection.main.head
}
/** 剪切：复制选区到剪贴板并删除 */
async function clipboardCut(): Promise<void> {
  if (!view) return
  const sel = view.state.selection.main
  if (sel.from === sel.to) return
  const doc = view.state.doc
  try {
    await navigator.clipboard.writeText(view.state.sliceDoc(sel.from, sel.to))
  } catch {
    // 写失败即止并 return——旧实现 catch 后仍无条件 dispatch 删除
    // 选区，「文档删了、剪贴板没有」，用户信 toast 则文字两处皆无（对齐 copy/paste 失败即止）
    useUiStore().toast('剪贴板权限被拒绝，剪切未生效', 'error') /* 不再静默 */
    return
  }
  // await 剪贴板授权窗内选区/文档可能已变（打字、点选、切文档）——
  // 陈旧区间直接 dispatch 会删错文本。复检同文档同区间才落删除（对齐 paste 侧 await 后
  // 重读选区的防护口径）；已变则中止（剪贴板已有原文，文档零改动）。
  const cur = view.state.selection.main
  if (view.state.doc !== doc || cur.from !== sel.from || cur.to !== sel.to) return
  view.dispatch({ changes: { from: sel.from, to: sel.to, insert: '' } })
  view.focus()
}
/** 复制：复制选区到剪贴板 */
async function clipboardCopy(): Promise<void> {
  if (!view) return
  const sel = view.state.selection.main
  if (sel.from === sel.to) return
  try {
    await navigator.clipboard.writeText(view.state.sliceDoc(sel.from, sel.to))
  } catch {
    useUiStore().toast('剪贴板权限被拒绝，复制未生效', 'error') /* 不再静默 */
  }
  view.focus()
}
/** 粘贴：从剪贴板读取并替换选区 */
async function clipboardPaste(): Promise<void> {
  if (!view) return
  try {
    const text = await navigator.clipboard.readText()
    const sel = view.state.selection.main
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
      scrollIntoView: true,
    })
  } catch {
    useUiStore().toast('剪贴板权限被拒绝，粘贴未生效', 'error') /* 不再静默 */
  }
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
// getSelectionRect 移除——浮动工具栏方案未落地，全库零消费方
//（迁移残留死导出，eslint 存量 warn 关联项随触碰顺清）；落地时按本批 git 史取回。
// 显式标注暴露面（类型单源见上方 CmHostHandle）——漏暴露/签名不符即编译期报错。
defineExpose<CmHostHandle>({
  insertText,
  getSelection,
  hasSelection,
  getCursorOffset,
  clipboardCut,
  clipboardCopy,
  clipboardPaste,
  selectAll,
  undoAction,
  redoAction,
  openSearch,
})

// 销毁后置 null——compositionend 已排定的 setTimeout 与挂起的
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
/* 编辑器滚动条：比全局更细（6px → 近 Obsidian 极简风）；与全局口径对齐——半透明胶囊 */
.cm-host :deep(.cm-scroller)::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
.cm-host :deep(.cm-scroller)::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--text-faint) 40%, transparent);
  border-radius: 999px;
}
.cm-host :deep(.cm-scroller)::-webkit-scrollbar-thumb:hover {
  background-color: color-mix(in srgb, var(--text-faint) 75%, transparent);
}
</style>
