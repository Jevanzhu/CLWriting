// @vitest-environment happy-dom
/**
 * R37-27（三十七轮批E）回归：全局偏好 409 冲突恢复后样式生效。
 *
 * 修复前：recoverFromConflict 只 applyPrefs 写 refs（state）不落样式——非本窗脏字段
 * 采纳远端新值后，排版 CSS 变量 / 主题 dataset 仍停留在冲突前旧值，「已合并最新值」
 * 提示弹出但样式不生效。
 * 修复后：applyPrefs 后接 applyTheme/applyCompact/apply 三连（对齐 init() 恢复链）。
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

const getMock = getGlobalPrefs as ReturnType<typeof vi.fn>
const putMock = putGlobalPrefs as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  vi.clearAllMocks()
  getMock.mockResolvedValue({ prefs: {}, revision: 0 })
  putMock.mockImplementation(async (_p, rev) => ({ ok: true as const, revision: (rev ?? 0) + 1 }))
  document.documentElement.style.setProperty('--prose-size', '')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('R37-27: 409 恢复分支漏 apply——恢复后样式随之生效', () => {
  it('远端改 proseSize/theme，本窗仅 snapDays 脏 → 恢复后 CSS 变量与主题 dataset 更新', async () => {
    // 初始：服务端 light + 默认字号（17px）——init 落一轮样式基线
    getMock.mockResolvedValue({ prefs: { theme: 'light' }, revision: 0 })
    const prefs = usePrefsStore()
    await prefs.init()
    expect(prefs.proseSize).toBe(17)
    expect(document.documentElement.style.getPropertyValue('--prose-size')).toBe('17px')
    expect(document.documentElement.dataset.theme).toBe('light')

    // 本窗脏字段：snapDays（防抖窗口内未落盘）；首笔 PUT 吃 409
    prefs.setSnapDays(45)
    putMock.mockImplementationOnce(async () => Promise.reject(new ApiError('已在其他窗口被修改', 409)))
    // 恢复 GET：远端已改 theme=dark + proseSize=22（非本窗脏字段 → 采纳远端）
    getMock.mockResolvedValueOnce({ prefs: { theme: 'dark', proseSize: 22 }, revision: 1 })

    await vi.advanceTimersByTimeAsync(600)
    for (let i = 0; i < 5; i++) await Promise.resolve()

    expect(prefs.proseSize).toBe(22) // refs 已合并（R35-8 既有口径，对照组）
    // 修复点：样式同步生效（修复前 --prose-size 停留 17px、dataset.theme 停留 light）
    expect(document.documentElement.style.getPropertyValue('--prose-size')).toBe('22px')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(prefs.snapDays).toBe(45) // 本窗脏字段重放（不回归）
  })

  it('对照组：init() 常规路径样式照常生效（基线锚定，防测试环境假阳性）', async () => {
    getMock.mockResolvedValue({ prefs: { theme: 'dark', proseSize: 20 }, revision: 3 })
    const prefs = usePrefsStore()
    await prefs.init()
    expect(document.documentElement.style.getPropertyValue('--prose-size')).toBe('20px')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})
