// @vitest-environment happy-dom
/**
 * R0917-6-P3-3（2026-09-17 全库源码重评六轮修复批）：防抖 fire 后句柄置空——关窗空写
 * 回归门。
 *
 * 缺陷形态：schedulePersist 的 setTimeout 回调执行后不置 `persistTimer = null`，句柄
 * 恒非 null；而 flushPendingPersist 以 `!persistTimer` 作「无待写」判据（重评-0914-三轮
 * P3-8 立的守卫）——「保存过一次」的窗每次关窗仍发一次同值 PUT：服务端无条件 bump
 * revision（其他存活窗下次保存伪 409 +「已在其他窗口被修改」误导 toast）。
 *
 * 本门钉两条：
 * ① fire 后关窗不再空写（新守卫语义）；
 * ② fire 出去的在途链仍被关窗等待（R60-D-1 的 await 语义不因守卫而缩短）。
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

describe('R0917-6-P3-3：防抖 fire 后关窗不空写', () => {
  it('写过一次并已落盘 → 再关窗不发 PUT（fire 分支已置空句柄）', async () => {
    putGlobalPrefsMock.mockResolvedValue({ ok: true as const, revision: 1 })
    const prefs = usePrefsStore()
    await prefs.init()

    prefs.set('proseSize', 24)
    await vi.advanceTimersByTimeAsync(600) // 防抖 fire → PUT #1 完成落盘
    expect(putGlobalPrefsMock.mock.calls).toHaveLength(1)

    // 关窗：改为「无待写即直返回」——修复前此处仍会发同值 PUT #2（服务端 revision 空 bump）
    await prefs.flushPendingPersist()
    await vi.advanceTimersByTimeAsync(600)
    expect(putGlobalPrefsMock.mock.calls).toHaveLength(1)
  })

  it('fire 出去的在途链仍被关窗等待（守卫不缩短 R60-D-1 的 await 语义）', async () => {
    // 让 PUT 挂着：fire 后立即关窗，此时在途链未落定
    // 持在对象属性上：闭包内赋值不会被 TS 控制流窄化成 null（裸 let 会在下方调用点报 never）
    const pending: { resolve: ((v: { ok: true; revision: number }) => void) | null } = { resolve: null }
    putGlobalPrefsMock.mockImplementation(
      () => new Promise<{ ok: true; revision: number }>((resolve) => { pending.resolve = resolve }),
    )
    const prefs = usePrefsStore()
    await prefs.init()

    prefs.set('proseSize', 26)
    await vi.advanceTimersByTimeAsync(500) // 防抖 fire → PUT 发出并挂起
    expect(putGlobalPrefsMock.mock.calls).toHaveLength(1)

    const flushP = prefs.flushPendingPersist()
    let settled = false
    void flushP.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false) // 在途未落定 → 关窗链不得完（否则窗口销毁即夭折写入）

    pending.resolve?.({ ok: true, revision: 7 })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
    expect(putGlobalPrefsMock.mock.calls).toHaveLength(1) // 且不因等待而补发第二笔
  })

  it('防抖窗未到（尚未 fire）→ 关窗照旧直发一次（R58-B-2 原路径不回归）', async () => {
    putGlobalPrefsMock.mockResolvedValue({ ok: true as const, revision: 1 })
    const prefs = usePrefsStore()
    await prefs.init()

    prefs.set('theme', 'dark') // 500ms 未到即关窗
    await prefs.flushPendingPersist()
    await vi.advanceTimersByTimeAsync(0)
    expect(putGlobalPrefsMock.mock.calls).toHaveLength(1)
    expect(putGlobalPrefsMock.mock.calls[0]?.[0]).toMatchObject({ theme: 'dark' })

    // 冲刷后再改 + 落防抖：单飞照常
    prefs.set('proseSize', 30)
    await vi.advanceTimersByTimeAsync(600)
    expect(putGlobalPrefsMock.mock.calls).toHaveLength(2)
  })
})