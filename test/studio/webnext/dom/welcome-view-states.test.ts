/**
 * Welcome 起始页桌面桥形态族（happy-dom）：浏览器降级 / 有桥最近列表 / 取数失败与重试 /
 * 入口与最近项两路 IPC。
 *
 * 本页的形态分叉全挂在桌面桥上：usePlatform 在模块求值期快照
 * window.clwritingDesktop.platform（故桥有无经模块 mock 表达），最近列表与入口按钮
 * 直接走 window.clwritingDesktop 真调用。断言锚 DOM 可观察面（渲染文本 / title 属性 /
 * 桥调用计数）与 ui store 的 toast 面——click 流与 e2e 的浏览器形态分层互补，此处只做
 * 单元层等价锚：挂载期拉取恰好一次、重试真的重发、失败不夺走主入口可用性。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// 平台判定在 usePlatform 模块求值时快照 window.clwritingDesktop——浏览器/桌面两形态
// 经本持有者对切（真读桥会因快照时机而无法在同档内切换形态）
const platform = vi.hoisted(() => ({ isDesktop: true, isMac: true }))

vi.mock('../../../../src/studio/web-next/src/composables/usePlatform', () => ({
  usePlatform: () => ({
    isDesktop: platform.isDesktop,
    platform: platform.isDesktop ? (platform.isMac ? 'darwin' : 'win32') : null,
    isMac: platform.isMac,
    isWin: platform.isDesktop && !platform.isMac,
  }),
}))

import Welcome from '../../../../src/studio/web-next/src/pages/Welcome.vue'
import { useUiStore } from '../../../../src/studio/web-next/src/stores/ui'

const RECENTS = [
  { path: '/libs/长篇甲', label: '长篇甲' },
  { path: '/libs/短篇乙', label: '短篇乙' },
]

type RecentRow = { path: string; label: string }
type OpenLibraryResult = { ok: true } | { ok: false; canceled: true } | { ok: false; reason: string }
type SwitchLibraryResult = { ok: true } | { ok: false; reason: string }

interface BridgeStub {
  getRecentLibraries: ReturnType<typeof vi.fn<() => Promise<RecentRow[]>>>
  openLibrary: ReturnType<typeof vi.fn<() => Promise<OpenLibraryResult>>>
  switchLibrary: ReturnType<typeof vi.fn<(p: string) => Promise<SwitchLibraryResult>>>
}

/** 桌面桥桩（最小面：本页只消费 platform / getRecentLibraries / openLibrary / switchLibrary） */
function installBridge(recents: RecentRow[] = []): BridgeStub {
  const getRecentLibraries = vi.fn(async (): Promise<RecentRow[]> => recents)
  const openLibrary = vi.fn(async (): Promise<OpenLibraryResult> => ({ ok: true }))
  const switchLibrary = vi.fn(async (_p: string): Promise<SwitchLibraryResult> => ({ ok: true }))
  ;(window as unknown as Record<string, unknown>).clwritingDesktop = {
    platform: 'darwin',
    getRecentLibraries,
    openLibrary,
    switchLibrary,
  }
  return { getRecentLibraries, openLibrary, switchLibrary }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  platform.isDesktop = true
  platform.isMac = true
})

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).clwritingDesktop
})

describe('Welcome 起始页：桌面桥形态', () => {
  it('浏览器形态（无桌面桥）→ 整块降级文案，桌面入口与最近区都不渲染', async () => {
    platform.isDesktop = false
    platform.isMac = false
    const w = mount(Welcome)
    await flushPromises()

    expect(w.find('.welcome').classes()).not.toContain('is-desktop')
    expect(w.find('.entries .no-desktop').text()).toBe('书库管理仅在桌面版可用。请使用 CLWriting 桌面应用启动。')
    expect(w.findAll('.entry')).toHaveLength(0)
    expect(w.find('.recent').exists()).toBe(false)
  })

  it('桌面桥：最近列表按 IPC 返回值渲染，挂载期只拉一次；mac 态页根带 has-traffic', async () => {
    const { getRecentLibraries } = installBridge(RECENTS)
    const w = mount(Welcome)
    await flushPromises()

    expect(getRecentLibraries).toHaveBeenCalledTimes(1)
    expect(w.find('.welcome').classes()).toEqual(expect.arrayContaining(['is-desktop', 'has-traffic']))
    expect(w.find('.recent-title').text()).toContain('最近打开')
    expect(w.findAll('.recent-item')).toHaveLength(RECENTS.length)
    expect(w.findAll('.recent-label').map((n) => n.text())).toEqual(['长篇甲', '短篇乙'])
    // 路径全文进 title 属性（窄列省略时可悬停核对全文）+ 列表不取代新建/打开主入口
    expect(w.findAll('.recent-path')[0]!.attributes('title')).toBe(RECENTS[0]!.path)
    expect(w.find('.entries .no-desktop').exists()).toBe(false)
    expect(w.find('.entry.primary').exists()).toBe(true)
  })

  it('取数失败 → 错误态 + 重试出口，主入口保持可用；重试重新发起并恢复列表', async () => {
    const { getRecentLibraries } = installBridge(RECENTS)
    getRecentLibraries.mockRejectedValueOnce(new Error('桥桩：最近书库读取失败'))
    const w = mount(Welcome)
    await flushPromises()

    expect(w.find('.recent .no-desktop').text()).toBe('最近书库加载失败：桥桩：最近书库读取失败')
    expect(w.find('.retry-btn').exists()).toBe(true)
    expect(w.find('.recent-list').exists()).toBe(false)
    expect(w.find('.entry.primary').exists()).toBe(true) // 主入口不依赖该数据
    expect(getRecentLibraries).toHaveBeenCalledTimes(1)

    await w.find('.retry-btn').trigger('click')
    await flushPromises()
    expect(getRecentLibraries).toHaveBeenCalledTimes(2)
    expect(w.findAll('.recent-item')).toHaveLength(RECENTS.length)
    expect(w.find('.retry-btn').exists()).toBe(false)
    expect(w.find('.recent .no-desktop').exists()).toBe(false)
  })

  it('重试再失败 → 错误态以新消息留存（不静默吞、不留「加载中」死相）', async () => {
    const { getRecentLibraries } = installBridge(RECENTS)
    getRecentLibraries.mockRejectedValueOnce(new Error('首次失败')).mockRejectedValueOnce(new Error('重试仍失败'))
    const w = mount(Welcome)
    await flushPromises()

    await w.find('.retry-btn').trigger('click')
    await flushPromises()
    expect(w.find('.recent .no-desktop').text()).toBe('最近书库加载失败：重试仍失败')
    expect(w.find('.retry-btn').exists()).toBe(true)
    expect(w.findAll('.recent-item')).toHaveLength(0)
  })

  it('抛非 Error（桥层字符串拒绝）→ 原文串出错误态，不落「undefined」或空行', async () => {
    const { getRecentLibraries } = installBridge(RECENTS)
    getRecentLibraries.mockRejectedValueOnce('桥桩：通道被销毁')
    const w = mount(Welcome)
    await flushPromises()

    expect(w.find('.recent .no-desktop').text()).toBe('最近书库加载失败：桥桩：通道被销毁')
    expect(w.find('.retry-btn').exists()).toBe(true)
  })

  it('新建/打开入口 → 同一 IPC；失败经 rawErrorMessage 原样落 error toast', async () => {
    const { openLibrary } = installBridge()
    const ui = useUiStore()
    const w = mount(Welcome)
    await flushPromises()

    await w.find('.entry.primary').trigger('click')
    await flushPromises()
    await w.findAll('.entry')[1]!.trigger('click')
    await flushPromises()
    expect(openLibrary).toHaveBeenCalledTimes(2) // 两入口共用 chooseLibrary
    expect(ui.toasts).toHaveLength(0) // 成功静默

    openLibrary.mockRejectedValueOnce(new Error('IPC 通道断开'))
    await w.findAll('.entry')[0]!.trigger('click')
    await flushPromises()
    expect(ui.toasts.map((t) => [t.msg, t.kind])).toEqual([['IPC 通道断开', 'error']])
  })

  it('最近项点击 → switchLibrary(该行路径)；失败信封与抛错都落 error toast', async () => {
    const { switchLibrary } = installBridge(RECENTS)
    const ui = useUiStore()
    const w = mount(Welcome)
    await flushPromises()

    await w.findAll('.recent-item')[0]!.trigger('click')
    await flushPromises()
    expect(switchLibrary).toHaveBeenLastCalledWith(RECENTS[0]!.path)
    expect(ui.toasts).toHaveLength(0)

    switchLibrary.mockResolvedValueOnce({ ok: false, reason: '目标库被占用' })
    await w.findAll('.recent-item')[1]!.trigger('click')
    await flushPromises()
    expect(switchLibrary).toHaveBeenLastCalledWith(RECENTS[1]!.path)
    expect(ui.toasts.map((t) => [t.msg, t.kind])).toEqual([['目标库被占用', 'error']])

    switchLibrary.mockRejectedValueOnce(new Error('IPC 通道断开'))
    await w.findAll('.recent-item')[0]!.trigger('click')
    await flushPromises()
    expect(ui.toasts.map((t) => t.msg)).toEqual(['目标库被占用', 'IPC 通道断开'])
  })
})
