// @vitest-environment happy-dom
/**
 * R55-F-7（五十五轮）回归：全局偏好非 409 持久化失败不再全静默。
 *
 * 现状：doPersistPut 的 PUT 失败中非.ApiError-409 分支静默 return——离线改主题/排版
 * 不落盘、重启回退且无提示。修复：非 409 失败补一次性 warning toast（busy429Notified
 * 同款去重：同一失败窗只提示一次，成功落盘后复位，再败可再提示）。
 * harness 对齐 r40-prefs-409-retry-fail.test.ts。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getGlobalPrefs: vi.fn(),
  putGlobalPrefs: vi.fn(),
}))

import { getGlobalPrefs, putGlobalPrefs } from '../../../src/studio/web-next/src/api/prefs'
import { usePrefsStore } from '../../../src/studio/web-next/src/stores/prefs'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

const getMock = getGlobalPrefs as ReturnType<typeof vi.fn>
const putMock = putGlobalPrefs as ReturnType<typeof vi.fn>

/** 泵微任务（PUT promise 链落定） */
async function pump(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  vi.clearAllMocks()
  getMock.mockResolvedValue({ prefs: {}, revision: 0 })
  putMock.mockImplementation(async (_p, rev) => ({ ok: true as const, revision: (rev ?? 0) + 1 }))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('R55-F-7: 非 409 持久化失败的一次性 warning', () => {
  it('非 409 失败（网络/5xx）→ warning toast 恰一次', async () => {
    const prefs = usePrefsStore()
    await prefs.init()
    const ui = useUiStore()
    const toastSpy = vi.spyOn(ui, 'toast')

    putMock.mockRejectedValue(new Error('网络中断'))
    prefs.setThemeValue('dark')
    await vi.advanceTimersByTimeAsync(600) // 500ms 防抖到点 → PUT 失败
    await pump()

    expect(putMock).toHaveBeenCalledTimes(1)
    expect(toastSpy).toHaveBeenCalledTimes(1) // 修复点：不再静默
    expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('全局偏好'), 'warning')
  })

  it('连败不重复提示（同一失败窗只提示一次）', async () => {
    const prefs = usePrefsStore()
    await prefs.init()
    const ui = useUiStore()
    const toastSpy = vi.spyOn(ui, 'toast')

    putMock.mockRejectedValue(new Error('网络中断'))
    prefs.setThemeValue('dark')
    await vi.advanceTimersByTimeAsync(600)
    await pump()
    expect(toastSpy).toHaveBeenCalledTimes(1)

    prefs.setSize(20)
    await vi.advanceTimersByTimeAsync(600)
    await pump()
    expect(toastSpy).toHaveBeenCalledTimes(1) // 修复点：去重，不刷屏

    prefs.setLh(2)
    await vi.advanceTimersByTimeAsync(600)
    await pump()
    expect(toastSpy).toHaveBeenCalledTimes(1)
  })

  it('成功落盘后复位 → 再失败可再提示', async () => {
    const prefs = usePrefsStore()
    await prefs.init()
    const ui = useUiStore()
    const toastSpy = vi.spyOn(ui, 'toast')

    putMock.mockRejectedValueOnce(new Error('网络中断'))
    prefs.setThemeValue('dark')
    await vi.advanceTimersByTimeAsync(600)
    await pump()
    expect(toastSpy).toHaveBeenCalledTimes(1)

    // 恢复：PUT 成功（beforeEach 默认实现）→ 复位
    prefs.setSize(20)
    await vi.advanceTimersByTimeAsync(600)
    await pump()
    expect(toastSpy).toHaveBeenCalledTimes(1) // 成功不提示

    putMock.mockRejectedValueOnce(new Error('再次断网'))
    prefs.setLh(2)
    await vi.advanceTimersByTimeAsync(600)
    await pump()
    expect(toastSpy).toHaveBeenCalledTimes(2) // 修复点：复位后再败可再提示
    expect(toastSpy).toHaveBeenLastCalledWith(expect.stringContaining('全局偏好'), 'warning')
  })
})
