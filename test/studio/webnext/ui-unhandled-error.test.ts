/**
 * 杂项①回归：全局兜底错误上报（ui.reportUnhandledError，main.ts errorHandler 调用）。
 *
 * 原先 main.ts 的 Vue errorHandler 只 console.error——渲染进程异常对作者完全静默。
 * 修复后经既有 toast 通道冒泡（console.error 留痕保留）。覆盖：Error/非 Error、
 * 兜底通道自身异常不向外抛。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ui store · reportUnhandledError（全局错误冒泡）', () => {
  it('Error 实例 → console.error 留痕 + error 级 toast 带错误消息', () => {
    const ui = useUiStore()
    ui.reportUnhandledError(new Error('渲染崩了'), 'setup')
    expect(console.error).toHaveBeenCalledTimes(1)
    expect(ui.toasts).toHaveLength(1)
    expect(ui.toasts[0]!.kind).toBe('error')
    expect(ui.toasts[0]!.msg).toContain('渲染崩了')
  })

  it('非 Error 抛出值（字符串等）→ 不抛异常，toast 带字符串化消息', () => {
    const ui = useUiStore()
    expect(() => ui.reportUnhandledError('裸字符串错误')).not.toThrow()
    expect(ui.toasts[0]!.msg).toContain('裸字符串错误')
  })

  it('toast 通道自身异常 → 兜底路径不得再抛（errorHandler 内二次异常会被 Vue 吞）', () => {
    const ui = useUiStore()
    ui.toasts.push = () => {
      throw new Error('toast 通道坏了')
    }
    expect(() => ui.reportUnhandledError(new Error('x'))).not.toThrow()
    expect(console.error).toHaveBeenCalledTimes(1) // console 留痕仍执行
  })
})
