// @vitest-environment happy-dom
/**
 * 阶段 53 S4：更新横幅组件（设计 §3.4 与 §6 验收：有新版显示 / 可关 / 按版本记忆 /
 * 无桥降级复制 / 接口失败静默）。
 *
 * 记忆键 = 版本号（与 StartupNoticeBanner 的 kind@ts 指纹不同）：同版本关掉不再弹，
 * 出新版再弹。降级路径 = 无桥（浏览器版）或主进程拒绝（白名单外）→ 复制链接。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const mocks = vi.hoisted(() => ({
  getAppInfo: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/app-info', () => ({
  getAppInfo: mocks.getAppInfo,
}))

import UpdateBanner from '../../../src/studio/web-next/src/components/ui/UpdateBanner.vue'

const UPDATE = { version: '1.0.0', url: 'https://github.com/Jevanzhu/CLWriting/releases/tag/v1.0.0' }

/** 桌面桥假件（openExternal 回执可控） */
function installBridge(result: { ok: true } | { ok: false; reason: string } = { ok: true }) {
  const openExternal = vi.fn(async () => result)
  ;(window as unknown as { clwritingDesktop?: unknown }).clwritingDesktop = { openExternal }
  return openExternal
}

async function mountBanner(): Promise<ReturnType<typeof mount>> {
  const w = mount(UpdateBanner)
  await flushPromises()
  return w
}

let clipboardWrites: string[] = []

beforeEach(() => {
  localStorage.clear()
  clipboardWrites = []
  mocks.getAppInfo.mockReset()
  delete (window as unknown as { clwritingDesktop?: unknown }).clwritingDesktop
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (t: string) => {
        clipboardWrites.push(t)
      },
    },
  })
})

afterEach(() => {
  delete (window as unknown as { clwritingDesktop?: unknown }).clwritingDesktop
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('阶段 53 S4：UpdateBanner', () => {
  it('有新版本 → 显示版本号与当前版本', async () => {
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.0', update: UPDATE })
    const w = await mountBanner()
    expect(w.find('.ub-banner').exists()).toBe(true)
    expect(w.text()).toContain('v1.0.0')
    expect(w.text()).toContain('v1.0.0-rc.0')
  })

  it('无更新 / 未完成检查（update=null）→ 不显示', async () => {
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0', update: null })
    const w = await mountBanner()
    expect(w.find('.ub-banner').exists()).toBe(false)
  })

  it('接口失败 → 静默不显示、不抛', async () => {
    mocks.getAppInfo.mockRejectedValue(new Error('offline'))
    const w = await mountBanner()
    expect(w.find('.ub-banner').exists()).toBe(false)
  })

  it('关闭 → 该版本落 localStorage、横幅消失；重挂同版本不再弹', async () => {
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.0', update: UPDATE })
    const w = await mountBanner()
    await w.find('.ub-close').trigger('click')
    expect(w.find('.ub-banner').exists()).toBe(false)
    expect(JSON.parse(localStorage.getItem('clw-update-dismissed')!)).toEqual(['1.0.0'])

    const again = await mountBanner()
    expect(again.find('.ub-banner').exists()).toBe(false)
  })

  it('出新版 → 再弹（记忆按版本，不按一次性）', async () => {
    localStorage.setItem('clw-update-dismissed', JSON.stringify(['1.0.0']))
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0', update: { version: '1.1.0', url: UPDATE.url } })
    const w = await mountBanner()
    expect(w.find('.ub-banner').exists()).toBe(true)
    expect(w.text()).toContain('v1.1.0')
  })

  it('localStorage 脏值容错（非数组 / 非 string 元素）不炸且不误判', async () => {
    localStorage.setItem('clw-update-dismissed', '{"oops":1}')
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.0', update: UPDATE })
    const w = await mountBanner()
    expect(w.find('.ub-banner').exists()).toBe(true) // 脏值不当作「已关闭」

    localStorage.setItem('clw-update-dismissed', JSON.stringify([3, { v: '1.0.0' }]))
    const w2 = await mountBanner()
    expect(w2.find('.ub-banner').exists()).toBe(true)
  })

  it('有桥（桌面版）→ 调 openExternal，不触剪贴板', async () => {
    const openExternal = installBridge({ ok: true })
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.0', update: UPDATE })
    const w = await mountBanner()
    await w.find('.ub-open').trigger('click')
    await flushPromises()
    expect(openExternal).toHaveBeenCalledWith(UPDATE.url)
    expect(clipboardWrites).toEqual([])
  })

  it('无桥（浏览器版）→ 降级复制链接 + 文案变「链接已复制」', async () => {
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.0', update: UPDATE })
    const w = await mountBanner()
    await w.find('.ub-open').trigger('click')
    await flushPromises()
    expect(clipboardWrites).toEqual([UPDATE.url])
    expect(w.find('.ub-open').text()).toBe('链接已复制')
  })

  it('主进程拒绝（白名单外/打开失败）→ 同降级复制，不留死按钮', async () => {
    installBridge({ ok: false, reason: '仅支持打开本项目的 GitHub 发布页' })
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.0', update: UPDATE })
    const w = await mountBanner()
    await w.find('.ub-open').trigger('click')
    await flushPromises()
    expect(clipboardWrites).toEqual([UPDATE.url])
    expect(w.find('.ub-open').text()).toBe('链接已复制')
  })

  it('剪贴板不可用 → 不抛（只留链接文案）', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('denied')
        },
      },
    })
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.0', update: UPDATE })
    const w = await mountBanner()
    await w.find('.ub-open').trigger('click')
    await flushPromises()
    expect(w.find('.ub-banner').exists()).toBe(true) // 横幅仍在，无未处理拒绝
  })
})
