/**
 * 更新角标（工作区左栏标题条、「刷新目录」按钮左侧）：形态三态（有点角标 / 下载环形 / 就绪胶囊）、
 * 弹层开合（X 只关弹层 ≠ 忽略此版本）、就绪点即重启、失败与「上次更新未完成」告示、
 * 忽略按版本记忆、挂点落位（刷新按钮左侧同组 + 间距取行 gap）。
 *
 * Teleport 口径：角标在组件树内（wrapper.find 可达）；弹层 Teleport 到 body——
 * 断言走 document.querySelector + dispatchEvent（tooltip-host 先例），afterEach 清 body。
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

import UpdateCorner from '../../../../src/studio/web-next/src/components/ui/UpdateCorner.vue'
import { UPDATE_DISMISS_KEY } from '../../../../src/studio/web-next/src/stores/update'
import { readRepoFile } from '../../../helpers/repo-root.js'

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
const ATTEMPT = {
  at: '2026-10-14T10:00:00.000Z',
  outcome: 'aborted' as const,
  from: '1.0.0-rc.3',
  to: '1.0.0-rc.4',
  reason: 'other-instances' as const,
}

function installBridge(over: { downloadResult?: { ok: true } | { ok: false; reason: string } } = {}) {
  const calls = { download: [] as string[], cancel: 0, apply: [] as string[], reveal: 0 }
  let progressCb: ((p: { received: number; total: number | null }) => void) | null = null
  const bridge = {
    platform: 'win32',
    updateCapability: async () => ({ canDownload: true, canInstall: true }),
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
      return { ok: true as const }
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
    onUpdateApplyCancelled: () => () => {},
  }
  ;(window as unknown as { clwritingDesktop?: unknown }).clwritingDesktop = bridge
  return { calls, emitProgress: (p: { received: number; total: number | null }) => progressCb?.(p) }
}

let w: VueWrapper | null = null

async function mountCorner(): Promise<VueWrapper> {
  const wrapper = mount(UpdateCorner, { attachTo: document.body })
  await flush()
  w = wrapper
  return wrapper
}

/** 假计时器下的落定：推进 1ms（不触 6s 重取）+ 微任务冲净 */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1)
  await nextTick()
}

/** 点击 Teleport 到 body 的弹层内元素（VTU wrapper 不在其 DOM 子树内） */
async function clickIn(sel: string): Promise<void> {
  const el = document.querySelector(sel)
  expect(el, `应存在 ${sel}`).not.toBeNull()
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await flush()
}

function popEl(): Element | null {
  return document.querySelector('.uc-pop')
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
  document.body.innerHTML = ''
  delete (window as unknown as { clwritingDesktop?: unknown }).clwritingDesktop
  localStorage.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('更新角标：形态', () => {
  it('无更新且无结果条 → 不渲染', async () => {
    installBridge()
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0', update: null, updateAttempt: null })
    const wrapper = await mountCorner()
    expect(wrapper.find('.uc-chip').exists()).toBe(false)
    expect(popEl()).toBeNull()
  })

  it('有新版本 → 小点角标 + tip；点击出弹层（标题/按钮/大小文案）', async () => {
    installBridge()
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const wrapper = await mountCorner()
    expect(wrapper.find('.uc-chip .uc-badge').exists()).toBe(true)
    expect(wrapper.find('.uc-chip').attributes('data-tip')).toBe('有新版本 v1.0.0')
    await wrapper.find('.uc-chip').trigger('click')
    await flush()
    expect(popEl()).not.toBeNull()
    expect(popEl()!.textContent).toContain('有新版本 v1.0.0')
    expect(popEl()!.textContent).toContain('约 30.0 MB')
    expect(popEl()!.querySelector('.ua-primary')?.textContent).toContain('下载并更新')
  })

  // 红锚（真机暴露）：形态类名与内部元素类名撞名——「点」形态的按钮类 uc-dot
  // 与指示点 span 同名，按钮因此吃下 .uc-dot 的 absolute + 6px 见方规则，角标被钉到
  // 容器右上角 6px 小格（真机实测 rect = [1267,3,6,6]，--size-control 26px 整个失效）。
  it('形态类名不与内部元素类名撞名（同名即把形态规则漏到元素上）', async () => {
    installBridge()
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const wrapper = await mountCorner()
    const chip = wrapper.find('.uc-chip').element as HTMLElement
    const own = [...chip.classList]
    const leaked = [...chip.querySelectorAll<HTMLElement>('*')].flatMap((el) =>
      [...el.classList].filter((c) => own.includes(c)),
    )
    expect(leaked).toEqual([])
  })

  it('下载在途 → 环形进度 + tip 百分比；落定 → 就绪胶囊', async () => {
    const { calls, emitProgress } = installBridge()
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const wrapper = await mountCorner()
    let resolveDownload: ((r: { ok: true }) => void) | null = null
    ;(window as unknown as { clwritingDesktop: { updateDownload: unknown } }).clwritingDesktop.updateDownload = (
      v: string,
    ) => {
      calls.download.push(v)
      return new Promise((res) => {
        resolveDownload = res as (r: { ok: true }) => void
      })
    }
    await wrapper.find('.uc-chip').trigger('click')
    await flush()
    await clickIn('.uc-pop .ua-primary')
    expect(wrapper.find('.uc-ring').exists()).toBe(true)
    emitProgress({ received: 9 * 1024 * 1024, total: 30 * 1024 * 1024 })
    await flush()
    expect(wrapper.find('.uc-chip').attributes('data-tip')).toBe('下载中 30%')
    ;(resolveDownload as ((r: { ok: true }) => void) | null)?.({ ok: true })
    await flush()
    expect(wrapper.find('.uc-ready').exists()).toBe(true)
    expect(wrapper.find('.uc-ready').text()).toBe('重启更新')
  })

  it('就绪胶囊点即重启（直连 apply，不绕弹层）', async () => {
    const { calls } = installBridge()
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const wrapper = await mountCorner()
    await wrapper.find('.uc-chip').trigger('click')
    await flush()
    await clickIn('.uc-pop .ua-primary')
    expect(wrapper.find('.uc-ready').exists()).toBe(true)
    await wrapper.find('.uc-ready').trigger('click')
    await flush()
    expect(calls.apply).toEqual(['1.0.0'])
  })

  it('下载失败 → 警示角标；弹层内给原因与「重试」', async () => {
    installBridge({ downloadResult: { ok: false, reason: '更新包校验未通过：校验不匹配' } })
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const wrapper = await mountCorner()
    await wrapper.find('.uc-chip').trigger('click')
    await flush()
    await clickIn('.uc-pop .ua-primary')
    expect(wrapper.find('.uc-warn-ic').exists()).toBe(true)
    expect(wrapper.find('.uc-chip').attributes('data-tip')).toContain('校验未通过')
    // 失败落定后弹层仍在（相位切换不关弹层）：原因与「重试」就地可读
    expect(popEl()).not.toBeNull()
    expect(popEl()!.textContent).toContain('校验未通过')
    expect(popEl()!.querySelector('.ua-primary')?.textContent).toContain('重试')
  })
})

describe('更新角标：弹层开合与忽略', () => {
  it('X 只关弹层：角标仍在、不落忽略记录；Esc 与点外同效', async () => {
    installBridge()
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const wrapper = await mountCorner()
    await wrapper.find('.uc-chip').trigger('click')
    await flush()
    await clickIn('.uc-pop .uc-pop-close')
    expect(popEl()).toBeNull()
    expect(wrapper.find('.uc-chip').exists()).toBe(true)
    expect(localStorage.getItem(UPDATE_DISMISS_KEY)).toBeNull()

    // Esc 关（document 监听）
    await wrapper.find('.uc-chip').trigger('click')
    await flush()
    expect(popEl()).not.toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flush()
    expect(popEl()).toBeNull()

    // 点外关
    await wrapper.find('.uc-chip').trigger('click')
    await flush()
    expect(popEl()).not.toBeNull()
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(popEl()).toBeNull()
  })

  it('忽略此版本：落 localStorage、角标与弹层一起隐去（再尝出不弹）', async () => {
    installBridge()
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const wrapper = await mountCorner()
    await wrapper.find('.uc-chip').trigger('click')
    await flush()
    await clickIn('.uc-pop .ua-dismiss')
    expect(JSON.parse(localStorage.getItem(UPDATE_DISMISS_KEY)!)).toEqual(['1.0.0'])
    expect(wrapper.find('.uc-chip').exists()).toBe(false)
    expect(popEl()).toBeNull()
  })
})

describe('更新角标：上次更新未完成', () => {
  it('仅结果条也出警示角标；弹层给原文与「知道了」，关掉角标隐去', async () => {
    installBridge()
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: null, updateAttempt: ATTEMPT })
    const wrapper = await mountCorner()
    expect(wrapper.find('.uc-warn-ic').exists()).toBe(true)
    expect(wrapper.find('.uc-chip').attributes('data-tip')).toContain('上次更新未完成')
    await wrapper.find('.uc-chip').trigger('click')
    await flush()
    expect(popEl()!.textContent).toContain('还有其他书库的窗口在运行，本次未开始')
    await clickIn('.uc-pop .ua-attempt-x')
    expect(wrapper.find('.uc-chip').exists()).toBe(false)
    expect(popEl()).toBeNull()
  })

  it('结果条与更新同在：标题给版本、正文给原因', async () => {
    installBridge()
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: ATTEMPT })
    const wrapper = await mountCorner()
    await wrapper.find('.uc-chip').trigger('click')
    await flush()
    expect(popEl()!.textContent).toContain('有新版本 v1.0.0')
    expect(popEl()!.textContent).toContain('还有其他书库的窗口在运行，本次未开始')
  })
})

describe('更新角标：弹层锚定', () => {
  // 红锚（真机暴露）：原按角标**右缘**对齐（角标在标题条内偏右，紧邻刷新按钮左侧），
  // 174 − 300 = −126 被 8px 视口下限夹死，弹层会钉在窗口左角、与角标脱钩。
  it('左缘锚定角标左缘（不再被视口下限夹到窗口左角）', async () => {
    installBridge()
    mocks.getAppInfo.mockResolvedValue({ version: '1.0.0-rc.4', update: UPDATE_FULL, updateAttempt: null })
    const wrapper = await mountCorner()
    const chip = wrapper.find('.uc-chip').element as HTMLElement
    // jsdom 无布局（rect 恒 0）：给角标一个真机矩形——左栏标题条内、刷新按钮左侧（1536 宽窗实测）
    chip.getBoundingClientRect = (() =>
      ({ left: 148, right: 174, top: 2.5, bottom: 28.5, width: 26, height: 26 }) as unknown as DOMRect) as () => DOMRect
    await wrapper.find('.uc-chip').trigger('click')
    await flush()
    const pop = popEl() as HTMLElement
    expect(pop.style.left).toBe('148px')
    expect(pop.style.top).toBe('34.5px')
  })
})

describe('更新角标：挂点', () => {
  // 静态源码守卫（先例 menu-labels / desktop-drag-class-scope）：挂点落位无运行时门，
  // 且「前导位包裹 + margin-right:auto」一旦回归，角标就被重新顶到栏左端——布局漂移
  // 在 jsdom 与纯 Chromium e2e 里都看不见，只能静态钉。
  const sidebar = readRepoFile('src/studio/web-next/src/components/shell/SidebarLeft.vue')

  it('角标是 .left-tabs 直接子件，紧邻「刷新目录」按钮左侧', () => {
    const row = sidebar.slice(sidebar.indexOf('<div class="left-tabs"'), sidebar.indexOf('<div class="left-body"'))
    const chipIdx = row.indexOf('<UpdateCorner />')
    const refreshIdx = row.indexOf('refresh-tree')
    expect(chipIdx, '角标应在 .left-tabs 行内').toBeGreaterThan(-1)
    expect(row.lastIndexOf('<UpdateCorner />'), '角标在行内只应出现一次').toBe(chipIdx)
    // 行首直接子件（旧形态是包裹进 .left-tabs-lead 的前导位，此处即红）
    expect(row.slice(row.indexOf('>') + 1).trimStart().startsWith('<UpdateCorner />'), '角标应为行首直接子件').toBe(
      true,
    )
    expect(chipIdx, '角标应在刷新按钮之前').toBeLessThan(refreshIdx)
    expect(row.slice(chipIdx, refreshIdx), '角标与刷新按钮之间不得夹任何元素').not.toMatch(/<\/?div/)
  })

  it('贴栏左端的独立前导位（.left-tabs-lead / margin-right:auto）不得复活', () => {
    expect(sidebar).not.toContain('left-tabs-lead')
    expect(sidebar).not.toContain('margin-right: auto')
  })
})
