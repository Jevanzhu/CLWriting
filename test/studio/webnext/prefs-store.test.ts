// @vitest-environment happy-dom
/**
 * prefs store 单测（第十轮 P1-TST-1）：偏好应用 / 书级覆盖 / 迁移 / 持久化调度。
 *
 * 覆盖重点：
 * - applyPrefs 类型守卫（非法值忽略）
 * - bookOnly 书级覆盖 > 全局的 effective 计算
 * - setPageWidth(false) 清除书级覆盖
 * - localStorage 迁移（仅首次空 cache）
 * - schedulePersist debounce 写回（vi.useFakeTimers 推进）
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

// happy-dom localStorage 在 vitest 集成下缺 clear()，提供一个完整 Map-backed 替身
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
  getGlobalPrefsMock.mockResolvedValue({})
  putGlobalPrefsMock.mockResolvedValue({})
})

afterEach(() => {
  vi.useRealTimers()
})

describe('prefs: init 从 API 加载', () => {
  it('空 prefs → 保持默认值', async () => {
    getGlobalPrefsMock.mockResolvedValue({})
    const prefs = usePrefsStore()
    await prefs.init()
    expect(prefs.theme).toBe('light')
    expect(prefs.proseSize).toBe(17)
    expect(prefs.shelfView).toBe('grid')
  })

  it('非空 prefs → 应用到 ref', async () => {
    getGlobalPrefsMock.mockResolvedValue({ theme: 'dark', proseSize: 20, shelfView: 'list', chatEnabled: true })
    const prefs = usePrefsStore()
    await prefs.init()
    expect(prefs.theme).toBe('dark')
    expect(prefs.proseSize).toBe(20)
    expect(prefs.shelfView).toBe('list')
    expect(prefs.chatEnabled).toBe(true)
  })

  it('非法值（负数/0/未知主题）→ 忽略用默认', async () => {
    getGlobalPrefsMock.mockResolvedValue({ theme: 'purple', proseSize: 0, pageWidth: -5 } as never)
    const prefs = usePrefsStore()
    await prefs.init()
    expect(prefs.theme).toBe('light')
    expect(prefs.proseSize).toBe(17)
    expect(prefs.pageWidth).toBe(1020)
  })

  it('API 失败 → 降级默认值不抛错', async () => {
    getGlobalPrefsMock.mockRejectedValue(new Error('down'))
    const prefs = usePrefsStore()
    await expect(prefs.init()).resolves.toBeUndefined()
    expect(prefs.theme).toBe('light')
  })
})

describe('prefs: 书级覆盖', () => {
  it('bookOnly=true → 书级覆盖生效（effective 用书级）', () => {
    const prefs = usePrefsStore()
    prefs.setPageWidth(800, true)
    expect(prefs.bookPageWidth).toBe(800)
    expect(prefs.effectivePageWidth).toBe(800)
    expect(prefs.pageWidth).toBe(1020) // 全局不变
  })

  it('bookOnly=false → 写全局 + 清除书级覆盖', () => {
    const prefs = usePrefsStore()
    prefs.setPageWidth(800, true)
    prefs.setPageWidth(900, false)
    expect(prefs.bookPageWidth).toBeNull()
    expect(prefs.pageWidth).toBe(900)
    expect(prefs.effectivePageWidth).toBe(900)
  })

  it('autosaveInterval 同规则', () => {
    const prefs = usePrefsStore()
    prefs.setAutosaveInterval(10, true)
    expect(prefs.effectiveAutosaveInterval).toBe(10)
    prefs.setAutosaveInterval(45, false)
    expect(prefs.effectiveAutosaveInterval).toBe(45)
  })
})

describe('prefs: setter 应用 + 持久化调度', () => {
  it('setThemeValue → 更新 theme + html data-theme + debounce 写回', () => {
    const prefs = usePrefsStore()
    prefs.setThemeValue('dark')
    expect(prefs.theme).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(putGlobalPrefsMock).not.toHaveBeenCalled() // 未到 500ms
    vi.advanceTimersByTime(600)
    expect(putGlobalPrefsMock).toHaveBeenCalledTimes(1)
    expect(putGlobalPrefsMock).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }))
  })

  it('多次 setter 合并为一次写回（debounce）', () => {
    const prefs = usePrefsStore()
    prefs.setSize(18)
    prefs.setLh(2.0)
    prefs.setGap(1.5)
    expect(putGlobalPrefsMock).not.toHaveBeenCalled()
    vi.advanceTimersByTime(600)
    expect(putGlobalPrefsMock).toHaveBeenCalledTimes(1)
  })

  it('setSize → apply() 写 CSS 变量', () => {
    const prefs = usePrefsStore()
    prefs.setSize(20)
    expect(document.documentElement.style.getPropertyValue('--prose-size')).toBe('20px')
  })

  it('字体 setter → buildFontFamily 拼入 CSS 变量', () => {
    const prefs = usePrefsStore()
    prefs.setUiFontCn('思源宋体')
    prefs.setUiFontEn('Inter')
    const v = document.documentElement.style.getPropertyValue('--font-ui')
    expect(v).toContain('Inter')
    expect(v).toContain('思源宋体')
  })
})

describe('prefs: localStorage 迁移', () => {
  it('空 API prefs + 有旧 localStorage → 迁移并写回', async () => {
    localStorage.setItem('clw-theme', 'dark')
    localStorage.setItem('clw.proseSize', '19')
    getGlobalPrefsMock.mockResolvedValue({})
    const prefs = usePrefsStore()
    await prefs.init()
    expect(prefs.theme).toBe('dark')
    expect(prefs.proseSize).toBe(19)
    expect(putGlobalPrefsMock).toHaveBeenCalled()
  })

  it('API 已有值 + 有旧 localStorage → 不迁移（API 优先）', async () => {
    localStorage.setItem('clw-theme', 'dark')
    getGlobalPrefsMock.mockResolvedValue({ theme: 'light' })
    const prefs = usePrefsStore()
    await prefs.init()
    expect(prefs.theme).toBe('light')
    expect(putGlobalPrefsMock).not.toHaveBeenCalled()
  })

  it('无旧 localStorage → 不迁移不写回', async () => {
    getGlobalPrefsMock.mockResolvedValue({})
    const prefs = usePrefsStore()
    await prefs.init()
    expect(putGlobalPrefsMock).not.toHaveBeenCalled()
  })
})

describe('prefs: 紧凑模式', () => {
  it('setCompact → html.compact class 切换', () => {
    const prefs = usePrefsStore()
    prefs.setCompact(true)
    expect(document.documentElement.classList.contains('compact')).toBe(true)
    prefs.setCompact(false)
    expect(document.documentElement.classList.contains('compact')).toBe(false)
  })
})
