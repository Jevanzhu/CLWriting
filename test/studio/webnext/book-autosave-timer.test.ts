// @vitest-environment happy-dom
/**
 * RC 源码重审 B-5（Opus-5.5 轮）单测：自动保存节拍（composables/useAutosave）的启停与清理。
 *
 * 被测行为 = 抽出的节拍三态：挂载起拍（按 effectiveAutosaveInterval，下限 5s 钳制）、
 * 间隔变更重起（旧表必清，不得双表并行）、卸载停表（成对清理——本仓反复加固的生命周期面）。
 * 抽取前该节拍挂在 Book.vue 顶层三角（onMounted/watch/onUnmounted）且无任何直测；抽出后
 * 节拍可脱离页面直测（页面接线仍由 Book.vue 挂载面回归覆盖）。
 *
 * 计时用 vi.useFakeTimers（节拍为真 setInterval；不推进即不触拍）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'

// prefs 的持久化网络面（本测只关心节拍，不落盘）——store 全真件
vi.mock('../../../src/studio/web-next/src/api/prefs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/prefs')>()
  return {
    ...actual,
    getGlobalPrefs: vi.fn(async () => ({})),
    putGlobalPrefs: vi.fn(async () => {}),
    getBookPrefs: vi.fn(async () => ({})),
    putBookPrefs: vi.fn(async () => {}),
  }
})

import { useAutosave } from '../../../src/studio/web-next/src/composables/useAutosave'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { usePrefsStore } from '../../../src/studio/web-next/src/stores/prefs'

/** 宿主：setup 内只挂节拍（生命周期与 Book.vue 一致，其余一概不装配）。 */
const Host = defineComponent({
  setup() {
    useAutosave()
    return () => h('div')
  },
})

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('RC B-5: 自动保存节拍——起拍、重起与停表', () => {
  it('挂载不抢跑；满一个 effectiveAutosaveInterval（默认 30s）落一拍', async () => {
    const doc = useDocStore()
    const tickSpy = vi.spyOn(doc, 'autosaveTick').mockImplementation(() => {})
    const w = mount(Host)
    expect(tickSpy).not.toHaveBeenCalled() // 起拍不抢跑（首拍在满窗后）

    vi.advanceTimersByTime(29_999)
    expect(tickSpy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(tickSpy).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(30_000)
    expect(tickSpy).toHaveBeenCalledTimes(2) // 节拍连续
    w.unmount()
  })

  it('间隔变更 → 按新节拍重起（旧表清除，不双表并行）', async () => {
    const doc = useDocStore()
    const prefs = usePrefsStore()
    const tickSpy = vi.spyOn(doc, 'autosaveTick').mockImplementation(() => {})
    const w = mount(Host)
    vi.advanceTimersByTime(30_000)
    expect(tickSpy).toHaveBeenCalledTimes(1)

    prefs.autosaveInterval = 10
    await nextTick() // 重起走 watch(flush 默认 pre)
    tickSpy.mockClear()
    vi.advanceTimersByTime(10_000)
    expect(tickSpy).toHaveBeenCalledTimes(1) // 新表 10s 落一拍
    vi.advanceTimersByTime(10_000)
    expect(tickSpy).toHaveBeenCalledTimes(2)
    w.unmount()
  })

  it('书级覆盖（bookAutosaveInterval）同样进节拍源（effective 口径）', async () => {
    const doc = useDocStore()
    const prefs = usePrefsStore()
    const tickSpy = vi.spyOn(doc, 'autosaveTick').mockImplementation(() => {})
    prefs.bookAutosaveInterval = 8
    const w = mount(Host)
    vi.advanceTimersByTime(8_000)
    expect(tickSpy).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('下限钳制：间隔 < 5s 仍按 5s 起拍（Math.max(5, …)）', async () => {
    const doc = useDocStore()
    const prefs = usePrefsStore()
    const tickSpy = vi.spyOn(doc, 'autosaveTick').mockImplementation(() => {})
    prefs.autosaveInterval = 1
    const w = mount(Host)
    vi.advanceTimersByTime(4_999)
    expect(tickSpy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(tickSpy).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('卸载停表（成对清理）：卸载后推进再久也不再触拍', async () => {
    const doc = useDocStore()
    const tickSpy = vi.spyOn(doc, 'autosaveTick').mockImplementation(() => {})
    const w = mount(Host)
    vi.advanceTimersByTime(30_000)
    expect(tickSpy).toHaveBeenCalledTimes(1)

    w.unmount()
    vi.advanceTimersByTime(5 * 60_000)
    expect(tickSpy).toHaveBeenCalledTimes(1) // 计时器已清：无卸载后空转
  })

  it('重挂新实例 → 新节拍独立起算（不叠加上一实例的残留表）', async () => {
    const doc = useDocStore()
    const tickSpy = vi.spyOn(doc, 'autosaveTick').mockImplementation(() => {})
    const w1 = mount(Host)
    vi.advanceTimersByTime(30_000)
    w1.unmount()
    tickSpy.mockClear()

    const w2 = mount(Host)
    vi.advanceTimersByTime(30_000)
    expect(tickSpy).toHaveBeenCalledTimes(1) // 只有新实例的表在跑
    w2.unmount()
  })
})
