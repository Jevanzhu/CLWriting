// @vitest-environment happy-dom
/**
 * TooltipHost 全局 tooltip 宿主行为族（happy-dom）。
 * （原 r29-components-zero-coverage 的 R29-13 TooltipHost 节，按行为单拆。）
 *
 * R29-13（二十九轮批 F）：组件面零直测补齐——data-tip 悬停 250ms 延迟显隐 + 边缘翻转
 * + data-tip→aria-label 读屏同步（P2-F6b：focusin 同步、已有 aria-label 不覆盖、挂载
 * 时对常驻元素补同步）。
 * R0911-C2-P3-2（2026-09-11 全量重评 GLM-5.3 修复批）：250ms 延迟窗内目标被移除
 * （hover 中列表重渲染/弹层关窗摘节点）——移除节点 getBoundingClientRect 全 0，修复前
 * tooltip 错落视口左上角；修后延迟回调先验 isConnected，不在文档则中止显示。
 * R42-29（四十二轮）：估宽按码位分类累加——同长度 ASCII 文案估宽 < 同长度 CJK 文案
 * （原 r42-shell-mount 的 R42-29 节并入；happy-dom 零矩形下 top 翻 bottom、
 * left = 估宽/2 + 8，估宽经 left 可观察）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import TooltipHost from '../../../src/studio/web-next/src/components/ui/TooltipHost.vue'

describe('R29-13 TooltipHost 全局 tooltip 宿主', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    wrapper?.unmount() // 摘 document/window 监听
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  function mountHost(): void {
    wrapper = mount(TooltipHost, { attachTo: document.body })
  }

  it('悬停 data-tip → 250ms 延迟后显示 + 边缘翻转 bottom；移开隐藏', async () => {
    mountHost()
    const trigger = document.createElement('button')
    trigger.dataset.tip = '保存'
    document.body.appendChild(trigger)

    trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await nextTick()
    expect(document.querySelector('.tip-host')).toBeNull() // 250ms 延迟内不显示

    vi.advanceTimersByTime(250)
    await nextTick()
    const tip = document.querySelector('.tip-host')
    expect(tip?.textContent).toContain('保存')
    expect(tip?.className).toContain('bottom') // happy-dom 零矩形：上方空间不足 → 翻转 bottom
    expect(trigger.getAttribute('aria-label')).toBe('保存') // P2-F6b：data-tip 同步 aria-label

    const plain = document.createElement('div')
    document.body.appendChild(plain)
    plain.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await nextTick()
    expect(document.querySelector('.tip-host')).toBeNull() // 移到无 data-tip 元素 → 隐藏
  })

  it('focusin 同步 aria-label（键盘导航读屏）；已有 aria-label 不覆盖', async () => {
    mountHost()
    const el = document.createElement('button')
    el.dataset.tip = '新建书'
    document.body.appendChild(el)
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(el.getAttribute('aria-label')).toBe('新建书')

    const named = document.createElement('button')
    named.dataset.tip = '提示B'
    named.setAttribute('aria-label', '已有名')
    document.body.appendChild(named)
    named.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(named.getAttribute('aria-label')).toBe('已有名') // 已有名不覆盖
  })

  it('挂载时对已存在 [data-tip] 元素补同步 aria-label（首屏常驻按钮）', () => {
    const pre = document.createElement('button')
    pre.dataset.tip = '首屏按钮'
    document.body.appendChild(pre)
    mountHost()
    expect(pre.getAttribute('aria-label')).toBe('首屏按钮')
  })

  // R0911-C2-P3-2（2026-09-11 全量重评 GLM-5.3 修复批）：250ms 延迟窗内目标被移除
  // （hover 中列表重渲染/弹层关窗摘节点）——移除节点 getBoundingClientRect 全 0，
  // 修复前 tooltip 错落视口左上角；修后延迟回调先验 isConnected，不在文档则中止显示。
  it('延迟窗内目标移除 → 到时不显示 tooltip（不落 0,0）；后续悬停新目标照常显示', async () => {
    mountHost()
    const trigger = document.createElement('button')
    trigger.dataset.tip = '将被移除'
    document.body.appendChild(trigger)
    trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await nextTick()
    trigger.remove() // 延迟窗内目标摘出文档
    vi.advanceTimersByTime(250)
    await nextTick()
    expect(document.querySelector('.tip-host')).toBeNull() // 修复点：不出现 0,0 定位的 tooltip

    // 中止后状态不悬挂：悬停新目标照常走完整显示链（lastTarget 已复位、不被短路）
    const fresh = document.createElement('button')
    fresh.dataset.tip = '新目标'
    document.body.appendChild(fresh)
    fresh.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await nextTick()
    vi.advanceTimersByTime(250)
    await nextTick()
    expect(document.querySelector('.tip-host')?.textContent).toContain('新目标')
  })
})

// ── R42-29：估宽按码位分类（ASCII < CJK）────────────────────────────────

describe('R42-29 TooltipHost：估宽按码位分类（ASCII < CJK）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  /** 悬停 data-tip → 250ms 延迟后返回 tip 的 left。
   *  happy-dom 零矩形：top 方向空间不足翻 bottom，x = 估宽/2 + 8（边缘检测收边），
   *  left 随估宽单调——估宽差异可观察。 */
  async function hoverTipLeft(text: string): Promise<number> {
    const trigger = document.createElement('button')
    trigger.dataset.tip = text
    document.body.appendChild(trigger)
    trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await nextTick()
    vi.advanceTimersByTime(250)
    await nextTick()
    const tip = document.querySelector('.tip-host')
    expect(tip, `悬停「${text}」后 tooltip 应显示`).not.toBeNull()
    return parseFloat((tip as HTMLElement).style.left)
  }

  it('同长度文案：ASCII 估宽 < CJK 估宽（left 有限且可观察）', async () => {
    const w = mount(TooltipHost, { attachTo: document.body })
    const ascii = await hoverTipLeft('ABCDEFGHIJ') // 10 半角 ≈ 10×7 + padding
    const cjk = await hoverTipLeft('十个汉字组成句子呀') // 10 全角 ≈ 10×13 + padding
    expect(Number.isFinite(ascii)).toBe(true) // 不抛错 + 尺寸有限
    expect(Number.isFinite(cjk)).toBe(true)
    expect(ascii).toBeGreaterThan(0)
    expect(ascii).toBeLessThan(cjk)
    w.unmount()
  })
})
