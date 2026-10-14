/**
 * 设置 · 关于页：当前版本展示 + 更新动作（与顶栏角标同源 store）。
 * 正统入口口径：角标「忽略此版本」只静默角标，本页仍如实展示可更新状态与动作。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

const mocks = vi.hoisted(() => ({
  getAppInfo: vi.fn(),
}))

vi.mock('../../../../src/studio/web-next/src/api/app-info', () => ({
  getAppInfo: mocks.getAppInfo,
}))

import SettingsAbout from '../../../../src/studio/web-next/src/components/ui/SettingsAbout.vue'
import { UPDATE_DISMISS_KEY, useUpdateStore } from '../../../../src/studio/web-next/src/stores/update'

const UPDATE_FULL = {
  version: '1.0.0',
  url: 'https://github.com/Jevanzhu/CLWriting/releases/tag/v1.0.0',
  asset: {
    name: 'CLWriting-1.0.0-x64.zip',
    url: 'https://dl.test/z.zip',
    size: 30 * 1024 * 1024,
    sha256: 'a'.repeat(64),
  },
  checksumsUrl: 'https://dl.test/SHA256SUMS.txt',
}

function installBridge() {
  const calls = { download: [] as string[] }
  ;(window as unknown as { clwritingDesktop?: unknown }).clwritingDesktop = {
    platform: 'win32',
    updateCapability: async () => ({ canDownload: true, canInstall: true }),
    updateDownload: async (v: string) => {
      calls.download.push(v)
      return { ok: true as const }
    },
    updateCancel: async () => ({ ok: true as const }),
    updateApply: async () => ({ ok: true as const }),
    updateReveal: async () => {},
    onUpdateProgress: () => () => {},
    onUpdateApplyCancelled: () => () => {},
  }
  return { calls }
}

let w: VueWrapper | null = null

/** 假计时器下的落定：推进 1ms（不触 6s 重取）+ 微任务冲净 */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1)
  await nextTick()
}

async function mountAbout(): Promise<VueWrapper> {
  const wrapper = mount(SettingsAbout)
  w = wrapper
  await flush()
  return wrapper
}

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  localStorage.clear()
  mocks.getAppInfo.mockReset()
  delete (window as unknown as { clwritingDesktop?: unknown }).clwritingDesktop
})

afterEach(() => {
  w?.unmount()
  w = null
  delete (window as unknown as { clwritingDesktop?: unknown }).clwritingDesktop
  localStorage.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('设置·关于页', () => {
  it('当前版本 + 有新版：状态行与「下载并更新」；点按钮走 store 下载', async () => {
    const { calls } = installBridge()
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    useUpdateStore().ensureInit()
    await flush()
    const wrapper = await mountAbout()
    expect(wrapper.find('[data-testid="about-version"]').text()).toBe('1.0.0-rc.4')
    expect(wrapper.text()).toContain('当前 v1.0.0-rc.4 · 可在此下载更新（约 30.0 MB）')
    await wrapper.find('.ua-primary').trigger('click')
    await flush()
    expect(calls.download).toEqual(['1.0.0'])
  })

  it('无更新且无结果条：「尚未发现新版本」，无动作按钮', async () => {
    installBridge()
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0', update: null, updateAttempt: null })
    useUpdateStore().ensureInit()
    await flush()
    const wrapper = await mountAbout()
    expect(wrapper.text()).toContain('尚未发现新版本')
    expect(wrapper.find('.ua-primary').exists()).toBe(false)
  })

  it('忽略过的版本：本页仍如实展示状态与动作（正统入口不禁）', async () => {
    installBridge()
    localStorage.setItem(UPDATE_DISMISS_KEY, JSON.stringify(['1.0.0']))
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    useUpdateStore().ensureInit()
    await flush()
    const wrapper = await mountAbout()
    expect(wrapper.text()).toContain('可在此下载更新')
    expect(wrapper.find('.ua-primary').text()).toBe('下载并更新')
  })

  it('结果条：本页给原文（可关）', async () => {
    installBridge()
    mocks.getAppInfo.mockResolvedValue({
      version: '1.0.0-rc.4',
      update: null,
      updateAttempt: {
        at: '2026-10-14T10:00:00.000Z',
        outcome: 'rolled-back',
        from: '1.0.0-rc.4',
        to: '1.0.0',
        reason: 'swap-failed',
      },
    })
    useUpdateStore().ensureInit()
    await flush()
    const wrapper = await mountAbout()
    expect(wrapper.text()).toContain('上次更新已还原（v1.0.0）：替换过程失败，已还原为原版本')
    await wrapper.find('.ua-attempt-x').trigger('click')
    expect(wrapper.find('.ua-attempt').exists()).toBe(false)
  })
})
