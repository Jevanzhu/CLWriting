// @vitest-environment happy-dom
/**
 * R35-8（三十五轮）回归：全局偏好 409 冲突恢复改「远端值垫底 + 本窗未落盘修改重放」。
 * 修复前（R33-73 口径）：applyPrefs 整体采纳远端——本窗已改未落盘的字段被静默丢弃；
 * 重试 PUT 脱离 putInFlight 单飞（fire-and-forget），恢复窗口内的新保存带陈旧 revision
 * 再吃 409。修复后：脏字段（当前 refs ≠ 最近成功落盘快照）重放本窗值，恢复与重试纳入
 * 单飞，toast 升 warning 如实描述。
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
  // 默认成功链：PUT 按传入 expectedRevision 自增（后续保存拿最新 revision）
  getMock.mockResolvedValue({ prefs: {}, revision: 0 })
  putMock.mockImplementation(async (_p, rev) => ({ ok: true as const, revision: (rev ?? 0) + 1 }))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('prefs: 409 恢复——远端垫底 + 本窗未落盘修改重放（R35-8）', () => {
  it('本窗改 theme 未落盘 + 他窗改 pageWidth 先保存 → 恢复后两者并存，重试带远端 revision', async () => {
    getMock.mockResolvedValue({ prefs: { theme: 'light', pageWidth: 1020, defaultGenre: '玄幻' }, revision: 5 })
    const prefs = usePrefsStore()
    await prefs.init()

    prefs.setThemeValue('dark') // 本窗脏修改（防抖窗口内，尚未落盘）
    // 他窗抢先保存：pageWidth → 999，revision 5 → 6；首次 PUT 吃 409
    putMock.mockImplementationOnce(async () => Promise.reject(conflict409()))
    getMock.mockResolvedValueOnce({ prefs: { theme: 'light', pageWidth: 999, defaultGenre: '玄幻' }, revision: 6 })

    await vi.advanceTimersByTimeAsync(600)
    for (let i = 0; i < 5; i++) await Promise.resolve()

    // 修复点 1：本窗未落盘修改保留（修复前 applyPrefs 整体采纳远端 → theme 被改回 light）
    expect(prefs.theme).toBe('dark')
    // 修复点 2：他窗字段合入（R33-73 语义保留）
    expect(prefs.pageWidth).toBe(999)
    expect(putMock).toHaveBeenCalledTimes(2)
    // 修复点 3：重试 PUT 带远端最新 revision + 合并后的完整快照
    expect(putMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: 'dark', pageWidth: 999, defaultGenre: '玄幻' }),
      6,
    )
    // 修复点 4：toast 升 warning 且如实描述
    const ui = useUiStore()
    expect(ui.toasts.at(-1)?.kind).toBe('warning')
    expect(ui.toasts.at(-1)?.msg).toContain('其他窗口')
  })

  it('恢复窗口内的新保存排队到重试完成后发出（重试纳入 putInFlight 单飞），带最新 revision', async () => {
    getMock.mockResolvedValue({ prefs: { theme: 'light' }, revision: 0 })
    const prefs = usePrefsStore()
    await prefs.init()

    prefs.setThemeValue('dark')
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    putMock.mockImplementationOnce(() => gate.then(() => Promise.reject(conflict409())))
    getMock.mockResolvedValueOnce({ prefs: { theme: 'light', shelfView: 'list' }, revision: 1 })

    await vi.advanceTimersByTimeAsync(600) // 防抖到点：首次 PUT 挂起在 gate
    prefs.setShelfView('list') // 恢复窗口内的新保存
    await vi.advanceTimersByTimeAsync(600) // 第二个防抖定时器到点：putInFlight 非空 → 重新排队
    expect(putMock).toHaveBeenCalledTimes(1) // 单飞：恢复链未完成，无并发 PUT

    release() // 放行首次 PUT → 409 → 恢复链（GET rev1 + 重试）
    await vi.advanceTimersByTimeAsync(1200) // 重试完成 + 排队的防抖到点
    for (let i = 0; i < 5; i++) await Promise.resolve()

    // 第 2 笔 = 409 重试：合并本窗脏字段（theme/shelfView 均为本窗修改）+ 远端 rev
    expect(putMock.mock.calls[1]).toEqual([
      expect.objectContaining({ theme: 'dark', shelfView: 'list' }),
      1,
    ])
    // 第 3 笔 = 排队保存：重试成功后以最新 revision（2）发出，不再吃 409
    expect(putMock.mock.calls[2]).toEqual([
      expect.objectContaining({ theme: 'dark', shelfView: 'list' }),
      2,
    ])
  })

  it('无本窗脏字段 → 恢复整体采纳远端（远端垫底语义不回归）', async () => {
    getMock.mockResolvedValue({ prefs: { theme: 'light' }, revision: 0 })
    const prefs = usePrefsStore()
    await prefs.init()

    // 本窗无任何修改，仅其他窗口改了主题与排版
    putMock.mockImplementationOnce(async () => Promise.reject(conflict409()))
    // 触发一笔与本窗无关的保存（snapDays 走 setter 也会置脏——改用直接 PUT：不需要；
    // 用 setSnapDays 制造一次保存，但随后远端 snapMaxDays 视为非脏会被远端覆盖）
    getMock.mockResolvedValueOnce({ prefs: { theme: 'dark', proseSize: 22 }, revision: 9 })

    prefs.setSnapDays(45) // 本窗修改：snapDays
    await vi.advanceTimersByTimeAsync(600)
    for (let i = 0; i < 5; i++) await Promise.resolve()

    expect(prefs.snapDays).toBe(45) // 本窗脏字段重放
    expect(prefs.theme).toBe('dark') // 非脏字段随远端
    expect(prefs.proseSize).toBe(22)
    expect(putMock).toHaveBeenCalledTimes(2)
  })
})
