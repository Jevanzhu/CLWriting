// @vitest-environment happy-dom
/**
 * PM-9（性能与内存专项 2026-09-05）回归：左栏右缘 4px 热区 mousemove 不再每事件
 * getBoundingClientRect() 强制同步布局（144Hz 鼠标 ≈ 144 次 reflow/秒）。
 *
 * 修复语义（WorkspaceShell.vue）：
 * - rect 缓存：首次 mousemove 惰性读一次；window resize、scroll（capture，接住
 *   .ws-view 等不冒泡的后代滚动容器）、mouseenter 重进、拖拽结束 onUp 失效重读；
 * - 光标写入经 rAF 同帧合并取最后一次，值不变不写；交互/视觉逐位不变；
 * - 卸载成对移除 resize/scroll 监听并取消挂起 rAF。
 *
 * 测法：shallow 挂 WorkspaceShell（沿用 R27-77 测试基建），spy .ws-left 的
 * getBoundingClientRect 计数；rAF 用受控 stub 手动 flush，断言合并与清理。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import WorkspaceShell from '../../../src/studio/web-next/src/components/shell/WorkspaceShell.vue'

// .ws-left 固定假 rect：right=240 → 右缘 4px 热区 = clientX >= 236
const RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 240,
  bottom: 600,
  width: 240,
  height: 600,
  toJSON: () => ({}),
} as unknown as DOMRect

let rectReads = 0
// 受控 rAF：不入浏览器帧循环，测试手动 flush
let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = []
let rafSeq = 0

function flushRaf(): void {
  const pending = rafQueue
  rafQueue = []
  for (const { cb } of pending) cb(16)
}

function stubRaf(): void {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    rafSeq += 1
    rafQueue.push({ id: rafSeq, cb })
    return rafSeq
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    rafQueue = rafQueue.filter((entry) => entry.id !== id)
  })
}

/** 挂外壳并 spy .ws-left 的布局读取（shallow：子件 stub 不影响外壳自身模板/监听；
 *  attachTo 正文：scroll capture 语义需元素在 document 树内，事件路径才经过 window） */
function mountShell(): { w: VueWrapper; left: ReturnType<VueWrapper['find']> } {
  const w = mount(WorkspaceShell, { props: { bookName: '书甲' }, shallow: true, attachTo: document.body })
  const left = w.find('.ws-left')
  vi.spyOn(left.element, 'getBoundingClientRect').mockImplementation(() => {
    rectReads += 1
    return RECT
  })
  return { w, left }
}

function cursorOf(left: ReturnType<VueWrapper['find']>): string {
  return (left.element as HTMLElement).style.cursor
}

beforeEach(() => {
  setActivePinia(createPinia())
  rectReads = 0
  rafQueue = []
  rafSeq = 0
  stubRaf()
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = '' // attachTo 残余兜底清理
})

describe('PM-9: 左栏热区 mousemove 布局缓存', () => {
  it('连续 mousemove 只读一次 rect（不再每事件强制布局），近右缘 4px 切 col-resize', async () => {
    const { w, left } = mountShell()

    await left.trigger('mousemove', { clientX: 100 })
    await left.trigger('mousemove', { clientX: 150 })
    expect(rectReads).toBe(1) // 缓存命中：仍只读一次
    expect(cursorOf(left)).toBe('') // rAF 未 flush，但值未变本就不写

    await left.trigger('mousemove', { clientX: 238 }) // 240-4=236 → 命中热区
    expect(rectReads).toBe(1)
    flushRaf()
    expect(cursorOf(left)).toBe('col-resize')

    await left.trigger('mousemove', { clientX: 50 }) // 离开热区
    flushRaf()
    expect(cursorOf(left)).toBe('')
    expect(rectReads).toBe(1) // 全程未重读布局
    w.unmount()
  })

  it('resize / 后代 scroll（capture 接住不冒泡事件）/ mouseenter 失效缓存后重读', async () => {
    const { w, left } = mountShell()

    await left.trigger('mousemove', { clientX: 100 })
    expect(rectReads).toBe(1)

    window.dispatchEvent(new Event('resize'))
    await left.trigger('mousemove', { clientX: 100 })
    expect(rectReads).toBe(2)

    // scroll 不冒泡：在后代元素上派发非冒泡事件，window 只有 capture 监听接得住
    w.find('.ws-view').element.dispatchEvent(new Event('scroll'))
    await left.trigger('mousemove', { clientX: 100 })
    expect(rectReads).toBe(3)

    await left.trigger('mouseenter') // 重进即失效（覆盖宽度过渡场景）
    await left.trigger('mousemove', { clientX: 100 })
    expect(rectReads).toBe(4)
    w.unmount()
  })

  it('rAF 同帧合并取最后一次；值不变不排新帧', async () => {
    const { w, left } = mountShell()

    await left.trigger('mousemove', { clientX: 238 }) // 'col-resize'（同帧）
    await left.trigger('mousemove', { clientX: 100 }) // 改回 ''——合并取代前者
    expect(rafQueue).toHaveLength(1) // 同帧只挂一个回调
    flushRaf()
    expect(cursorOf(left)).toBe('') // 最后一次判定生效

    await left.trigger('mousemove', { clientX: 101 }) // 值不变 → 不写不排帧
    expect(rafQueue).toHaveLength(0)
    w.unmount()
  })

  it('卸载清理：成对移除 window resize/scroll 监听，挂起 rAF 取消', async () => {
    const { w, left } = mountShell()

    await left.trigger('mousemove', { clientX: 238 })
    expect(rafQueue).toHaveLength(1) // 有挂起回调

    const rmSpy = vi.spyOn(window, 'removeEventListener')
    w.unmount()
    const removed = rmSpy.mock.calls.map((call) => String(call[0]))
    expect(removed).toContain('resize')
    expect(removed).toContain('scroll')
    expect(rafQueue).toHaveLength(0) // 挂起 rAF 已在卸载时取消

    // 卸载后 Vue 监听已摘除：再派发 mousemove 不复活处理器、不重读布局
    const readsBefore = rectReads
    left.element.dispatchEvent(new MouseEvent('mousemove', { clientX: 238 }))
    expect(rectReads).toBe(readsBefore)
    flushRaf() // 队列已空，兜底 flush 无害
  })
})
