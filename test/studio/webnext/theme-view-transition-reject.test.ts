// @vitest-environment happy-dom
/**
 * R43-9（四十三轮）回归：useTheme ViewTransition 被抢占（ready/finished reject）→
 * 无 unhandledRejection（win 已瞬切不进 VT〔2026-09-04 拍板〕，抢占面在 mac/浏览器腿）
 * （原 r43-frontend-batch R43-9 节，按行为拆分落位）。
 */
import { describe, it, expect, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// prefs API mock：useTheme 测试走真 prefs store（applyTheme 语义在测），
// 持久化通道 mock 掉防落盘副作用。
vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getGlobalPrefs: vi.fn(async () => ({ prefs: {}, revision: 'r0' })),
  putGlobalPrefs: vi.fn(async () => ({ revision: 'r1' })),
  getBookPrefs: vi.fn(async () => ({})),
  putBookPrefs: vi.fn(async () => ({})),
}))

import { useTheme } from '../../../src/studio/web-next/src/composables/useTheme'

describe('R43-9: useTheme ViewTransition 被抢占（ready/finished reject）', () => {
  it('无 unhandledRejection 逃逸（win 已瞬切不走 VT，抢占面在 mac/浏览器腿）', async () => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    // happy-dom 缺 matchMedia 时补最小替身（只读 .matches）
    if (typeof window.matchMedia !== 'function') {
      ;(window as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia = () => ({ matches: false })
    }
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown) => unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    const overlay = vi.fn()
    const docEl = document.documentElement as unknown as Record<string, unknown>
    const vtDoc = document as unknown as Record<string, unknown>
    const win = window as unknown as Record<string, unknown>
    const prevAnimate = docEl.animate
    try {
      win.clwritingDesktop = {
        platform: 'darwin', // win 已瞬切不进 VT（2026-09-04 拍板）；抢占防御在 mac/浏览器腿
        setTitleBarOverlay: overlay,
      }
      docEl.animate = vi.fn() // happy-dom 无 Element.animate
      // 抢占语义：回调执行（fn 生效）但 ready/finished 均以 reject 收场
      vtDoc.startViewTransition = (cb: () => void) => {
        cb()
        return {
          ready: Promise.reject(new Error('ready 抢占')),
          finished: Promise.reject(new Error('finished 抢占')),
        }
      }

      const { toggle } = useTheme()
      toggle()
      // 微任务冲排：ready.catch / finished.catch 执行
      await vi.advanceTimersByTimeAsync(0)
      // R43-9 核心：浮空 ready.then / 无 catch 的 finished 链不产生 unhandledRejection
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      vtDoc.startViewTransition = undefined
      win.clwritingDesktop = undefined
      if (prevAnimate === undefined) docEl.animate = undefined
      else docEl.animate = prevAnimate
      vi.useRealTimers()
    }
  })
})
