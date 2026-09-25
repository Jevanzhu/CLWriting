/**
 * AI 可达性探测指数退避（store 面，node 环境）。
 * （原 r29-fe-e3-e6-stores 的 E-5 节，按行为单拆。）
 *
 * E-5（二十九轮）：探测失败重试间隔改指数退避（5s 起 ×2 封顶 60s）——原 5s 固定轮询
 * 在 AI 长期不可达时永久打点；available:true 成功即停并复位退避阶。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  getAiStatus: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/ai-status', () => ({ getAiStatus: mocks.getAiStatus }))
// prefs store 的 apply() 触碰 document（node 环境无 DOM）——stub 掉，本文件不测 CSS 注入
vi.mock('../../../src/studio/web-next/src/stores/prefs', () => ({
  usePrefsStore: () => ({
    bookPageWidth: null,
    bookAutosaveInterval: null,
    apply: vi.fn(),
  }),
}))

import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

describe('E-5: AI 可达性探测指数退避', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('连续失败 → 间隔 5s→10s→20s→…封顶 60s；成功复位后再次失败从 5s 起步', async () => {
    mocks.getAiStatus.mockRejectedValue(new Error('down'))
    const ui = useUiStore()
    await ui.probeAiStatus()
    expect(mocks.getAiStatus).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.getAiStatus).toHaveBeenCalledTimes(2) // 5s
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.getAiStatus).toHaveBeenCalledTimes(3) // 10s
    await vi.advanceTimersByTimeAsync(20_000)
    expect(mocks.getAiStatus).toHaveBeenCalledTimes(4) // 20s

    // 推到封顶：退避阶足够大后间隔钉在 60s（累计推进 60s 恰好多一次调用）
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(60_000)
    const capped = mocks.getAiStatus.mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.getAiStatus.mock.calls.length).toBe(capped) // 30s 内不再触发（间隔 > 30s）
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.getAiStatus.mock.calls.length).toBe(capped + 1) // 恰在 60s 边界触发

    // 成功 → 停止 + 退避阶复位
    mocks.getAiStatus.mockResolvedValue({ available: true, driver: 'x' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ui.aiAvailable).toBe(true)
    const afterOk = mocks.getAiStatus.mock.calls.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(mocks.getAiStatus.mock.calls.length).toBe(afterOk)

    // 再次失败 → 从 5s 重新起步（复位生效）
    mocks.getAiStatus.mockRejectedValue(new Error('down again'))
    await ui.probeAiStatus()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.getAiStatus.mock.calls.length).toBe(afterOk + 2)
  })
})
