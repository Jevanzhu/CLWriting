// @vitest-environment happy-dom
/**
 * 2026-09-08（作者反馈「字体下拉首开很慢，特别是第一次」）：字体表启动预热回归。
 *
 * 根因：win 枚举走 PowerShell + Add-Type PresentationCore（秒级），此前等首个消费
 * 组件挂载（设置弹窗外观页 / 专注排版条）才发 IPC，首次打开字体下拉要现场等枚举。
 * 修法：渲染入口启动后台预热（main.ts 接线延迟 3s，入口文件不进测），本文件锁
 * useSystemFonts 暴露的 prewarmSystemFonts 语义：
 * ① 有 bridge 即发 IPC，列表与 fontsLoaded 就位（首开不再现场等枚举）；
 * ② R48-84 在途去重保持——预热在途时重复调用共享同一 Promise，IPC 只跑一次；
 * ③ 失败清 pending 保留「下次可重试」原语义、fontsLoaded 不置位、console.error 留痕；
 * ④ 浏览器版（无 desktop bridge）no-op 不抛错。
 *
 * 模块级单例（systemFonts/fontsPending）跨用例共享，vi.resetModules + 动态 import
 * 逐用例取新模块态。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

type FontsBridge = { getSystemFonts: () => Promise<string[]> }

async function importFresh(): Promise<
  typeof import('../../../src/studio/web-next/src/composables/useSystemFonts')
> {
  vi.resetModules()
  return await import('../../../src/studio/web-next/src/composables/useSystemFonts')
}

const WIN = (window as unknown as { clwritingDesktop?: FontsBridge })

let bridge: FontsBridge
let savedDesktop: FontsBridge | undefined

beforeEach(() => {
  savedDesktop = WIN.clwritingDesktop
  bridge = { getSystemFonts: vi.fn(() => Promise.resolve(['Microsoft YaHei', 'SimSun'])) }
  WIN.clwritingDesktop = bridge
})

afterEach(() => {
  WIN.clwritingDesktop = savedDesktop
  vi.restoreAllMocks()
})

describe('字体表启动预热（prewarmSystemFonts）', () => {
  it('① 有 bridge 即发 IPC：列表与 fontsLoaded 就位，消费侧零追加调用', async () => {
    const m = await importFresh()
    await m.prewarmSystemFonts()
    expect(bridge.getSystemFonts).toHaveBeenCalledTimes(1)
    const { systemFonts, fontsLoaded } = m.useSystemFonts()
    expect(systemFonts.value).toEqual(['Microsoft YaHei', 'SimSun'])
    expect(fontsLoaded.value).toBe(true)
  })

  it('② R48-84 去重保持：预热在途时重复调用共享同一在途 Promise，IPC 只跑一次', async () => {
    let resolveList: (v: string[]) => void = () => {}
    bridge.getSystemFonts = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          resolveList = resolve
        }),
    )
    const m = await importFresh()
    const p1 = m.prewarmSystemFonts()
    const p2 = m.prewarmSystemFonts()
    expect(bridge.getSystemFonts).toHaveBeenCalledTimes(1)
    resolveList(['SimHei'])
    await Promise.all([p1, p2])
    expect(m.useSystemFonts().systemFonts.value).toEqual(['SimHei'])
    expect(bridge.getSystemFonts).toHaveBeenCalledTimes(1)
  })

  it('③ 失败：Promise 不 reject、清 pending 可重试、fontsLoaded 不置位、console.error 留痕', async () => {
    let fail = true
    bridge.getSystemFonts = vi.fn(() =>
      fail ? Promise.reject(new Error('boom')) : Promise.resolve(['KaiTi']),
    )
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const m = await importFresh()
    await expect(m.prewarmSystemFonts()).resolves.toBeUndefined()
    expect(m.useSystemFonts().fontsLoaded.value).toBe(false)
    expect(errSpy).toHaveBeenCalled()
    // pending 已清 → 下次调用重新探测（原「下次挂载可重试」语义）
    fail = false
    await m.prewarmSystemFonts()
    expect(bridge.getSystemFonts).toHaveBeenCalledTimes(2)
    expect(m.useSystemFonts().systemFonts.value).toEqual(['KaiTi'])
    expect(m.useSystemFonts().fontsLoaded.value).toBe(true)
  })

  it('④ 浏览器版（无 desktop bridge）：no-op 不抛错、fontsLoaded 不置位', async () => {
    WIN.clwritingDesktop = undefined
    const m = await importFresh()
    await expect(m.prewarmSystemFonts()).resolves.toBeUndefined()
    expect(m.useSystemFonts().fontsLoaded.value).toBe(false)
  })
})
