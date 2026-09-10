// @vitest-environment happy-dom
/**
 * 重评-P3-15（2026-09-09 全量代码重评）：书卡光晕 layout thrashing 回归。
 *
 * 原 onCardMove 每 mousemove 读 getBoundingClientRect + 写 CSS 变量 = 强制同步 reflow
 * （PM-9 同族）。修后套 WorkspaceShell PM-9 先例：rect 惰性缓存（同元素只读一次，
 * resize/scroll 失效）+ rAF 同帧合并只写最后一次位置。本文件锚定：同帧多次 move 只
 * 一次写（fake rAF）、rect 缓存不重复读、写入值取帧内最后一次坐标、换卡各写各的。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import BookCard from '../../../src/studio/web-next/src/components/ui/BookCard.vue'
import { onCardMove } from '../../../src/studio/web-next/src/composables/useShelf'
import type { BookEntry } from '../../../src/studio/web-next/src/api/shelf'

const BOOK: BookEntry = {
  name: '书A',
  title: '书A',
  kind: 'long',
  chapters: 1,
  words: 1000,
  lastEdited: '2026-09-01T00:00:00Z',
}

/** fake rAF：手动排队 + 手动 flush（真实 rAF 定时器会让「帧内零写」断言竞态） */
let rafQueue: FrameRequestCallback[] = []
function flushRaf(): void {
  const cbs = rafQueue
  rafQueue = []
  for (const cb of cbs) cb(0)
}

beforeEach(() => {
  setActivePinia(createPinia())
  rafQueue = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    rafQueue.push(cb)
    return rafQueue.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('重评-P3-15：光晕 mousemove rect 缓存 + rAF 同帧合并', () => {
  it('同帧多次 mousemove 只一次写（帧内零写，flush 后 --mx/--my 各一次、取最后坐标）', async () => {
    const w = mount(BookCard, { props: { book: BOOK, variant: 'grid', onMove: onCardMove } })
    const el = w.find('.book-card').element as HTMLElement
    const setSpy = vi.spyOn(el.style, 'setProperty')

    await w.find('.book-card').trigger('mousemove', { clientX: 10, clientY: 5 })
    await w.find('.book-card').trigger('mousemove', { clientX: 20, clientY: 6 })
    await w.find('.book-card').trigger('mousemove', { clientX: 30, clientY: 7 })
    // rAF 前零直写（修复前每事件同步写 2 次 = 6 次调用）
    expect(setSpy).not.toHaveBeenCalled()
    flushRaf()
    expect(setSpy).toHaveBeenCalledTimes(2)
    expect(setSpy).toHaveBeenNthCalledWith(1, '--mx', '30px')
    expect(setSpy).toHaveBeenNthCalledWith(2, '--my', '7px')
    // 下一帧：新坐标再写一次（帧界隔离）
    await w.find('.book-card').trigger('mousemove', { clientX: 40, clientY: 8 })
    flushRaf()
    expect(setSpy).toHaveBeenCalledTimes(4)
    expect(setSpy).toHaveBeenLastCalledWith('--my', '8px')
    w.unmount()
  })

  it('rect 惰性缓存：同卡片多次 move 只读一次 getBoundingClientRect', async () => {
    const w = mount(BookCard, { props: { book: BOOK, variant: 'grid', onMove: onCardMove } })
    const el = w.find('.book-card').element as HTMLElement
    const rectSpy = vi.spyOn(el, 'getBoundingClientRect')

    await w.find('.book-card').trigger('mousemove', { clientX: 1, clientY: 1 })
    await w.find('.book-card').trigger('mousemove', { clientX: 2, clientY: 2 })
    await w.find('.book-card').trigger('mousemove', { clientX: 3, clientY: 3 })
    expect(rectSpy).toHaveBeenCalledTimes(1) // PM-9 同款：首事件惰性读一次后走缓存
    w.unmount()
  })

  it('同帧跨卡片移动：只写最后一卡，各卡 rect 独立缓存', async () => {
    const mk = (name: string) => ({ ...BOOK, name })
    const w1 = mount(BookCard, { props: { book: mk('书1'), variant: 'grid', onMove: onCardMove } })
    const w2 = mount(BookCard, { props: { book: mk('书2'), variant: 'grid', onMove: onCardMove } })
    const el1 = w1.find('.book-card').element as HTMLElement
    const el2 = w2.find('.book-card').element as HTMLElement
    const spy1 = vi.spyOn(el1.style, 'setProperty')
    const spy2 = vi.spyOn(el2.style, 'setProperty')
    const rectSpy1 = vi.spyOn(el1, 'getBoundingClientRect')

    await w1.find('.book-card').trigger('mousemove', { clientX: 1, clientY: 1 })
    await w2.find('.book-card').trigger('mousemove', { clientX: 9, clientY: 9 })
    flushRaf()
    expect(spy1).not.toHaveBeenCalled() // 帧内最后一次 wins，前卡不写
    expect(spy2).toHaveBeenCalledTimes(2)
    expect(rectSpy1).toHaveBeenCalledTimes(1)
    w1.unmount()
    w2.unmount()
  })

  it('R0910-W：scroll/resize 失效改惰性脏标记——失效后首次 move 重读 rect，随即回缓存', async () => {
    const w = mount(BookCard, { props: { book: BOOK, variant: 'grid', onMove: onCardMove } })
    const el = w.find('.book-card').element as HTMLElement
    const rectSpy = vi.spyOn(el, 'getBoundingClientRect')

    await w.find('.book-card').trigger('mousemove', { clientX: 1, clientY: 1 })
    expect(rectSpy).toHaveBeenCalledTimes(1) // 首事件惰性读一次

    // 滚动/尺寸变化 → 只置脏标记（旧实现此处即重建 WeakMap 丢弃全部缓存）
    window.dispatchEvent(new Event('scroll'))
    await w.find('.book-card').trigger('mousemove', { clientX: 2, clientY: 2 })
    expect(rectSpy).toHaveBeenCalledTimes(2) // 失效后首次读取重读其实测 rect
    await w.find('.book-card').trigger('mousemove', { clientX: 3, clientY: 3 })
    expect(rectSpy).toHaveBeenCalledTimes(2) // 脏标记已消费，回到缓存命中
    flushRaf()
    w.unmount()
  })
})
