// @vitest-environment happy-dom
/**
 * R51-H-2（五十一轮）回归：prefs.init 对「200 缺 prefs 字段」的防御。
 *
 * 信封异常（GET /api/library/prefs 返回 200 但无 prefs 字段）时 r.prefs 为 undefined——
 * 旧实现直接赋值，后续 Object.keys(undefined) 抛 TypeError，沿 main.ts mount 前
 * top-level await 冒出，应用整体不挂载（白屏死）。修复后 `?? {}` 兜底为空偏好
 * （逐键守卫全跳过 = 全默认值），与「API 不可达用默认」同口径降级。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getGlobalPrefs: vi.fn(),
  putGlobalPrefs: vi.fn(),
}))

import { getGlobalPrefs, putGlobalPrefs } from '../../../src/studio/web-next/src/api/prefs'
import { usePrefsStore } from '../../../src/studio/web-next/src/stores/prefs'

const getGlobalPrefsMock = getGlobalPrefs as ReturnType<typeof vi.fn>
const putGlobalPrefsMock = putGlobalPrefs as ReturnType<typeof vi.fn>

// happy-dom localStorage 在 vitest 集成下缺 clear()，提供 Map-backed 替身（prefs-store.test 同款）
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
  setActivePinia(createPinia())
  getGlobalPrefsMock.mockReset()
  // 迁移链（空 cache + 旧 localStorage 残值）会发迁移写：GG-P2-7 信封回传 revision
  putGlobalPrefsMock.mockReset()
  putGlobalPrefsMock.mockResolvedValue({ ok: true as const, revision: 1 })
})

describe('R51-H-2: prefs.init 200 缺 prefs 字段', () => {
  it('200 但无 prefs 字段 → init 不抛（旧实现 Object.keys(undefined) TypeError 沿 top-level await 冒出致应用不挂载），回落全默认值', async () => {
    getGlobalPrefsMock.mockResolvedValue({ revision: 7 }) // 信封缺 prefs
    const prefs = usePrefsStore()
    await expect(prefs.init()).resolves.toBeUndefined()
    expect(prefs.theme).toBe('light')
    expect(prefs.proseSize).toBe(17)
    expect(prefs.autosaveInterval).toBe(30)
  })

  it('同信封 + 旧 localStorage 残值 → 走既有「空 cache 即迁移」链，不因缺字段崩溃', async () => {
    localStorageMock.setItem('clw-theme', 'dark')
    getGlobalPrefsMock.mockResolvedValue({ revision: 7 })
    const prefs = usePrefsStore()
    await expect(prefs.init()).resolves.toBeUndefined()
    expect(prefs.theme).toBe('dark')
  })

  it('信封正常（含 prefs）→ 行为不变（守卫不误伤常规加载）', async () => {
    getGlobalPrefsMock.mockResolvedValue({ prefs: { theme: 'dark', proseSize: 19 }, revision: 7 })
    const prefs = usePrefsStore()
    await prefs.init()
    expect(prefs.theme).toBe('dark')
    expect(prefs.proseSize).toBe(19)
  })
})
