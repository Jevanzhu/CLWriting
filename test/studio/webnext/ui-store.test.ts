/**
 * ui store 单测（第十轮 P1-TST-1）：弹窗开关 / Toast 队列 / 命令式确认与输入 / AI 探测重试。
 *
 * 覆盖重点：
 * - 四类弹窗 open/close 开关
 * - toast 1.8s 自动消失
 * - ask/resolveConfirm 命令式确认
 * - prompt/resolvePrompt 命令式输入
 * - probeAiStatus 成功停重试 / 失败定时重试（fake timers 推进）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/ai-status', () => ({
  getAiStatus: vi.fn(),
}))

import { getAiStatus } from '../../../src/studio/web-next/src/api/ai-status'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

const getAiStatusMock = getAiStatus as ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  getAiStatusMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ui: 弹窗开关', () => {
  it('palette/settings/export/shelf 各自独立开关', () => {
    const ui = useUiStore()
    expect(ui.paletteOpen).toBe(false)
    ui.openPalette()
    expect(ui.paletteOpen).toBe(true)
    ui.closePalette()
    expect(ui.paletteOpen).toBe(false)

    ui.openSettings()
    ui.openExport()
    ui.openShelf()
    expect(ui.settingsOpen).toBe(true)
    expect(ui.exportOpen).toBe(true)
    expect(ui.shelfOpen).toBe(true)
    ui.closeSettings()
    ui.closeExport()
    ui.closeShelf()
    expect(ui.settingsOpen).toBe(false)
    expect(ui.exportOpen).toBe(false)
    expect(ui.shelfOpen).toBe(false)
  })
})

describe('ui: Toast 队列', () => {
  it('toast 添加 + 1.8s 后自动消失', () => {
    const ui = useUiStore()
    ui.toast('保存成功', 'success')
    expect(ui.toasts).toHaveLength(1)
    expect(ui.toasts[0]).toMatchObject({ msg: '保存成功', kind: 'success' })
    vi.advanceTimersByTime(1900)
    expect(ui.toasts).toHaveLength(0)
  })

  it('多条 toast 各自独立消失', () => {
    const ui = useUiStore()
    ui.toast('第一条')
    vi.advanceTimersByTime(500)
    ui.toast('第二条')
    expect(ui.toasts).toHaveLength(2)
    vi.advanceTimersByTime(1500) // 第一条到 2s
    expect(ui.toasts).toHaveLength(1)
    expect(ui.toasts[0]!.msg).toBe('第二条')
    vi.advanceTimersByTime(1000)
    expect(ui.toasts).toHaveLength(0)
  })
})

describe('ui: 命令式确认弹窗', () => {
  it('ask 返回 Promise → resolveConfirm(true) 时 resolve true', async () => {
    const ui = useUiStore()
    const p = ui.ask({ title: '删除？', message: '确定删除该章？', danger: true })
    expect(ui.confirmState).toMatchObject({ title: '删除？', danger: true })
    ui.resolveConfirm(true)
    await expect(p).resolves.toBe(true)
    expect(ui.confirmState).toBeNull()
  })

  it('resolveConfirm(false) → resolve false + 关闭', async () => {
    const ui = useUiStore()
    const p = ui.ask({ title: '删除？', message: '确定？' })
    ui.resolveConfirm(false)
    await expect(p).resolves.toBe(false)
  })

  it('confirmState 为 null 时 resolveConfirm 安全（不抛错）', () => {
    const ui = useUiStore()
    expect(() => ui.resolveConfirm(true)).not.toThrow()
  })
})

describe('ui: 命令式输入弹窗', () => {
  it('prompt 返回 Promise → resolvePrompt 传值', async () => {
    const ui = useUiStore()
    const p = ui.prompt({ title: '书名', message: '输入书名', defaultValue: '未命名' })
    expect(ui.promptState).toMatchObject({ defaultValue: '未命名' })
    ui.resolvePrompt('我的新书')
    await expect(p).resolves.toBe('我的新书')
    expect(ui.promptState).toBeNull()
  })

  it('resolvePrompt(null) → resolve null（取消）', async () => {
    const ui = useUiStore()
    const p = ui.prompt({ title: '书名', message: '输入书名' })
    ui.resolvePrompt(null)
    await expect(p).resolves.toBeNull()
  })
})

describe('ui: AI 可达性探测', () => {
  it('探测成功 → aiAvailable=true + 停重试', async () => {
    getAiStatusMock.mockResolvedValue({ available: true, driver: 'anthropic' })
    const ui = useUiStore()
    await ui.probeAiStatus()
    expect(ui.aiAvailable).toBe(true)
    expect(ui.aiDriver).toBe('anthropic')
    vi.advanceTimersByTime(15000)
    expect(getAiStatusMock).toHaveBeenCalledTimes(1) // 无重试
  })

  it('探测失败 → aiAvailable=false + 5s 后重试成功即停', async () => {
    getAiStatusMock.mockRejectedValueOnce(new Error('down'))
    const ui = useUiStore()
    await ui.probeAiStatus()
    expect(ui.aiAvailable).toBe(false)
    expect(getAiStatusMock).toHaveBeenCalledTimes(1)
    // 5s 后重试成功
    getAiStatusMock.mockResolvedValueOnce({ available: true, driver: 'openai' })
    vi.advanceTimersByTime(5000)
    await vi.runAllTimersAsync()
    expect(ui.aiAvailable).toBe(true)
    // 成功后不再重试
    vi.advanceTimersByTime(15000)
    expect(getAiStatusMock).toHaveBeenCalledTimes(2)
  })
})
