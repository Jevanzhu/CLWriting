/**
 * TooltipHost 全局 tooltip 宿主行为族（happy-dom）。
 * （原 r29-components-zero-coverage 的 R29-13 TooltipHost 节，按行为单拆。）
 *
 * R29-13（二十九轮批 F）：组件面零直测补齐——data-tip 悬停 250ms 延迟显隐 + 边缘翻转
 * + data-tip→aria-label 读屏同步（P2-F6b：focusin 同步、挂载时对常驻元素补同步；
 * 「已有 aria-label 不覆盖」口径后改为「值不同即写」，动态 tip 才跟得上状态）。
 * R0911-C2-P3-2（2026-09-11 全量重评 GLM-5.3 修复批）：250ms 延迟窗内目标被移除
 * （hover 中列表重渲染/弹层关窗摘节点）——移除节点 getBoundingClientRect 全 0，修复前
 * tooltip 错落视口左上角；修后延迟回调先验 isConnected，不在文档则中止显示。
 * R42-29（四十二轮）：估宽按码位分类累加——同长度 ASCII 文案估宽 < 同长度 CJK 文案
 * （原 r42-shell-mount 的 R42-29 节并入；happy-dom 零矩形下 top 翻 bottom、
 * left = 估宽/2 + 8，估宽经 left 可观察）。
 * 批 E（2026-10-14）：宿主上移根组件（App.vue）后，「挂载时扫一次」早于路由子树出现——
 * 晚到的 [data-tip]（工作区 Ribbon/顶栏等）不再补 aria-label，读屏名在首次交互前缺失
 * （e2e 角色名定位同面）；补 DOM 变更观察（新增子树含目标才查）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import TooltipHost from '../../../../src/studio/web-next/src/components/ui/TooltipHost.vue'

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

  it('focusin 同步 aria-label（键盘导航读屏）；值不同即刷新（不把旧名当权威）', async () => {
    mountHost()
    const el = document.createElement('button')
    el.dataset.tip = '新建书'
    document.body.appendChild(el)
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(el.getAttribute('aria-label')).toBe('新建书')

    // 已有 aria-label 与 tip 不同 → 刷成当前 tip（旧口径「已有名不覆盖」会把首值永久钉死）
    const named = document.createElement('button')
    named.dataset.tip = '提示B'
    named.setAttribute('aria-label', '已有名')
    document.body.appendChild(named)
    named.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(named.getAttribute('aria-label')).toBe('提示B')
  })

  // 动态 tip：data-tip 随状态换值（如专注模式开关「专注模式（⌘⇧F）/退出专注（⌘⇧F）」）——
  // aria-label 必须跟当前 tip，否则读屏长期读到旧状态
  it('动态 tip：同一元素换 data-tip 后再进入（含指针在元素内移动）→ aria-label 刷成当前文案', async () => {
    mountHost()
    const el = document.createElement('button')
    el.dataset.tip = '专注模式（⌘⇧F）'
    document.body.appendChild(el)
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    expect(el.getAttribute('aria-label')).toBe('专注模式（⌘⇧F）')

    el.dataset.tip = '退出专注（⌘⇧F）' // 状态切换：同一元素换文案（无重挂、无新元素）
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) // 事件从子节点冒泡的真实形态
    expect(el.getAttribute('aria-label')).toBe('退出专注（⌘⇧F）')

    // 移开再进入（lastTarget 复位路径）同样刷新
    const plain = document.createElement('div')
    document.body.appendChild(plain)
    plain.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    el.dataset.tip = '专注模式（⌘⇧F）'
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    expect(el.getAttribute('aria-label')).toBe('专注模式（⌘⇧F）')
  })

  it('挂载时对已存在 [data-tip] 元素补同步 aria-label（首屏常驻按钮）', () => {
    const pre = document.createElement('button')
    pre.dataset.tip = '首屏按钮'
    document.body.appendChild(pre)
    mountHost()
    expect(pre.getAttribute('aria-label')).toBe('首屏按钮')
  })

  it('挂载后新增的 [data-tip] 元素也补同步 aria-label（宿主在根层、目标随路由子树后到）', async () => {
    mountHost()
    const late = document.createElement('button')
    late.dataset.tip = '工作台'
    const shell = document.createElement('div')
    shell.appendChild(late)
    document.body.appendChild(shell)
    await nextTick()
    expect(late.getAttribute('aria-label')).toBe('工作台')
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
