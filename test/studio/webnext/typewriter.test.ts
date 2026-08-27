// @vitest-environment happy-dom
/**
 * 打字机模式（editor/typewriter.ts）回归：
 * 根因背景——首版在 updateListener 内直接 view.dispatch，违反 CM6「更新进行中禁
 * dispatch」，异常被 CM 的 listener try/catch 吞成 console.error，打字机静默失效。
 * 用真实 EditorView（happy-dom 可构造，vitest 别名钉 @codemirror/* 到 web-next 嵌套
 * node_modules）锁死「推迟到微任务后 dispatch」的行为契约。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { EditorView } from '@codemirror/view'
import { typewriterExt, centerCursorLine } from '../../../src/studio/web-next/src/editor/typewriter'

function makeView(on: boolean): EditorView {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return new EditorView({ doc: '第一行\n第二行', parent: el, extensions: [typewriterExt(on)] })
}

describe('typewriterExt：推迟 dispatch 契约', () => {
  it('docChanged 后微任务才追加滚动 dispatch（不在更新中），且无吞异常日志', async () => {
    const view = makeView(true)
    const dispatchSpy = vi.spyOn(view, 'dispatch')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      view.dispatch({ changes: { from: 7, to: 7, insert: '字' }, selection: { anchor: 8 } })
      // 同步阶段：只有本次事务本身——打字机的滚动尚未发生（旧版此处在 listener 内
      // dispatch 抛错被 CM 吞成 console.error，滚动永远不发生）
      expect(dispatchSpy).toHaveBeenCalledTimes(1)
      await Promise.resolve() // 微任务刷新：推迟的滚动 dispatch 落地
      expect(dispatchSpy).toHaveBeenCalledTimes(2)
      const spec = dispatchSpy.mock.calls[1]![0] as { effects?: { value?: { y?: string } } }
      expect(spec.effects?.value?.y).toBe('center')
      expect(errSpy).not.toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
      view.destroy()
    }
  })

  it('纯选区移动（docChanged=false）不触发滚动', async () => {
    const view = makeView(true)
    const dispatchSpy = vi.spyOn(view, 'dispatch')
    view.dispatch({ selection: { anchor: 0 } })
    await Promise.resolve()
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    view.destroy()
  })

  it('更新后视图即销毁：微任务安全跳过不抛', async () => {
    const view = makeView(true)
    view.dispatch({ changes: { from: 0, to: 0, insert: 'x' }, selection: { anchor: 1 } })
    view.destroy()
    await expect(Promise.resolve()).resolves.toBeUndefined()
  })

  it('关闭态（on=false）返回空扩展：docChanged 不追加 dispatch', async () => {
    const view = makeView(false)
    const dispatchSpy = vi.spyOn(view, 'dispatch')
    view.dispatch({ changes: { from: 7, to: 7, insert: '字' }, selection: { anchor: 8 } })
    await Promise.resolve()
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    view.destroy()
  })

  it('centerCursorLine：同步 dispatch 一次居中滚动（供模式开启瞬间对齐）', () => {
    const view = makeView(true)
    const dispatchSpy = vi.spyOn(view, 'dispatch')
    centerCursorLine(view)
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    const spec = dispatchSpy.mock.calls[0]![0] as { effects?: { value?: { y?: string } } }
    expect(spec.effects?.value?.y).toBe('center')
    view.destroy()
  })
})

describe('typewriterExt：焦点渐隐（分带 line 装饰）', () => {
  function makeLongView(on: boolean, lines: number): EditorView {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const doc = Array.from({ length: lines }, (_, i) => `第${i + 1}行`).join('\n')
    return new EditorView({ doc, parent: el, extensions: [typewriterExt(on)] })
  }
  /** 第 n 行（1 基）的 class 串 */
  function lineClass(view: EditorView, n: number): string {
    const lines = view.dom.querySelectorAll('.cm-line')
    return (lines[n - 1] as HTMLElement).className
  }
  /** 模拟一次输入（docChanged）：退出浏览态进入渐隐（打字机语义：渐隐只在写作位） */
  function typeAt(view: EditorView, line: number): void {
    const pos = view.state.doc.line(line).from
    view.dispatch({ changes: { from: pos, insert: '字' }, selection: { anchor: pos + 1 } })
  }

  it('亮窗 ±2 行全亮，之外按行距分带：fade-1(3~4) / fade-2(5~6) / fade-3(7~9) / fade-4(≥10)', () => {
    const view = makeLongView(true, 22)
    try {
      typeAt(view, 8)
      // happy-dom 无布局度量 → viewport 覆盖全文，22 行全渲染可逐行断言
      expect(view.dom.querySelectorAll('.cm-line')).toHaveLength(22)
      // 亮窗：活动行 ±2（6/8/10）无渐隐类
      for (const n of [6, 7, 8, 9, 10]) expect(lineClass(view, n)).not.toMatch(/tw-fade/)
      // 分带（以 8 为中心）：d=3~4 → fade-1；d=5~6 → fade-2；d=7~9 → fade-3；d≥10 → fade-4
      expect(lineClass(view, 5)).toContain('tw-fade-1')
      expect(lineClass(view, 12)).toContain('tw-fade-1')
      expect(lineClass(view, 3)).toContain('tw-fade-2')
      expect(lineClass(view, 14)).toContain('tw-fade-2')
      expect(lineClass(view, 1)).toContain('tw-fade-3') // d=7
      expect(lineClass(view, 17)).toContain('tw-fade-3') // d=9
      expect(lineClass(view, 18)).toContain('tw-fade-4') // d=10
      expect(lineClass(view, 22)).toContain('tw-fade-4') // d=14
    } finally {
      view.destroy()
    }
  })

  it('亮窗跟随选区：移动后原渐隐行转全亮、原全亮行落带', () => {
    const view = makeLongView(true, 22)
    try {
      typeAt(view, 8)
      expect(lineClass(view, 22)).toContain('tw-fade-4')
      // 光标移到第 20 行：22 行（d=2）转全亮，第 8 行（d=12）落到 fade-4
      view.dispatch({ selection: { anchor: view.state.doc.line(20).from } })
      expect(lineClass(view, 22)).not.toMatch(/tw-fade/)
      expect(lineClass(view, 8)).toContain('tw-fade-4')
    } finally {
      view.destroy()
    }
  })

  it('关闭态（on=false）无任何渐隐类', () => {
    const view = makeLongView(false, 22)
    try {
      typeAt(view, 8)
      expect(view.dom.querySelectorAll('.cm-line.tw-fade-1, .cm-line.tw-fade-2, .cm-line.tw-fade-3, .cm-line.tw-fade-4')).toHaveLength(0)
    } finally {
      view.destroy()
    }
  })
})

describe('typewriterExt：浏览态全亮（渐隐只在写作位）', () => {
  function makeLongView(on: boolean, lines: number): EditorView {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const doc = Array.from({ length: lines }, (_, i) => `第${i + 1}行`).join('\n')
    return new EditorView({ doc, parent: el, extensions: [typewriterExt(on)] })
  }
  /** 全文中的渐隐行数（浏览态 = 0，全亮） */
  function fadeCount(view: EditorView): number {
    return view.dom.querySelectorAll('.cm-line.tw-fade-1, .cm-line.tw-fade-2, .cm-line.tw-fade-3, .cm-line.tw-fade-4').length
  }
  function typeAt(view: EditorView, line: number): void {
    const pos = view.state.doc.line(line).from
    view.dispatch({ changes: { from: pos, insert: '字' }, selection: { anchor: pos + 1 } })
  }

  // 本组全用假时钟：idle 定时器（8s）不落地真实等待；afterEach 还原
  afterEach(() => {
    vi.useRealTimers()
  })

  it('生命周期：起步全亮 → 输入即渐隐 → 停 8s 回全亮', () => {
    vi.useFakeTimers()
    const view = makeLongView(true, 22)
    try {
      // 进专注未输入：阅读位起步全亮（无任何渐隐装饰）
      expect(fadeCount(view)).toBe(0)
      // 任何输入：渐隐亮窗回来（22 行视口内活动行 8 ±2 外渐隐）
      typeAt(view, 8)
      expect(fadeCount(view)).toBeGreaterThan(0)
      // 输入停 BROWSE_IDLE_MS（8s，思考停顿取宽不误触发）→ 浏览态全亮
      vi.advanceTimersByTime(7999)
      expect(fadeCount(view)).toBeGreaterThan(0)
      vi.advanceTimersByTime(1)
      expect(fadeCount(view)).toBe(0)
    } finally {
      view.destroy()
    }
  })

  it('滚轮回看：输入后 wheel 立即全亮，再输入回到渐隐', () => {
    vi.useFakeTimers()
    const view = makeLongView(true, 22)
    try {
      typeAt(view, 8)
      expect(fadeCount(view)).toBeGreaterThan(0)
      // 滚轮回看不等 idle 计时——立即全亮
      view.scrollDOM.dispatchEvent(new Event('wheel'))
      expect(fadeCount(view)).toBe(0)
      // 回到写作：渐隐亮窗
      typeAt(view, 8)
      expect(fadeCount(view)).toBeGreaterThan(0)
    } finally {
      view.destroy()
    }
  })

  it('destroy 清理：wheel 监听移除 + idle 定时器取消（推进时钟无副作用）', () => {
    vi.useFakeTimers()
    const view = makeLongView(true, 22)
    const rmSpy = vi.spyOn(view.scrollDOM, 'removeEventListener')
    view.destroy()
    // wheel 监听已摘（CM6 自身滚动监听也在列，只断言 wheel 项在场）
    const wheelCalls = rmSpy.mock.calls.filter(([type]) => type === 'wheel')
    expect(wheelCalls.length).toBeGreaterThan(0)
    expect(wheelCalls[0]![1]).toBeTypeOf('function')
    // idle 定时器已清：销毁后推进不抛（防泄漏句柄在后续 tick 里摸已销毁 DOM）
    expect(() => vi.advanceTimersByTime(9000)).not.toThrow()
    vi.useRealTimers()
  })
})
