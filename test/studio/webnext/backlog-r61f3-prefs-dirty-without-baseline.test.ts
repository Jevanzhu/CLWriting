// @vitest-environment happy-dom
/**
 * R61-F-3（P3）回归：409 恢复在「无已持久化基线」时把全量本地值当本窗修改回放。
 *
 * dirtyKeysOf 首行 `if (!lastPersisted) return Object.keys(local)`——无基线态（init
 * 未完成/未调用，lastPersisted 尚为 null；正常流程 init 各完成路径都置基线）下恢复
 * 走 recoverFromConflict 时把 buildCache 全量键（含未改动的默认值）判为「本窗脏」
 * 回放覆盖远端 + toast「已保留本窗修改」与事实不符。修复：无基线 = 零本窗脏字段，
 * 恢复整体采纳远端（409 恢复其余分支语义不变）。
 *
 * 用例①为修复点（无基线态）；用例②钉住「init 失败（GET reject）完成态」的既有正确
 * 行为——该路径 lastPersisted 已置默认值快照（init else 分支），逐键脏判定仍成立：
 * 远端非默认值采纳、本窗真实改动键保留，不因本修复回归。
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

function conflict409(): ApiError {
  return new ApiError('已在其他窗口被修改', 409)
}

// happy-dom localStorage 在 vitest 集成下缺 clear()，Map-backed 替身（prefs-store.test 同款）
function createLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
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
  vi.clearAllMocks()
  getMock.mockResolvedValue({ prefs: {}, revision: 0 })
  putMock.mockImplementation(async (_p, rev) => ({ ok: true as const, revision: (rev ?? 0) + 1 }))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('R61-F-3: 无持久化基线的 409 恢复——仅采纳远端，默认值不整体回放', () => {
  it('无基线态（init 未完成，lastPersisted=null）改一键触发 PUT 吃 409 → 远端非默认值采纳，本地默认值不整体回放', async () => {
    // 他窗已有配置：proseSize 22 / shelfView list（本窗 refs 此时全是默认值）
    getMock.mockResolvedValue({ prefs: { proseSize: 22, shelfView: 'list' }, revision: 6 })
    putMock.mockImplementationOnce(async () => Promise.reject(conflict409()))

    // 不调 init()：lastPersisted 保持 null（无已持久化基线态）
    const prefs = usePrefsStore()
    prefs.setThemeValue('dark') // 本窗仅这一键触发保存（re-GET 对齐 → PUT → 409 → 恢复链）
    await vi.advanceTimersByTimeAsync(600)
    for (let i = 0; i < 5; i++) await Promise.resolve()

    // 修复点：无基线 = 零本窗脏字段 → 合并整体采纳远端。
    // 修复前 dirtyKeysOf 回 Object.keys(local) 全量判脏：本地默认 proseSize 17 /
    // shelfView 'grid' 当「本窗修改」回放，覆盖他窗配置
    expect(prefs.proseSize).toBe(22)
    expect(prefs.shelfView).toBe('list')
  })

  it('对照：init 失败（GET reject）完成态遇 409 → 远端非默认值采纳 + 本窗真实改动键保留（既有正确行为不回归）', async () => {
    getMock.mockRejectedValueOnce(new Error('down')) // init GET 失败 → else 分支置默认值快照基线
    const prefs = usePrefsStore()
    await prefs.init()
    expect(prefs.proseSize).toBe(17) // init 失败降级默认

    // 他窗配置 proseSize 22；本窗仅真实改动 theme
    getMock.mockResolvedValue({ prefs: { proseSize: 22 }, revision: 6 })
    putMock.mockImplementationOnce(async () => Promise.reject(conflict409()))
    prefs.setThemeValue('dark')
    await vi.advanceTimersByTimeAsync(600)
    for (let i = 0; i < 5; i++) await Promise.resolve()

    expect(prefs.proseSize).toBe(22) // 远端非默认值采纳
    expect(prefs.theme).toBe('dark') // 本窗真实改动键（唯一可判脏键）保留
  })
})
