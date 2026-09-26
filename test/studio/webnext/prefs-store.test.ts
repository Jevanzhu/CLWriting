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
  // GG-P2-7 信封：GET 返回 { prefs, revision }，PUT 回传自增后 revision
  getGlobalPrefsMock.mockResolvedValue({ prefs: {}, revision: 0 })
  putGlobalPrefsMock.mockResolvedValue({ ok: true as const, revision: 1 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('prefs: init 从 API 加载', () => {
  it('空 prefs → 保持默认值', async () => {
    getGlobalPrefsMock.mockResolvedValue({ prefs: {}, revision: 0 })
    const prefs = usePrefsStore()
    await prefs.init()
    expect(prefs.get('theme')).toBe('light')
    expect(prefs.get('proseSize')).toBe(17)
    expect(prefs.get('shelfView')).toBe('grid')
  })

  it('非空 prefs → 应用到 ref', async () => {
    getGlobalPrefsMock.mockResolvedValue({
      prefs: { theme: 'dark', proseSize: 20, shelfView: 'list', chatEnabled: true },
      revision: 3,
    })
    const prefs = usePrefsStore()
    await prefs.init()
    expect(prefs.get('theme')).toBe('dark')
    expect(prefs.get('proseSize')).toBe(20)
    expect(prefs.get('shelfView')).toBe('list')
    expect(prefs.get('chatEnabled')).toBe(true)
  })

  it('非法值（负数/0/未知主题）→ 忽略用默认', async () => {
    getGlobalPrefsMock.mockResolvedValue({
      prefs: { theme: 'purple', proseSize: 0, pageWidth: -5 } as never,
      revision: 0,
    })
    const prefs = usePrefsStore()
    await prefs.init()
    expect(prefs.get('theme')).toBe('light')
    expect(prefs.get('proseSize')).toBe(17)
    expect(prefs.get('pageWidth')).toBe(1020)
  })

  it('API 失败 → 降级默认值不抛错', async () => {
    getGlobalPrefsMock.mockRejectedValue(new Error('down'))
    const prefs = usePrefsStore()
    await expect(prefs.init()).resolves.toBeUndefined()
    expect(prefs.get('theme')).toBe('light')
  })
})

describe('prefs: 书级覆盖', () => {
  it('bookOnly=true → 书级覆盖生效（effective 用书级）', () => {
    const prefs = usePrefsStore()
    prefs.set('pageWidth', 800, true)
    expect(prefs.bookPageWidth).toBe(800)
    expect(prefs.effectivePageWidth).toBe(800)
    expect(prefs.get('pageWidth')).toBe(1020) // 全局不变
  })

  it('bookOnly=false → 写全局 + 清除书级覆盖', () => {
    const prefs = usePrefsStore()
    prefs.set('pageWidth', 800, true)
    prefs.set('pageWidth', 900, false)
    expect(prefs.bookPageWidth).toBeNull()
    expect(prefs.get('pageWidth')).toBe(900)
    expect(prefs.effectivePageWidth).toBe(900)
  })

  it('autosaveInterval 同规则', () => {
    const prefs = usePrefsStore()
    prefs.set('autosaveInterval', 10, true)
    expect(prefs.effectiveAutosaveInterval).toBe(10)
    prefs.set('autosaveInterval', 45, false)
    expect(prefs.effectiveAutosaveInterval).toBe(45)
  })
})

describe('prefs: setter 应用 + 持久化调度', () => {
  it('setThemeValue → 更新 theme + html data-theme + debounce 写回', async () => {
    const prefs = usePrefsStore()
    prefs.set('theme', 'dark')
    expect(prefs.get('theme')).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(putGlobalPrefsMock).not.toHaveBeenCalled() // 未到 500ms
    await vi.advanceTimersByTimeAsync(600)
    expect(putGlobalPrefsMock).toHaveBeenCalledTimes(1)
    // 未 init 的实例 revision 初值 0 —— PUT 第二参带 expectedRevision（GG-P2-7）
    expect(putGlobalPrefsMock).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }), 0)
  })

  it('多次 setter 合并为一次写回（debounce）', async () => {
    const prefs = usePrefsStore()
    prefs.set('proseSize', 18)
    prefs.set('proseLh', 2.0)
    expect(putGlobalPrefsMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(600)
    expect(putGlobalPrefsMock).toHaveBeenCalledTimes(1)
  })

  it('setSize → apply() 写 CSS 变量（全局正文排版：--prose-* 作用于所有正文编辑框）', () => {
    const prefs = usePrefsStore()
    prefs.set('proseSize', 20)
    expect(document.documentElement.style.getPropertyValue('--prose-size')).toBe('20px')
  })

  it('字体 setter → buildFontFamily 拼入 CSS 变量', () => {
    const prefs = usePrefsStore()
    prefs.set('uiFontCn', '思源宋体')
    prefs.set('uiFontEn', 'Inter')
    const v = document.documentElement.style.getPropertyValue('--font-ui')
    expect(v).toContain('Inter')
    expect(v).toContain('思源宋体')
  })
})

describe('prefs: localStorage 迁移', () => {
  it('空 API prefs + 有旧 localStorage → 迁移并写回', async () => {
    localStorage.setItem('clw-theme', 'dark')
    localStorage.setItem('clw.proseSize', '19')
    getGlobalPrefsMock.mockResolvedValue({ prefs: {}, revision: 0 })
    const prefs = usePrefsStore()
    await prefs.init()
    expect(prefs.get('theme')).toBe('dark')
    expect(prefs.get('proseSize')).toBe(19)
    expect(putGlobalPrefsMock).toHaveBeenCalled()
  })

  it('API 已有值 + 有旧 localStorage → 不迁移（API 优先）', async () => {
    localStorage.setItem('clw-theme', 'dark')
    getGlobalPrefsMock.mockResolvedValue({ prefs: { theme: 'light' }, revision: 0 })
    const prefs = usePrefsStore()
    await prefs.init()
    expect(prefs.get('theme')).toBe('light')
    expect(putGlobalPrefsMock).not.toHaveBeenCalled()
  })

  it('无旧 localStorage → 不迁移不写回', async () => {
    getGlobalPrefsMock.mockResolvedValue({ prefs: {}, revision: 0 })
    const prefs = usePrefsStore()
    await prefs.init()
    expect(putGlobalPrefsMock).not.toHaveBeenCalled()
  })
})

describe('prefs: 紧凑模式', () => {
  it('setCompact → html.compact class 切换', () => {
    const prefs = usePrefsStore()
    prefs.set('compact', true)
    expect(document.documentElement.classList.contains('compact')).toBe(true)
    prefs.set('compact', false)
    expect(document.documentElement.classList.contains('compact')).toBe(false)
  })
})

describe('prefs: 书级设定全局托底 13 键（clamp / 持久化 / 回读守卫）', () => {
  it('空 prefs → 保持硬编码回落初值（消费者直接读 ref 即回落）', async () => {
    getGlobalPrefsMock.mockResolvedValue({ prefs: {}, revision: 0 })
    const prefs = usePrefsStore()
    await prefs.init()
    expect(prefs.get('defaultGenre')).toBe('')
    expect(prefs.get('defaultVolumeSize')).toBe(50)
    expect(prefs.get('defaultTargetWords')).toBe(0)
    expect(prefs.get('defaultChapterTargetWords')).toBe(0)
    expect(prefs.get('defaultShortStrict')).toBe(false)
    expect(prefs.get('styleInjection')).toBe('light')
    expect(prefs.get('autoConfirmOutline')).toBe(false)
    expect(prefs.get('aiBatchSize')).toBe(8)
    expect(prefs.get('callsPerChapter')).toBe(8)
    expect(prefs.get('relationAutoMine')).toBe(false)
    expect(prefs.get('relationMineThreshold')).toBe(3)
    expect(prefs.get('ragEnabled')).toBe(false)
    expect(prefs.get('ragProvider')).toBe('')
  })

  it('13 键全设 → 逐键应用到 ref', async () => {
    getGlobalPrefsMock.mockResolvedValue({
      prefs: {
        defaultGenre: '玄幻',
        defaultVolumeSize: 30,
        defaultTargetWords: 2_000_000,
        defaultChapterTargetWords: 3000,
        defaultShortStrict: true,
        styleInjection: 'heavy',
        autoConfirmOutline: true,
        autoBatchSize: 5,
        callsPerChapter: 12,
        relationAutoMine: true,
        relationMineThreshold: 6,
        ragEnabled: true,
        ragProvider: 'rag-a',
      },
      revision: 2,
    })
    const prefs = usePrefsStore()
    await prefs.init()
    expect(prefs.get('defaultGenre')).toBe('玄幻')
    expect(prefs.get('defaultVolumeSize')).toBe(30)
    expect(prefs.get('defaultTargetWords')).toBe(2_000_000)
    expect(prefs.get('defaultChapterTargetWords')).toBe(3000)
    expect(prefs.get('defaultShortStrict')).toBe(true)
    expect(prefs.get('styleInjection')).toBe('heavy')
    expect(prefs.get('autoConfirmOutline')).toBe(true)
    expect(prefs.get('aiBatchSize')).toBe(5)
    expect(prefs.get('callsPerChapter')).toBe(12)
    expect(prefs.get('relationAutoMine')).toBe(true)
    expect(prefs.get('relationMineThreshold')).toBe(6)
    expect(prefs.get('ragEnabled')).toBe(true)
    expect(prefs.get('ragProvider')).toBe('rag-a')
  })

  it('回读守卫：类型/枚举/范围非法值忽略，保持回落', async () => {
    getGlobalPrefsMock.mockResolvedValue({
      prefs: {
        defaultGenre: '   ', // 空白串 = 未设
        defaultVolumeSize: 3, // < 5 越界
        defaultTargetWords: -5, // 负数
        defaultChapterTargetWords: 0, // JSON 层只存正整数（0=未设由 ref 初值表达）
        defaultShortStrict: 'yes', // 类型错
        styleInjection: 'x', // 枚举外
        autoConfirmOutline: 1,
        autoBatchSize: 0,
        callsPerChapter: -1,
        relationAutoMine: 'on',
        relationMineThreshold: 0,
        ragEnabled: 1,
        ragProvider: 42,
      } as never,
    })
    const prefs = usePrefsStore()
    await prefs.init()
    expect(prefs.get('defaultGenre')).toBe('')
    expect(prefs.get('defaultVolumeSize')).toBe(50)
    expect(prefs.get('defaultTargetWords')).toBe(0)
    expect(prefs.get('defaultChapterTargetWords')).toBe(0)
    expect(prefs.get('defaultShortStrict')).toBe(false)
    expect(prefs.get('styleInjection')).toBe('light')
    expect(prefs.get('autoConfirmOutline')).toBe(false)
    expect(prefs.get('aiBatchSize')).toBe(8)
    expect(prefs.get('callsPerChapter')).toBe(8)
    expect(prefs.get('relationAutoMine')).toBe(false)
    expect(prefs.get('relationMineThreshold')).toBe(3)
    expect(prefs.get('ragEnabled')).toBe(false)
    expect(prefs.get('ragProvider')).toBe('')
  })

  it('setter clamp：每卷 5-500 / 批量 1-20 / 上限 1-50 / 阈值 1-20 / 字数 0 或正整数 / 文本 trim', () => {
    const prefs = usePrefsStore()
    prefs.set('defaultGenre', '  都市 ')
    expect(prefs.get('defaultGenre')).toBe('都市')
    prefs.set('defaultVolumeSize', 2)
    expect(prefs.get('defaultVolumeSize')).toBe(5)
    prefs.set('defaultVolumeSize', 999)
    expect(prefs.get('defaultVolumeSize')).toBe(500)
    prefs.set('defaultTargetWords', -3)
    expect(prefs.get('defaultTargetWords')).toBe(0)
    prefs.set('defaultTargetWords', 1234.6)
    expect(prefs.get('defaultTargetWords')).toBe(1235)
    prefs.set('defaultChapterTargetWords', 3000.4)
    expect(prefs.get('defaultChapterTargetWords')).toBe(3000)
    prefs.set('aiBatchSize', 0)
    expect(prefs.get('aiBatchSize')).toBe(1)
    prefs.set('aiBatchSize', 99)
    expect(prefs.get('aiBatchSize')).toBe(20)
    prefs.set('callsPerChapter', 0)
    expect(prefs.get('callsPerChapter')).toBe(1)
    prefs.set('callsPerChapter', 99)
    expect(prefs.get('callsPerChapter')).toBe(50)
    prefs.set('relationMineThreshold', 0)
    expect(prefs.get('relationMineThreshold')).toBe(1)
    prefs.set('relationMineThreshold', 99)
    expect(prefs.get('relationMineThreshold')).toBe(20)
    prefs.set('ragProvider', ' rag-b ')
    expect(prefs.get('ragProvider')).toBe('rag-b')
    prefs.set('defaultShortStrict', true)
    prefs.set('styleInjection', 'heavy')
    prefs.set('relationAutoMine', true)
    prefs.set('ragEnabled', true)
    expect(prefs.get('defaultShortStrict')).toBe(true)
    expect(prefs.get('styleInjection')).toBe('heavy')
    expect(prefs.get('relationAutoMine')).toBe(true)
    expect(prefs.get('ragEnabled')).toBe(true)
  })

  it('setter 走防抖持久化：buildCache 全量带上 13 键（JSON 键名 autoBatchSize 等）', async () => {
    const prefs = usePrefsStore()
    prefs.set('defaultGenre', '都市')
    prefs.set('defaultVolumeSize', 40)
    prefs.set('defaultTargetWords', 1_500_000)
    prefs.set('defaultChapterTargetWords', 2500)
    prefs.set('defaultShortStrict', true)
    prefs.set('styleInjection', 'heavy')
    prefs.set('autoConfirmOutline', true)
    prefs.set('aiBatchSize', 6)
    prefs.set('callsPerChapter', 15)
    prefs.set('relationAutoMine', true)
    prefs.set('relationMineThreshold', 5)
    prefs.set('ragEnabled', true)
    prefs.set('ragProvider', 'rag-a')
    expect(putGlobalPrefsMock).not.toHaveBeenCalled() // 未到 500ms
    await vi.advanceTimersByTimeAsync(600)
    expect(putGlobalPrefsMock).toHaveBeenCalledTimes(1)
    // 未 init 的实例 revision 初值 0 —— PUT 第二参带 expectedRevision（GG-P2-7）
    expect(putGlobalPrefsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultGenre: '都市',
        defaultVolumeSize: 40,
        defaultTargetWords: 1_500_000,
        defaultChapterTargetWords: 2500,
        defaultShortStrict: true,
        styleInjection: 'heavy',
        autoConfirmOutline: true,
        autoBatchSize: 6,
        callsPerChapter: 15,
        relationAutoMine: true,
        relationMineThreshold: 5,
        ragEnabled: true,
        ragProvider: 'rag-a',
      }),
      0,
    )
  })

  it('多次 setter 合并为一次写回（debounce，同 snapDays 先例）', async () => {
    const prefs = usePrefsStore()
    prefs.set('aiBatchSize', 9)
    prefs.set('callsPerChapter', 20)
    prefs.set('relationMineThreshold', 7)
    expect(putGlobalPrefsMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(600)
    expect(putGlobalPrefsMock).toHaveBeenCalledTimes(1)
  })
})
