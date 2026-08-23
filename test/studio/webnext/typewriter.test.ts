// @vitest-environment happy-dom
/**
 * 打字机模式（editor/typewriter.ts）回归：
 * 根因背景——首版在 updateListener 内直接 view.dispatch，违反 CM6「更新进行中禁
 * dispatch」，异常被 CM 的 listener try/catch 吞成 console.error，打字机静默失效。
 * 用真实 EditorView（happy-dom 可构造，vitest 别名钉 @codemirror/* 到 web-next 嵌套
 * node_modules）锁死「推迟到微任务后 dispatch」的行为契约。
 */
import { describe, it, expect, vi } from 'vitest'
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
