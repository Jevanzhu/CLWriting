/**
 * 打字机模式扩展（专注模式启用）：输入后保持当前行垂直居中 + 上下文按行距渐隐。
 *
 * 渐隐（焦点形态参照 iA Writer Focus Mode / Typora / Obsidian typewriter-mode）：
 * 活动行 ±KEEP_FULL 行保持全亮，之外按行距分带渐降不透明度（CSS transition 平滑
 * 过渡）。亮窗跟随选区——点击/方向键移动即随行。与「滚动居中」并存：输入时当前行
 * 始终居中并随内容滚动。
 *
 * B-25（第六十轮）注释如实化：本仓 @codemirror/view 6.43.x 的 updateListeners 在
 * updateState 回到 Idle 之后才调用（dist 实读），listener 内直接 dispatch 并不抛
 * "update in progress"——首版静默失效归因于此系误记。微任务推迟保留为防御性写法
 * （对更早/未来版本语义安全），且取当下光标不映射旧位置的语义不变。
 */
import { EditorView, ViewPlugin, Decoration } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import type { Extension } from '@codemirror/state'

/** 渐隐调参（集中于此便于按手感调整）：±KEEP_FULL 行全亮，之后逐带渐降，地板 FADE_FLOOR。 */
const KEEP_FULL = 2
const FADE_FLOOR = 0.16
/** 分带表：行距 ≤maxDist 落入该带；带宽 2 行 + transition 视觉上即连续渐隐 */
const FADE_BANDS: readonly { maxDist: number; cls: string; opacity: number }[] = [
  { maxDist: 4, cls: 'tw-fade-1', opacity: 0.72 },
  { maxDist: 6, cls: 'tw-fade-2', opacity: 0.5 },
  { maxDist: 9, cls: 'tw-fade-3', opacity: 0.32 },
  { maxDist: Number.POSITIVE_INFINITY, cls: 'tw-fade-4', opacity: FADE_FLOOR },
]
/**
 * 浏览态判定（渐隐只在「正在写」时存在，回看不吃灰）：
 * - 进专注未输入 → 全亮起步；任何输入 → 渐隐亮窗
 * - 输入停 IDLE_MS（思考停顿不误触发，取宽）或滚轮回看 → 全亮
 * 实现为插件内部状态：浏览态 = 不产出任何渐隐装饰（而非根类压样式——CM6 初始
 * setState 阶段会整体重写 view.dom.className，构造期挂的根类会被冲掉）。
 * wheel/idle 在事务外改态后派发空事务驱动 update() 重建装饰。
 */
const BROWSE_IDLE_MS = 8000

function fadeBand(dist: number): string | null {
  if (dist <= KEEP_FULL) return null
  for (const b of FADE_BANDS) if (dist <= b.maxDist) return b.cls
  return FADE_BANDS[FADE_BANDS.length - 1]!.cls
}

/** 亮窗外的视口行按带打 line 装饰类（只覆盖视口——虚拟渲染下行不在 DOM 即无需类）。 */
function fadeDeco(view: EditorView): DecorationSet {
  const active = view.state.doc.lineAt(view.state.selection.main.head).number
  const b = new RangeSetBuilder<Decoration>()
  let pos = view.viewport.from
  while (pos <= view.viewport.to) {
    const line = view.state.doc.lineAt(pos)
    const cls = fadeBand(Math.abs(line.number - active))
    if (cls) b.add(line.from, line.from, Decoration.line({ class: cls }))
    pos = line.to + 1
  }
  return b.finish()
}

const fadePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    /** 浏览态（全亮）：true 时不产出渐隐装饰。起步即浏览（阅读位），输入转写作位。 */
    private browsing = true
    /** 装饰集对应的浏览态：态翻转而无 doc/selection/viewport 变化时（空事务）驱动重建 */
    private decoratedBrowsing = true
    private idleTimer: ReturnType<typeof setTimeout> | null = null
    private readonly onWheel: () => void
    private readonly view: EditorView
    constructor(view: EditorView) {
      this.view = view
      this.decorations = Decoration.none // 进专注未输入：全亮起步（阅读位）
      this.onWheel = () => this.setBrowse(true)
      view.scrollDOM.addEventListener('wheel', this.onWheel, { passive: true })
      this.scheduleIdle()
    }
    update(u: ViewUpdate) {
      if (u.docChanged) {
        this.browsing = false // 输入 → 渐隐亮窗回来
        this.scheduleIdle()
      }
      // 重建而非映射：分带只依赖「行号差」，任何变化后重算最简且视口行数有限；
      // 浏览态翻转走空事务（flags 全 false），以态不一致驱动重建
      if (u.docChanged || u.selectionSet || u.viewportChanged || this.browsing !== this.decoratedBrowsing) {
        this.decorations = this.browsing ? Decoration.none : fadeDeco(u.view)
        this.decoratedBrowsing = this.browsing
      }
    }
    /** 切浏览态：事件/定时器上下文（事务外）派发空事务合法，update() 里统一重建 */
    private setBrowse(on: boolean): void {
      if (this.browsing === on) return
      this.browsing = on
      this.view.dispatch({})
    }
    /** 输入停 IDLE_MS 后进入浏览态（全亮）；每次输入重排 */
    private scheduleIdle(): void {
      if (this.idleTimer) clearTimeout(this.idleTimer)
      this.idleTimer = setTimeout(() => this.setBrowse(true), BROWSE_IDLE_MS)
    }
    destroy(): void {
      if (this.idleTimer) clearTimeout(this.idleTimer)
      this.view.scrollDOM.removeEventListener('wheel', this.onWheel)
    }
  },
  { decorations: (v) => v.decorations },
)

// 选择器带 .cm-editor 升特异性（三联类 vs 其他主题的二联类）：CM6 主题 StyleModule
// 的挂载顺序不可依赖（实测可与组件层主题倒序），余量曾被 CmHost 主题的 `padding: 0`
// 简写按序覆盖致文末永不居中——特异性保证与顺序无关。
// 上下各 50vh：首行/末行也有滚动余量可被 y:center 真正居中——无上方余量时 scrollTop
// 钳 0，首行只能贴顶（编辑已有文档从第一行写起的关键）
const fadeTheme = EditorView.theme({
  '&.cm-editor .cm-content': { paddingTop: '50vh', paddingBottom: '50vh' },
  '&.cm-editor .cm-line': { transition: 'opacity 0.25s ease' },
  '&.cm-editor .tw-fade-1': { opacity: '0.72' },
  '&.cm-editor .tw-fade-2': { opacity: '0.5' },
  '&.cm-editor .tw-fade-3': { opacity: '0.32' },
  '&.cm-editor .tw-fade-4': { opacity: String(FADE_FLOOR) },
})

export function typewriterExt(on: boolean): Extension[] {
  if (!on) return []
  return [
    EditorView.updateListener.of((u) => {
      if (!u.docChanged) return
      Promise.resolve().then(() => {
        const v = u.view
        // 视图若已销毁：CM6 update() 对 destroyed 视图提前 return（只更新 state 不碰
        // DOM、不抛错），无需 destroyed 守卫（该字段类型私有，运行时公有）
        const head = v.state.selection.main.head
        v.dispatch({ effects: EditorView.scrollIntoView(head, { y: 'center' }) })
      })
    }),
    fadePlugin,
    fadeTheme,
  ]
}

/** 开启打字机时立即把当前行居中（模式切换瞬间对齐）。仅在更新外调用——合法 dispatch。 */
export function centerCursorLine(view: EditorView): void {
  const head = view.state.selection.main.head
  view.dispatch({ effects: EditorView.scrollIntoView(head, { y: 'center' }) })
}