// @vitest-environment happy-dom
/**
 * R60-D-1（六十轮）：关窗冲刷在途竞态回归。
 *
 * 缺陷形态：flushPendingPersist 的 `if (putInFlight) return` 先于一切——关窗钩子
 * （主进程 flushRendererBeforeClose 经 executeJavaScript `await window.__clwFlushPrefs()`）
 * 恰逢在途 PUT 时立即空返回，主进程视为冲刷完成即放行销毁窗口；在途 PUT 快照之后的
 * 偏好改动（<500ms 防抖窗内）随防抖定时器与窗口一同死亡而丢失。
 *
 * 修复口径：flushPendingPersist 返回真链 Promise——等在途 PUT 落定后清防抖定时器、
 * 按届时最新快照直发补一笔；主进程预算内 await 整链，完成才放行关窗。
 * 配套：schedulePersist 侧 putInFlight 从「已 resolve 的占位符」改为存真链 Promise
 * （同步占位时序不变，R33D-24 单飞不变式保持——guard finally 只清自己的链）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getGlobalPrefs: vi.fn(),
  putGlobalPrefs: vi.fn(),
}))

import { getGlobalPrefs, putGlobalPrefs } from '../../../src/studio/web-next/src/api/prefs'
import { usePrefsStore } from '../../../src/studio/web-next/src/stores/prefs'

const getGlobalPrefsMock = getGlobalPrefs as ReturnType<typeof vi.fn>
const putGlobalPrefsMock = putGlobalPrefs as ReturnType<typeof vi.fn>

// happy-dom localStorage 在 vitest 集成下缺 clear()，提供 Map-backed 替身（空 = 无迁移数据）
function createLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v)
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
}
const localStorageMock = createLocalStorage()
vi.stubGlobal('localStorage', localStorageMock)

/** 受控 PUT 延迟：每次调用各发一个可手动落定的 deferred */
function makeControlledPut() {
  const pending: Array<(v: { ok: true; revision: number }) => void> = []
  putGlobalPrefsMock.mockImplementation(
    () => new Promise<{ ok: true; revision: number }>((resolve) => pending.push(resolve)),
  )
  return {
    /** 第 n 次（1 基）PUT 成功落定并回传新 revision */
    settle(n: number, revision: number): void {
      const fn = pending[n - 1]
      if (!fn) throw new Error(`PUT #${n} 尚未发起（pending=${pending.length}）`)
      fn({ ok: true, revision })
    },
    calls: () => putGlobalPrefsMock.mock.calls,
  }
}

beforeEach(() => {
  localStorageMock.clear()
  vi.useFakeTimers()
  setActivePinia(createPinia())
  getGlobalPrefsMock.mockReset()
  putGlobalPrefsMock.mockReset()
  getGlobalPrefsMock.mockResolvedValue({ prefs: {}, revision: 0 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('R60-D-1 关窗冲刷在途竞态', () => {
  it('在途 PUT 时冲刷：等其落定后按最新快照补一笔直发，返回真链 Promise', async () => {
    const put = makeControlledPut()
    const prefs = usePrefsStore()
    await prefs.init()

    // 改动一：落防抖窗，推 500ms 让 PUT #1 发起并挂起（快照 = proseSize 20）
    prefs.setSize(20)
    await vi.advanceTimersByTimeAsync(500)
    expect(put.calls()).toHaveLength(1)

    // 在途窗口内改动二（PUT #1 快照之后、防抖 500ms 未到）
    prefs.setThemeValue('dark')

    // 关窗冲刷：旧实现此处空返回（丢改动二的窗口死亡面）；新实现返回在途链 + 补发链
    const flushP = prefs.flushPendingPersist() as unknown
    expect(typeof (flushP as Promise<void>)?.then).toBe('function')

    // 在途 PUT #1 落定（revision 0 → 1）→ 冲刷链恢复：清防抖定时器、按最新快照直发
    put.settle(1, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(put.calls()).toHaveLength(2)

    // 补发笔带届时最新快照（两处改动都在）+ 从 PUT #1 响应对齐的 expectedRevision
    const second = put.calls()[1] as [Record<string, unknown>, number]
    expect(second[0]).toMatchObject({ proseSize: 20, theme: 'dark' })
    expect(second[1]).toBe(1)

    put.settle(2, 2)
    await expect(flushP).resolves.toBeUndefined()
  })

  it('冲刷 Promise 在补发笔落定前不得 resolve（主进程预算内等待的语义锚）', async () => {
    const put = makeControlledPut()
    const prefs = usePrefsStore()
    await prefs.init()

    prefs.setSize(20)
    await vi.advanceTimersByTimeAsync(500) // PUT #1 挂起
    prefs.setCompact(true)

    const flushP = prefs.flushPendingPersist() as Promise<void>
    let settled = false
    void flushP.then(() => {
      settled = true
    })

    put.settle(1, 1) // 在途落定 → 补发笔 PUT #2 挂起中
    await vi.advanceTimersByTimeAsync(0)
    expect(put.calls()).toHaveLength(2)
    expect(settled).toBe(false) // 补发笔未落定，冲刷链不得完

    put.settle(2, 2)
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
  })

  it('无在途 + 防抖窗未到：直发一次最新快照（R58-B-2 原路径不回归）', async () => {
    putGlobalPrefsMock.mockResolvedValue({ ok: true as const, revision: 1 })
    const prefs = usePrefsStore()
    await prefs.init()

    prefs.setSize(20) // 防抖 500ms 未到即关窗
    const flushP = prefs.flushPendingPersist() as Promise<void>
    await vi.advanceTimersByTimeAsync(0)
    expect(putGlobalPrefsMock.mock.calls).toHaveLength(1)
    const [payload] = putGlobalPrefsMock.mock.calls[0] as [Record<string, unknown>]
    expect(payload).toMatchObject({ proseSize: 20 })
    await expect(flushP).resolves.toBeUndefined()
    // 冲刷完成后再改 + 落防抖：单飞照常（不因冲刷链占位卡死后续保存）
    prefs.setThemeValue('dark')
    await vi.advanceTimersByTimeAsync(500)
    expect(putGlobalPrefsMock.mock.calls).toHaveLength(2)
    expect(putGlobalPrefsMock.mock.calls[1]?.[0]).toMatchObject({ theme: 'dark' })
  })

  it('在途落定后不再叠发：冲刷期间防抖定时器被清（单飞不变式 R33D-24 不回归）', async () => {
    const put = makeControlledPut()
    const prefs = usePrefsStore()
    await prefs.init()

    prefs.setSize(20)
    await vi.advanceTimersByTimeAsync(500) // PUT #1 挂起
    prefs.setThemeValue('dark') // 再度武装 500ms 防抖

    const flushP = prefs.flushPendingPersist() as Promise<void>
    put.settle(1, 1)
    await vi.advanceTimersByTimeAsync(0) // 冲刷链接管：清定时器 → 补发笔 #2
    expect(put.calls()).toHaveLength(2)

    put.settle(2, 2)
    await vi.advanceTimersByTimeAsync(0)
    await flushP

    // 防抖定时器已随冲刷清掉：原地推进 500ms 不得冒出第三笔 PUT
    await vi.advanceTimersByTimeAsync(500)
    expect(put.calls()).toHaveLength(2)
  })
})
