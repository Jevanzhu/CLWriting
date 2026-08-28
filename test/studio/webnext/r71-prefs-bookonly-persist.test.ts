// @vitest-environment happy-dom
/**
 * R71-29（七十一轮）回归：setPageWidth(v, true) / setAutosaveInterval(v, true)
 * bookOnly 分支此前尾部仍 schedulePersist() 全量 PUT global.json（书级键不在
 * buildCache 内，纯冗余写），服务端无条件 bump revision → 双窗伪 409。
 *
 * 修复：bookOnly 分支跳过 schedulePersist（书级持久化由 workspace watch 写
 * prefs.json 承担——startPersistWatch 监听 ps.bookPageWidth/bookAutosaveInterval）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getGlobalPrefs: vi.fn(),
  putGlobalPrefs: vi.fn(),
}))

import { getGlobalPrefs, putGlobalPrefs } from '../../../src/studio/web-next/src/api/prefs'
import { usePrefsStore } from '../../../src/studio/web-next/src/stores/prefs'

const putGlobalPrefsMock = putGlobalPrefs as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  putGlobalPrefsMock.mockReset()
  putGlobalPrefsMock.mockResolvedValue({ ok: true as const, revision: 1 })
  ;(getGlobalPrefs as ReturnType<typeof vi.fn>).mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('R71-29: bookOnly setter 不触发全局 PUT（双窗伪 409 消除）', () => {
  it('setPageWidth(v, true) → 推进防抖窗口后 putGlobalPrefs 不调用', () => {
    const prefs = usePrefsStore()
    prefs.setPageWidth(800, true)
    expect(prefs.bookPageWidth).toBe(800) // 书级覆盖仍生效（守卫不误伤功能）
    expect(prefs.effectivePageWidth).toBe(800)
    vi.advanceTimersByTime(600)
    expect(putGlobalPrefsMock).not.toHaveBeenCalled() // 修复点：bookOnly 跳过全局 PUT
  })

  it('setAutosaveInterval(v, true) → 同规则不触发', () => {
    const prefs = usePrefsStore()
    prefs.setAutosaveInterval(10, true)
    expect(prefs.bookAutosaveInterval).toBe(10)
    vi.advanceTimersByTime(600)
    expect(putGlobalPrefsMock).not.toHaveBeenCalled()
  })

  it('连续 bookOnly 变更多次 → 仍零 PUT', () => {
    const prefs = usePrefsStore()
    prefs.setPageWidth(800, true)
    prefs.setPageWidth(900, true)
    prefs.setAutosaveInterval(15, true)
    vi.advanceTimersByTime(600)
    expect(putGlobalPrefsMock).not.toHaveBeenCalled()
  })

  it('setPageWidth(v, false)（写全局默认）→ 照常防抖 PUT（对照组）', () => {
    const prefs = usePrefsStore()
    prefs.setPageWidth(900, false)
    vi.advanceTimersByTime(600)
    expect(putGlobalPrefsMock).toHaveBeenCalledTimes(1)
    expect(putGlobalPrefsMock).toHaveBeenCalledWith(expect.objectContaining({ pageWidth: 900 }), 0)
  })

  it('setAutosaveInterval(v, false) → 照常 PUT（对照组）', () => {
    const prefs = usePrefsStore()
    prefs.setAutosaveInterval(45, false)
    vi.advanceTimersByTime(600)
    expect(putGlobalPrefsMock).toHaveBeenCalledTimes(1)
    expect(putGlobalPrefsMock).toHaveBeenCalledWith(expect.objectContaining({ autosaveInterval: 45 }), 0)
  })
})
