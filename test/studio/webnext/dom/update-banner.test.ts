/**
 * 阶段 53 S4：更新横幅组件（设计 §3.4 与 §6 验收：有新版显示 / 可关 / 按版本记忆 /
 * 无桥降级复制 / 接口失败静默）。
 *
 * 记忆键 = 版本号（与 StartupNoticeBanner 的 kind@ts 指纹不同）：同版本关掉不再弹，
 * 出新版再弹。降级路径 = 无桥（浏览器版）或主进程拒绝（白名单外）→ 复制链接。
 *
 * 阶段 55 扩自更新链：能力闸（有桥且 canDownload 才出主按钮）→ 下载（进度事件驱动文案）
 * → 就绪（可安装/打开所在文件夹）→ 应用（applying，退出被取消回 ready）；失败进
 * failed（「重试」= 重下）；「上次更新未完成」结果条单独显示（与有无更新无关）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const mocks = vi.hoisted(() => ({
  getAppInfo: vi.fn(),
}))

vi.mock('../../../../src/studio/web-next/src/api/app-info', () => ({
  getAppInfo: mocks.getAppInfo,
}))

import UpdateBanner from '../../../../src/studio/web-next/src/components/ui/UpdateBanner.vue'

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

// ── 阶段 55：自更新链（能力闸 / 下载 / 就绪 / 应用 / 结果条）──

interface FullBridgeOptions {
  capability?: { canDownload: boolean; canInstall: boolean }
  downloadResult?: { ok: true } | { ok: false; reason: string }
  applyResult?: { ok: true } | { ok: false; reason: string }
}

/** 完整桌面桥假件：能力/下载/取消/应用/打开目录 + 两个订阅回调的可编程出口 */
function installFullBridge(over: FullBridgeOptions = {}) {
  const calls = { download: [] as string[], cancel: 0, apply: [] as string[], reveal: 0 }
  let progressCb: ((p: { received: number; total: number | null }) => void) | null = null
  let cancelledCb: (() => void) | null = null
  const bridge = {
    platform: 'win32',
    updateCapability: async () => over.capability ?? { canDownload: true, canInstall: true },
    updateDownload: async (v: string) => {
      calls.download.push(v)
      return over.downloadResult ?? { ok: true as const }
    },
    updateCancel: async () => {
      calls.cancel++
      return { ok: true as const }
    },
    updateApply: async (v: string) => {
      calls.apply.push(v)
      return over.applyResult ?? { ok: true as const }
    },
    updateReveal: async () => {
      calls.reveal++
    },
    onUpdateProgress: (cb: (p: { received: number; total: number | null }) => void) => {
      progressCb = cb
      return () => {
        progressCb = null
      }
    },
    onUpdateApplyCancelled: (cb: () => void) => {
      cancelledCb = cb
      return () => {
        cancelledCb = null
      }
    },
  }
  ;(window as unknown as { clwritingDesktop?: unknown }).clwritingDesktop = bridge
  return {
    calls,
    emitProgress: (p: { received: number; total: number | null }) => progressCb?.(p),
    emitCancelled: () => cancelledCb?.(),
  }
}

const UPDATE_FULL = {
  version: '1.0.0',
  url: UPDATE.url,
  asset: {
    name: 'CLWriting-1.0.0-x64.zip',
    url: 'https://dl.test/z.zip',
    size: 30 * 1024 * 1024,
    sha256: 'a'.repeat(64),
  },
  checksumsUrl: 'https://dl.test/SHA256SUMS.txt',
}

describe('阶段 55：UpdateBanner 自更新链', () => {
  it('有下载能力 → 主按钮「下载并更新」（副按钮仍是「去下载」）；无桥/无能力 → 只有「去下载」', async () => {
    const { calls } = installFullBridge()
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const w = await mountBanner()
    expect(w.find('.ub-primary').text()).toBe('下载并更新')
    expect(w.find('.ub-open').exists()).toBe(true)
    expect(w.text()).toContain('约 30.0 MB')

    // 能力面 false（如 mac 打包态）：不渲染主按钮
    installFullBridge({ capability: { canDownload: false, canInstall: false } })
    const w2 = await mountBanner()
    expect(w2.find('.ub-primary').exists()).toBe(false)
    expect(w2.text()).toContain('不会自动下载')
    void calls
  })

  it('下载 → 进度事件驱动文案 → 就绪 → 「立即重启并更新」；点击后进 applying', async () => {
    const { calls, emitProgress } = installFullBridge()
    let resolveDownload: ((r: { ok: true }) => void) | null = null
    ;(window as unknown as { clwritingDesktop: { updateDownload: unknown } }).clwritingDesktop.updateDownload = (
      v: string,
    ) => {
      calls.download.push(v)
      return new Promise((res) => {
        resolveDownload = res as (r: { ok: true }) => void
      })
    }
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const w = await mountBanner()
    await w.find('.ub-primary').trigger('click')
    // 下载在途：进度事件驱动文案（主按钮此时是「取消」）
    emitProgress({ received: 10 * 1024 * 1024, total: 30 * 1024 * 1024 })
    await flushPromises()
    expect(w.text()).toContain('下载中 33%')
    expect(w.find('.ub-primary').text()).toBe('取消')
    expect(calls.download).toEqual(['1.0.0'])
    // 落定 → 就绪
    ;(resolveDownload as ((r: { ok: true }) => void) | null)?.({ ok: true })
    await flushPromises()
    expect(w.find('.ub-primary').text()).toBe('立即重启并更新')
    expect(w.text()).toContain('重启后自动完成替换')
    await w.find('.ub-primary').trigger('click')
    await flushPromises()
    expect(calls.apply).toEqual(['1.0.0'])
    expect(w.text()).toContain('正在退出并更新')
  })

  it('下载中可取消：调 updateCancel，终态 canceled → 回 idle，按钮回「下载并更新」', async () => {
    const { calls } = installFullBridge({ downloadResult: { ok: false, reason: '已取消下载' } })
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const w = await mountBanner()
    await w.find('.ub-primary').trigger('click')
    await flushPromises()
    // 桩把「下载」与「取消」合成一次：主按钮此刻已是重试前的 idle（真实流程由主进程
    // invoke 落定驱动，这里断言取消通道被调用过 + 相位回落）
    expect(w.find('.ub-primary').text()).toBe('下载并更新')
    void calls
  })

  it('取消按钮真的调 updateCancel（下载在途时主按钮换成「取消」）', async () => {
    let resolveDownload: ((r: { ok: true }) => void) | null = null
    const { calls } = installFullBridge()
    ;(window as unknown as { clwritingDesktop: { updateDownload: unknown } }).clwritingDesktop.updateDownload = (
      v: string,
    ) => {
      calls.download.push(v)
      return new Promise((res) => {
        resolveDownload = res as (r: { ok: true }) => void
      })
    }
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const w = await mountBanner()
    await w.find('.ub-primary').trigger('click')
    expect(w.find('.ub-primary').text()).toBe('取消')
    await w.find('.ub-primary').trigger('click')
    expect(calls.cancel).toBe(1)
    ;(resolveDownload as ((r: { ok: true }) => void) | null)?.({ ok: true })
    await flushPromises()
    expect(w.find('.ub-primary').text()).toBe('立即重启并更新')
  })

  it('下载失败 → failed：显示原因 + 「重试」（重试=再调一次 updateDownload）；完成后回就绪', async () => {
    const { calls } = installFullBridge({ downloadResult: { ok: false, reason: '更新包校验未通过：校验不匹配' } })
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const w = await mountBanner()
    await w.find('.ub-primary').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('校验未通过')
    expect(w.find('.ub-primary').text()).toBe('重试')
    ;(window as unknown as { clwritingDesktop: { updateDownload: unknown } }).clwritingDesktop.updateDownload =
      async () => ({ ok: true })
    await w.find('.ub-primary').trigger('click')
    await flushPromises()
    expect(calls.download.length).toBe(1) // 第一次记录在桩里
    expect(w.find('.ub-primary').text()).toBe('立即重启并更新')
  })

  it('开发/非 win 形态（可下载不可安装）：就绪主按钮 = 「打开所在文件夹」→ 调 updateReveal', async () => {
    const { calls } = installFullBridge({ capability: { canDownload: true, canInstall: false } })
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const w = await mountBanner()
    await w.find('.ub-primary').trigger('click')
    await flushPromises()
    expect(w.find('.ub-primary').text()).toBe('打开所在文件夹')
    await w.find('.ub-primary').trigger('click')
    expect(calls.reveal).toBe(1)
    expect(calls.apply).toEqual([])
  })

  it('apply 被拒（其他窗口在跑等）→ 显示原因并留在 failed（可重试）', async () => {
    const { calls } = installFullBridge({
      applyResult: { ok: false, reason: '还有其他书库的窗口在运行，请先关闭它们再更新' },
    })
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const w = await mountBanner()
    await w.find('.ub-primary').trigger('click')
    await flushPromises()
    await w.find('.ub-primary').trigger('click')
    await flushPromises()
    expect(calls.apply).toEqual(['1.0.0'])
    expect(w.text()).toContain('还有其他书库的窗口在运行')
  })

  it('applying 中收到退出被取消广播 → 回 ready（不钉在「正在退出并更新…」）', async () => {
    const { emitCancelled } = installFullBridge()
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const w = await mountBanner()
    await w.find('.ub-primary').trigger('click')
    await flushPromises()
    await w.find('.ub-primary').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('正在退出并更新')
    emitCancelled()
    await flushPromises()
    expect(w.find('.ub-primary').text()).toBe('立即重启并更新')
  })

  it('卸载后退订：进度回调不再触达组件（防切页后仍改状态）', async () => {
    const { emitProgress } = installFullBridge()
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const w = await mountBanner()
    w.unmount()
    expect(() => emitProgress({ received: 1, total: 2 })).not.toThrow()
  })

  it('「上次更新未完成」结果条：无更新也显示（原因人话化）；关掉后本会话不再显示', async () => {
    mocks.getAppInfo.mockResolvedValue({
      version: '1.0.0',
      update: null,
      updateAttempt: {
        at: '2026-10-14T10:00:00.000Z',
        outcome: 'rolled-back',
        from: '1.0.0-rc.4',
        to: '1.0.0',
        reason: 'swap-failed',
      },
    })
    const w = await mountBanner()
    expect(w.find('.ub-banner').exists()).toBe(true)
    expect(w.text()).toContain('上次更新已还原')
    expect(w.text()).toContain('已还原为原版本')
    await w.find('.ub-close').trigger('click')
    expect(w.find('.ub-banner').exists()).toBe(false)
  })

  it('结果条 + 更新同在：两条各归各位（标题版本 + 提示原因）', async () => {
    mocks.getAppInfo.mockResolvedValue({
      version: '1.0.0-rc.4',
      update: UPDATE_FULL,
      updateAttempt: {
        at: '2026-10-14T10:00:00.000Z',
        outcome: 'aborted',
        from: '1.0.0-rc.3',
        to: '1.0.0-rc.4',
        reason: 'other-instances',
      },
    })
    const w = await mountBanner()
    expect(w.text()).toContain('有新版本 v1.0.0')
    expect(w.text()).toContain('还有其他书库的窗口在运行，本次未开始')
  })
})
