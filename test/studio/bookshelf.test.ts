// @vitest-environment happy-dom
/**
 * Bookshelf 书架组件测（桌面化批4）：验证 isDesktop 控制桌面入口渲染。
 *
 * 桌面版（window.clwritingDesktop 存在）→ 渲染「打开书库」+ 最近下拉 + 当前书库名；
 * 浏览器版（不存在）→ 隐藏桌面入口，仅书列表。
 * mock vue-router（根 vitest 不 resolve 前端 vue-router 包）+ fetch + window.clwritingDesktop。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const pushMock = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushMock }),
}))

const fetchMock = vi.fn()
globalThis.fetch = fetchMock as unknown as typeof fetch

import Bookshelf from '../../src/studio/web/src/pages/Bookshelf.vue'

/** 桌面版 preload 注入的 API 形状（与 src/studio/web/src/desktop.d.ts 对齐）。 */
interface DesktopApi {
  openLibrary: () => Promise<{ ok: true } | { ok: false; canceled: true }>
  switchLibrary: (path: string) => Promise<{ ok: true } | { ok: false; reason: string }>
  getRecentLibraries: () => Promise<{ path: string; label: string }[]>
  getCurrentLibrary: () => Promise<string | null>
}

function setDesktop(api: Partial<DesktopApi> | null): void {
  const g = globalThis as unknown as { clwritingDesktop?: DesktopApi }
  if (api) {
    g.clwritingDesktop = {
      openLibrary: api.openLibrary ?? vi.fn().mockResolvedValue({ ok: true }),
      switchLibrary: api.switchLibrary ?? vi.fn().mockResolvedValue({ ok: true }),
      getRecentLibraries: api.getRecentLibraries ?? vi.fn().mockResolvedValue([]),
      getCurrentLibrary: api.getCurrentLibrary ?? vi.fn().mockResolvedValue(null),
    }
  } else {
    delete g.clwritingDesktop
  }
}

function mockBooks(books: { name: string; kind: 'long' | 'short' }[], workDir = true): void {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ books, workDir }) })
}

describe('Bookshelf 书架', () => {
  beforeEach(() => {
    pushMock.mockReset()
    fetchMock.mockReset()
    setDesktop(null)
  })

  it('浏览器版（无 desktop）→ 不渲染桌面入口，显示书列表', async () => {
    setDesktop(null)
    mockBooks([{ name: '书A', kind: 'long' }])
    const w = mount(Bookshelf)
    await flushPromises()
    expect(w.find('.btn-ghost').exists()).toBe(false) // 无「打开书库」
    expect(w.find('.recent-dropdown').exists()).toBe(false) // 无最近下拉
    expect(w.findAll('.book-card')).toHaveLength(1)
    expect(w.find('.book-name').text()).toBe('书A')
  })

  it('桌面版（有 desktop）→ 渲染「打开书库」+ 最近下拉 + 当前书库名', async () => {
    setDesktop({
      getRecentLibraries: vi.fn().mockResolvedValue([{ path: '/lib2', label: 'lib2' }]),
      getCurrentLibrary: vi.fn().mockResolvedValue('/path/我的书库'),
    })
    mockBooks([])
    const w = mount(Bookshelf)
    await flushPromises()
    expect(w.find('.btn-ghost').exists()).toBe(true) // 「打开书库」
    expect(w.find('.recent-dropdown').exists()).toBe(true) // 最近下拉
    expect(w.find('.current-lib').text()).toBe('我的书库') // 当前书库名（basename）
    expect(w.findAll('.recent-dropdown li')).toHaveLength(1)
  })

  it('点击「打开书库」→ 调 desktop.openLibrary', async () => {
    const openLib = vi.fn().mockResolvedValue({ ok: true })
    setDesktop({ openLibrary: openLib })
    mockBooks([])
    const w = mount(Bookshelf)
    await flushPromises()
    await w.find('.btn-ghost').trigger('click')
    expect(openLib).toHaveBeenCalledTimes(1)
  })

  it('点击最近列表项 → 调 desktop.switchLibrary(对应路径)', async () => {
    const switchLib = vi.fn().mockResolvedValue({ ok: true })
    setDesktop({
      switchLibrary: switchLib,
      getRecentLibraries: vi.fn().mockResolvedValue([{ path: '/libB', label: 'libB' }]),
    })
    mockBooks([])
    const w = mount(Bookshelf)
    await flushPromises()
    await w.find('.recent-dropdown li').trigger('click')
    expect(switchLib).toHaveBeenCalledWith('/libB')
  })

  it('浏览器版空态 workDir:false → 显示「工作目录启动」提示（非选择按钮）', async () => {
    setDesktop(null)
    mockBooks([], false)
    const w = mount(Bookshelf)
    await flushPromises()
    expect(w.find('.btn-ghost').exists()).toBe(false)
    expect(w.text()).toContain('工作目录')
  })

  it('桌面版空态 workDir:false → 显示「选择书库目录」按钮', async () => {
    const openLib = vi.fn().mockResolvedValue({ ok: true })
    setDesktop({ openLibrary: openLib })
    mockBooks([], false)
    const w = mount(Bookshelf)
    await flushPromises()
    expect(w.text()).toContain('选择书库目录')
    await w.find('.empty .btn-new').trigger('click')
    expect(openLib).toHaveBeenCalled()
  })
})
