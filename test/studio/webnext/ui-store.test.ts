/**
 * ui store 单测（第十轮 P1-TST-1）：弹窗开关 / Toast 队列 / 命令式确认与输入 / AI 探测重试。
 *
 * 覆盖重点：
 * - 四类弹窗 open/close 开关
 * - toast 分级时长（error 5s / 其余 1.8s）自动消失
 * - ask/resolveConfirm 命令式确认
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

  // 低级项（第六轮）：错误 toast 分级 5s——1.8s 读不完失败原因就消失，作者只能反复操作
  it('error toast 5s 后消失（分级时长；成功/信息保持 1.8s）', () => {
    const ui = useUiStore()
    ui.toast('保存失败：网络错误', 'error')
    expect(ui.toasts).toHaveLength(1)
    vi.advanceTimersByTime(1900) // 1.8s：错误仍在（旧一刀切口径此时已消失）
    expect(ui.toasts).toHaveLength(1)
    vi.advanceTimersByTime(3200) // 到 5.1s：消失
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

  // R-22（第十六轮）：后端可达但 available:false（AI 供应商未配置/未就绪）也走 5s 重试
  it('available:false → 同样 5s 后重试（只有 available:true 停止）', async () => {
    getAiStatusMock.mockResolvedValue({ available: false, driver: '' })
    const ui = useUiStore()
    await ui.probeAiStatus()
    expect(ui.aiAvailable).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(getAiStatusMock).toHaveBeenCalledTimes(2) // 修复前：不重试，永久卡 false
    await vi.advanceTimersByTimeAsync(5000)
    expect(getAiStatusMock).toHaveBeenCalledTimes(3) // 仍 false → 继续按 5s 重试
    // 变 true 后停止
    getAiStatusMock.mockResolvedValue({ available: true, driver: 'anthropic' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(ui.aiAvailable).toBe(true)
    vi.advanceTimersByTime(15000)
    expect(getAiStatusMock).toHaveBeenCalledTimes(4) // 成功即停
  })
})

// ── CC-P1-5：ask/prompt 并发覆盖结清 ────────────────────

describe('ui: ask/prompt 并发覆盖结清（CC-P1-5）', () => {
  it('ask 顶掉未决确认 → 旧 Promise 以 false 结清（不永久悬挂）', async () => {
    const ui = useUiStore()
    const p1 = ui.ask({ title: '第一个', message: 'm' })
    const p2 = ui.ask({ title: '第二个', message: 'm' })
    // 修复前：p1 的 resolve 随 confirmState 被覆盖而丢失，await 永久挂起
    await expect(p1).resolves.toBe(false)
    expect(ui.confirmState?.title).toBe('第二个') // 弹窗展示的是后来者
    ui.resolveConfirm(true)
    await expect(p2).resolves.toBe(true)
  })

})
