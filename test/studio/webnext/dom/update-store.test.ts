/**
 * 自更新渲染层 store（顶栏角标 / 设置·关于 的状态与文案单源）：
 * 首取落状态、冷启动有界重取（服务端检查起服后 5s 才落结果，界面挂载即取必空）、
 * 「上次更新未完成」首见公告一次（warning toast）、忽略按版本记忆（localStorage
 * 脏值容错沿旧例）、下载/取消/应用/打开目录调桥、退出被取消回就绪、无桥降级复制、
 * 无下载能力只留「去下载」。
 *
 * 计时器口径：本档统一假计时器（防重取真计时器漏出档外），推进用
 * advanceTimersByTimeAsync——flushPromises 走 setImmediate，假计时器下不落地。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

const mocks = vi.hoisted(() => ({
  getAppInfo: vi.fn(),
}))

vi.mock('../../../../src/studio/web-next/src/api/app-info', () => ({
  getAppInfo: mocks.getAppInfo,
}))

import { useUpdateStore, UPDATE_DISMISS_KEY } from '../../../../src/studio/web-next/src/stores/update'
import { useUiStore } from '../../../../src/studio/web-next/src/stores/ui'

const UPDATE = { version: '1.0.0', url: 'https://github.com/Jevanzhu/CLWriting/releases/tag/v1.0.0' }
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
const ATTEMPT = {
  at: '2026-10-14T10:00:00.000Z',
  outcome: 'aborted' as const,
  from: '1.0.0-rc.3',
  to: '1.0.0-rc.4',
  reason: 'other-instances' as const,
}

interface BridgeOptions {
  capability?: { canDownload: boolean; canInstall: boolean }
  downloadResult?: { ok: true } | { ok: false; reason: string }
  applyResult?: { ok: true } | { ok: false; reason: string }
}

/** 完整桌面桥假件：能力/下载/取消/应用/打开目录 + 两个订阅回调的可编程出口 */
function installBridge(over: BridgeOptions = {}) {
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

/** 假计时器下的落定：推进 1ms（不触 6s 重取）+ 微任务冲净 */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1)
  await nextTick()
}

let clipboardWrites: string[] = []

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
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
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('自更新 store：首取与状态落位', () => {
  it('首取落状态：版本 / 更新 / 文案与可见性', async () => {
    installBridge()
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const s = useUpdateStore()
    s.ensureInit()
    await flush()
    expect(s.version).toBe('1.0.0-rc.4')
    expect(s.latest?.version).toBe('1.0.0')
    expect(s.visible).toBe(true)
    expect(s.statusText).toBe('当前 v1.0.0-rc.4 · 可在此下载更新（约 30.0 MB）')
    expect(s.primaryAction?.label).toBe('下载并更新')
  })

  it('无更新（update=null）→ 角标不可见、状态行空', async () => {
    installBridge()
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0', update: null, updateAttempt: null })
    const s = useUpdateStore()
    s.ensureInit()
    await flush()
    expect(s.visible).toBe(false)
    expect(s.statusText).toBeNull()
    expect(s.latest).toBeNull()
  })

  it('ensureInit 幂等：重复调用不重复取数/复订', async () => {
    installBridge()
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const s = useUpdateStore()
    s.ensureInit()
    s.ensureInit()
    await flush()
    expect(mocks.getAppInfo).toHaveBeenCalledTimes(1)
  })

  it('无桥（浏览器版）：能力面缺省 → 只留「去下载」，可下载不可安装走降级文案', async () => {
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const s = useUpdateStore()
    s.ensureInit()
    await flush()
    expect(s.canDownload).toBe(false)
    expect(s.canInstall).toBe(false)
    expect(s.primaryAction).toBeNull()
    expect(s.statusText).toContain('不会自动下载')
  })

  it('能力面 canDownload:false（如 mac 打包态）：主按钮不出，提示语如实', async () => {
    installBridge({ capability: { canDownload: false, canInstall: false } })
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const s = useUpdateStore()
    s.ensureInit()
    await flush()
    expect(s.primaryAction).toBeNull()
    expect(s.statusText).toContain('不会自动下载')
  })
})

describe('自更新 store：冷启动有界重取', () => {
  it('首取为空 → 6s 重取得更新即停（不再打点）', async () => {
    installBridge()
    mocks.getAppInfo
      .mockResolvedValueOnce({ version: '1.0.0-rc.4', update: null, updateAttempt: null })
      .mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const s = useUpdateStore()
    s.ensureInit()
    await flush()
    expect(s.latest).toBeNull()
    expect(mocks.getAppInfo).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(s.latest?.version).toBe('1.0.0')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(mocks.getAppInfo).toHaveBeenCalledTimes(2)
  })

  it('服务不可达：6s / 12s / 24s 三次重取后止（不无限打点）', async () => {
    installBridge()
    mocks.getAppInfo.mockRejectedValue(new Error('offline'))
    const s = useUpdateStore()
    s.ensureInit()
    await flush()
    await vi.advanceTimersByTimeAsync(6_000)
    await vi.advanceTimersByTimeAsync(12_000)
    await vi.advanceTimersByTimeAsync(24_000)
    expect(mocks.getAppInfo).toHaveBeenCalledTimes(4) // 首取 + 三次重取
    await vi.advanceTimersByTimeAsync(600_000)
    expect(mocks.getAppInfo).toHaveBeenCalledTimes(4)
    expect(s.visible).toBe(false) // 全程静默，不抛
  })
})

describe('自更新 store：结果条与忽略', () => {
  it('结果条首见：文案人话化 + warning 公告一次；仅结果条也让角标可见', async () => {
    installBridge()
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: null, updateAttempt: ATTEMPT })
    const ui = useUiStore()
    const toastSpy = vi.spyOn(ui, 'toast')
    const s = useUpdateStore()
    s.ensureInit()
    await flush()
    expect(s.attemptText).toBe('上次更新未完成（v1.0.0-rc.4）：还有其他书库的窗口在运行，本次未开始')
    expect(s.showAttempt).toBe(true)
    expect(s.visible).toBe(true)
    expect(toastSpy).toHaveBeenCalledWith(s.attemptText, 'warning')
  })

  it('结果条不重复公告：重取再拿到同一条不重复弹', async () => {
    installBridge()
    // 真实现依赖服务端读后即删；此处桩常返同一条，验「首见才公告」的前端守卫
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: null, updateAttempt: ATTEMPT })
    const ui = useUiStore()
    const toastSpy = vi.spyOn(ui, 'toast')
    const s = useUpdateStore()
    s.ensureInit()
    await flush()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(toastSpy).toHaveBeenCalledTimes(1)
  })

  it('关闭结果条（本会话）→ 角标随之隐去；再重取不复现', async () => {
    installBridge()
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: null, updateAttempt: ATTEMPT })
    const s = useUpdateStore()
    s.ensureInit()
    await flush()
    s.hideAttempt()
    expect(s.showAttempt).toBe(false)
    expect(s.visible).toBe(false)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(s.visible).toBe(false)
  })

  it('忽略此版本：落 localStorage、角标隐；出新版再出现', async () => {
    installBridge()
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const s = useUpdateStore()
    s.ensureInit()
    await flush()
    s.dismissUpdate()
    expect(JSON.parse(localStorage.getItem(UPDATE_DISMISS_KEY)!)).toEqual(['1.0.0'])
    expect(s.hasUpdate).toBe(false)
    expect(s.visible).toBe(false)

    // 出新版（下次检查拿到新版本号）→ 比对面不再命中，角标复现
    setActivePinia(createPinia())
    mocks.getAppInfo.mockResolvedValue({
      version: '1.0.0',
      update: { ...UPDATE_FULL, version: '1.1.0' },
      updateAttempt: null,
    })
    installBridge()
    const s2 = useUpdateStore()
    s2.ensureInit()
    await flush()
    expect(s2.hasUpdate).toBe(true)
    expect(s2.visible).toBe(true)
  })

  it('localStorage 脏值容错（非数组 / 非 string 元素）不炸且不误判为已忽略', async () => {
    installBridge()
    localStorage.setItem(UPDATE_DISMISS_KEY, '{"oops":1}')
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const s = useUpdateStore()
    s.ensureInit()
    await flush()
    expect(s.hasUpdate).toBe(true)

    localStorage.setItem(UPDATE_DISMISS_KEY, JSON.stringify([3, { v: '1.0.0' }]))
    setActivePinia(createPinia())
    const s2 = useUpdateStore()
    s2.ensureInit()
    await flush()
    expect(s2.hasUpdate).toBe(true)
  })
})

describe('自更新 store：下载 / 应用 / 出口链', () => {
  it('下载在途：进度事件写 store（订阅归 store，与组件生命周期无关）→ 就绪 → 应用调桥', async () => {
    const { calls, emitProgress } = installBridge()
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const s = useUpdateStore()
    s.ensureInit()
    await flush()
    let resolveDownload: ((r: { ok: true }) => void) | null = null
    ;(window as unknown as { clwritingDesktop: { updateDownload: unknown } }).clwritingDesktop.updateDownload = (
      v: string,
    ) => {
      calls.download.push(v)
      return new Promise((res) => {
        resolveDownload = res as (r: { ok: true }) => void
      })
    }
    const p = s.startDownload()
    await flush()
    expect(s.primaryAction?.label).toBe('取消')
    emitProgress({ received: 10 * 1024 * 1024, total: 30 * 1024 * 1024 })
    expect(s.statusText).toBe('下载中 33%（10.0 MB / 30.0 MB）')
    ;(resolveDownload as ((r: { ok: true }) => void) | null)?.({ ok: true })
    await p
    expect(s.phase).toBe('ready')
    expect(s.statusText).toContain('重启后自动完成替换')
    await s.applyUpdate()
    expect(calls.apply).toEqual(['1.0.0'])
    expect(s.phase).toBe('applying')
  })

  it('取消下载：调 updateCancel，终态 canceled → 回 idle', async () => {
    const { calls } = installBridge({ downloadResult: { ok: false, reason: '已取消下载' } })
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const s = useUpdateStore()
    s.ensureInit()
    await flush()
    await s.startDownload()
    expect(s.phase).toBe('idle')
    await s.cancelDownload()
    expect(calls.cancel).toBe(1)
  })

  it('下载失败 → failed（重试=再下载）；apply 被拒 → 原因上屏且留在 failed', async () => {
    const { calls } = installBridge({ downloadResult: { ok: false, reason: '更新包校验未通过：校验不匹配' } })
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const s = useUpdateStore()
    s.ensureInit()
    await flush()
    await s.startDownload()
    expect(s.phase).toBe('failed')
    expect(s.statusText).toContain('校验未通过')
    expect(s.primaryAction?.label).toBe('重试')

    installBridge({ applyResult: { ok: false, reason: '还有其他书库的窗口在运行，请先关闭它们再更新' } })
    ;(window as unknown as { clwritingDesktop: { updateDownload: unknown } }).clwritingDesktop.updateDownload = async (
      v: string,
    ) => {
      calls.download.push(v)
      return { ok: true as const }
    }
    await s.startDownload()
    expect(s.phase).toBe('ready')
    await s.applyUpdate()
    expect(s.phase).toBe('failed')
    expect(s.statusText).toContain('还有其他书库的窗口在运行')
  })

  it('可下载不可安装（开发态）：就绪主按钮 = 打开所在文件夹 → 调 updateReveal', async () => {
    const { calls } = installBridge({ capability: { canDownload: true, canInstall: false } })
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const s = useUpdateStore()
    s.ensureInit()
    await flush()
    await s.startDownload()
    expect(s.primaryAction?.label).toBe('打开所在文件夹')
    s.primaryAction?.run()
    expect(calls.reveal).toBe(1)
    expect(calls.apply).toEqual([])
    expect(s.statusText).toContain('自动安装需在 Windows 便携版上进行')
  })

  it('applying 中收到退出被取消广播 → 回 ready（不钉在「正在退出并更新…」）', async () => {
    installBridge()
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const s = useUpdateStore()
    const { emitCancelled } = installBridge()
    s.ensureInit()
    await flush()
    await s.startDownload()
    await s.applyUpdate()
    expect(s.phase).toBe('applying')
    emitCancelled()
    expect(s.phase).toBe('ready')
  })

  it('去下载：有桥走 openExternal；桥拒绝/无桥 → 降级复制（复制不可用不抛）', async () => {
    const openExternal = vi.fn(async () => ({ ok: false, reason: '仅支持打开本项目的 GitHub 发布页' }))
    ;(window as unknown as { clwritingDesktop?: unknown }).clwritingDesktop = { openExternal }
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const s = useUpdateStore()
    s.ensureInit()
    await flush()
    await s.openDownload()
    expect(openExternal).toHaveBeenCalledWith(UPDATE.url)
    expect(clipboardWrites).toEqual([UPDATE.url])
    expect(s.copied).toBe(true)

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('denied')
        },
      },
    })
    installBridge()
    ;(window as unknown as { clwritingDesktop: { openExternal?: unknown } }).clwritingDesktop.openExternal = undefined
    await s.openDownload() // 无桥 → 复制，抛错被吞
    expect(s.copied).toBe(true)
  })
})
