// @vitest-environment happy-dom
/**
 * R40-41（四十轮）回归：prefs recoverFromConflict 恢复链三态告知——重试保存失败
 * 不再按成功口径提示「已保留本窗修改并合并」（原实现 catch 静默 + 无条件成功 toast）。
 * harness 对齐 r35-prefs-409-merge.test.ts。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getGlobalPrefs: vi.fn(),
  putGlobalPrefs: vi.fn(),
}))

import { getGlobalPrefs, putGlobalPrefs } from '../../../src/studio/web-next/src/api/prefs'
import { ApiError } from '../../../src/studio/web-next/src/api/client'
import { usePrefsStore } from '../../../src/studio/web-next/src/stores/prefs'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

const getMock = getGlobalPrefs as ReturnType<typeof vi.fn>
const putMock = putGlobalPrefs as ReturnType<typeof vi.fn>

function conflict409(): ApiError {
  return new ApiError('已在其他窗口被修改', 409)
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

describe('R40-41: 恢复链三态告知', () => {
  it('重试保存失败 → error toast 如实告知，不再报成功', async () => {
    getMock.mockResolvedValue({ prefs: { theme: 'light' }, revision: 0 })
    const prefs = usePrefsStore()
    await prefs.init()

    prefs.setThemeValue('dark')
    // 首笔 PUT 吃 409；恢复链 GET 拿到远端 rev1；重试 PUT 网络失败
    putMock.mockImplementationOnce(async () => Promise.reject(conflict409()))
    getMock.mockResolvedValueOnce({ prefs: { theme: 'light' }, revision: 1 })
    putMock.mockImplementationOnce(async () => Promise.reject(new Error('网络中断')))

    await vi.advanceTimersByTimeAsync(600)
    for (let i = 0; i < 5; i++) await Promise.resolve()

    expect(putMock).toHaveBeenCalledTimes(2) // 首笔 + 重试（都失败）
    const ui = useUiStore()
    const last = ui.toasts.at(-1)
    expect(last?.kind).toBe('error')
    expect(last?.msg).toContain('重试保存失败')
    // 不再有无条件的成功口径提示
    expect(ui.toasts.filter((t) => t.kind === 'warning' && t.msg.includes('已保留本窗修改并合并'))).toHaveLength(0)
    // 本窗脏修改仍保留（下次 schedulePersist 自动重试的语义基础）
    expect(prefs.theme).toBe('dark')
  })

  it('重试成功 → 维持成功口径 warning（不回归）', async () => {
    getMock.mockResolvedValue({ prefs: { theme: 'light' }, revision: 0 })
    const prefs = usePrefsStore()
    await prefs.init()

    prefs.setThemeValue('dark')
    putMock.mockImplementationOnce(async () => Promise.reject(conflict409()))
    getMock.mockResolvedValueOnce({ prefs: { theme: 'light', pageWidth: 999 }, revision: 1 })

    await vi.advanceTimersByTimeAsync(600)
    for (let i = 0; i < 5; i++) await Promise.resolve()

    const ui = useUiStore()
    expect(ui.toasts.at(-1)?.kind).toBe('warning')
    expect(ui.toasts.at(-1)?.msg).toContain('已保留本窗修改并合并')
    expect(prefs.pageWidth).toBe(999)
  })
})
