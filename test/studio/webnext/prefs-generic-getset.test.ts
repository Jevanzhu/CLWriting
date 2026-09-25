// @vitest-environment happy-dom
/**
 * R0916-7-P3-25：prefs 泛型读写面（get/set）与写 DOM / 窗控变暗副作用 composable 拆出。
 *
 * - 类型面：键拼错 / 值型不符 / 二元键带第三参 → 编译期红（@ts-expect-error 钉死；
 *   typecheck:web-next 的 vue-tsc 覆盖本目录，错键若不报红则 @ts-expect-error 自身报错）
 * - 响应面：get 在 computed 内建立依赖（等价旧 ref 直读的响应语义）
 * - 时序面：init() 在 mount 前即写 data-theme / 紧凑 class / 排版 CSS 变量——
 *   副作用经 usePrefsDomEffects 接线后启动生效点不晚于原实现
 * 语义正本（应用/迁移/守卫/409/书级覆盖）见 prefs-store / r0911 / r35 / r71 等既有文件。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { computed } from 'vue'

vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getGlobalPrefs: vi.fn(),
  putGlobalPrefs: vi.fn(),
}))

import { getGlobalPrefs, putGlobalPrefs } from '../../../src/studio/web-next/src/api/prefs'
import { usePrefsStore } from '../../../src/studio/web-next/src/stores/prefs'

const getGlobalPrefsMock = getGlobalPrefs as ReturnType<typeof vi.fn>
const putGlobalPrefsMock = putGlobalPrefs as ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  getGlobalPrefsMock.mockReset()
  putGlobalPrefsMock.mockReset()
  getGlobalPrefsMock.mockResolvedValue({ prefs: {}, revision: 0 })
  putGlobalPrefsMock.mockResolvedValue({ ok: true as const, revision: 1 })
})

afterEach(() => {
  document.documentElement.className = ''
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('style')
})

describe('R0916-7-P3-25 泛型 set 类型面（编译期断言，运行时只走合法路径）', () => {
  it('合法键/值型 + bookOnly 第三参编译通过且写入生效', () => {
    const p = usePrefsStore()
    p.set('theme', 'dark')
    p.set('proseSize', 20)
    p.set('styleInjection', 'heavy')
    // 写面收窄：checkRepeatThreshold 读面 number|undefined、写面 number
    p.set('checkRepeatThreshold', 0.2)
    // pageWidth / autosaveInterval 带书级覆盖第三参（缺省 false）
    p.set('pageWidth', 800, true)
    p.set('autosaveInterval', 10, false)
    expect(p.get('theme')).toBe('dark')
    expect(p.get('checkRepeatThreshold')).toBe(0.2)
    expect(p.bookPageWidth).toBe(800)
    expect(p.get('autosaveInterval')).toBe(10)
  })

  it('键拼错 / 值型不符 / 二元键带第三参 → 编译期红（@ts-expect-error，运行时不执行）', () => {
    const p = usePrefsStore()
    function typeFaceOnly(): void {
      // @ts-expect-error 键不在 PrefValueMap（拼错键）
      p.set('proseSizeX', 20)
      // @ts-expect-error 值型与键不符（number 键写串）
      p.set('proseSize', '20')
      // @ts-expect-error 二元键不接受 bookOnly 第三参
      p.set('theme', 'dark', true)
      // @ts-expect-error get 键拼错
      p.get('them')
    }
    expect(typeof typeFaceOnly).toBe('function')
  })
})

describe('R0916-7-P3-25 泛型 get 响应面', () => {
  it('get 在 computed 内建立响应依赖（等价旧 ref 直读）', () => {
    const p = usePrefsStore()
    const size = computed(() => p.get('proseSize'))
    expect(size.value).toBe(17)
    p.set('proseSize', 21)
    expect(size.value).toBe(21)
  })
})

describe('R0916-7-P3-25 init 副作用时序（composable 接线不晚于原时序）', () => {
  it('init() 即写 data-theme / 紧凑 class / 排版 CSS 变量（mount 前生效，无启动闪主题）', async () => {
    getGlobalPrefsMock.mockResolvedValue({
      prefs: { theme: 'dark', proseSize: 20, proseLh: 1.7, compact: true, proseFontCn: '思源宋体' },
      revision: 1,
    })
    const prefs = usePrefsStore()
    await prefs.init()
    const root = document.documentElement
    expect(root.dataset.theme).toBe('dark') // applyTheme 经 usePrefsDomEffects
    expect(root.classList.contains('compact')).toBe(true) // applyCompact 经 usePrefsDomEffects
    expect(root.style.getPropertyValue('--prose-size')).toBe('20px') // apply 经 usePrefsDomEffects
    expect(root.style.getPropertyValue('--prose-lh')).toBe('1.7')
    expect(root.style.getPropertyValue('--prose-font')).toContain('思源宋体')
    // baseStep 恒零加数已删：字号档 0 基写合计值，输出与删前逐位一致
    expect(root.style.getPropertyValue('--font-size-step')).toBe('0px')
  })

  it('set 经行副作用族同步写 DOM（side: apply / applyTheme / applyCompact 逐族）', () => {
    const prefs = usePrefsStore()
    prefs.set('proseSize', 22)
    expect(document.documentElement.style.getPropertyValue('--prose-size')).toBe('22px')
    prefs.set('theme', 'dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    prefs.set('compact', true)
    expect(document.documentElement.classList.contains('compact')).toBe(true)
    expect(putGlobalPrefsMock).not.toHaveBeenCalled() // 未到 500ms 防抖
  })
})
