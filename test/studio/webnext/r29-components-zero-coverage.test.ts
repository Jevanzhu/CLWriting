// @vitest-environment happy-dom
/**
 * R29-13（二十九轮批 F）：高危零直测组件补 mount 级用例——88 个 .vue 组件 34 个零直测，
 * 本文件优先补「错误边界与提示族」四个（此前只有 store 层间接覆盖，组件面零直测）：
 * - ErrorBoundary：子组件抛错 → 兜底 UI + 重试恢复；正常子组件不受影响
 * - Toast：ui.toast 触发 → Teleport 渲染 + 分级自动消失（error 5s / 其余 1.8s，R76-35 口径）
 * - ConfirmDeleteModal：确认/取消事件上抛、遮罩点击取消、deleting 危险态、错误条展示
 * - TooltipHost：data-tip 悬停显显隐 + data-tip→aria-label 读屏同步（P2-F6b）
 * 参考既有组件直测（settings-book / confirm-esc 等）的 mount 模式；Teleport 组件内容
 * 不在 wrapper.element 子树内，直接查 document.body（Toast/TooltipHost），ConfirmDeleteModal
 * 用 VTU teleport stub 留在 wrapper 内以便事件与 DOM 同体断言。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'

import ErrorBoundary from '../../../src/studio/web-next/src/components/ui/ErrorBoundary.vue'
import Toast from '../../../src/studio/web-next/src/components/ui/Toast.vue'
import ConfirmDeleteModal from '../../../src/studio/web-next/src/components/ui/ConfirmDeleteModal.vue'
import TooltipHost from '../../../src/studio/web-next/src/components/ui/TooltipHost.vue'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

// 可控爆炸子组件：boom=true 时渲染抛错（false 正常渲染）——retry 恢复用例先止血再重试
function makeBoom(boom: { value: boolean }) {
  return defineComponent({
    setup() {
      return () => {
        if (boom.value) throw new Error('渲染爆炸')
        return h('div', { class: 'ok' }, '恢复后的正文')
      }
    },
  })
}

describe('R29-13 ErrorBoundary 错误边界', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('正常子组件不受影响：无兜底 UI，slot 内容原样渲染', () => {
    const wrapper = mount(ErrorBoundary, {
      slots: { default: () => h('div', { class: 'ok' }, '正文内容') },
    })
    expect(wrapper.find('.eb-fallback').exists()).toBe(false)
    expect(wrapper.find('.ok').text()).toBe('正文内容')
  })

  it('子组件抛错 → 兜底 UI 渲染（标题/错误消息），slot 不再渲染且 console.error 留痕', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const boom = ref(true)
    const wrapper = mount(ErrorBoundary, {
      slots: { default: () => h(makeBoom(boom)) },
    })
    await nextTick() // 兜底切队 microtask flush
    expect(wrapper.find('.eb-fallback').exists()).toBe(true)
    expect(wrapper.find('.eb-title').text()).toBe('渲染出错')
    expect(wrapper.find('.eb-msg').text()).toBe('渲染爆炸')
    expect(wrapper.find('.ok').exists()).toBe(false)
    // 组件自身留痕：console.error('[ErrorBoundary]', err)
    expect(errSpy).toHaveBeenCalled()
  })

  it('重试 → 清错重渲染；源头止血后恢复正常内容', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const boom = ref(true)
    const wrapper = mount(ErrorBoundary, {
      slots: { default: () => h(makeBoom(boom)) },
    })
    await nextTick()
    expect(wrapper.find('.eb-fallback').exists()).toBe(true)
    boom.value = false // 先止血（真实使用：修复源头），再点重试
    await wrapper.find('.eb-retry').trigger('click')
    await nextTick()
    expect(wrapper.find('.eb-fallback').exists()).toBe(false)
    expect(wrapper.find('.ok').text()).toBe('恢复后的正文')
  })
})

describe('R29-13 Toast 全局提示', () => {
  let pinia: Pinia
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    vi.useFakeTimers()
  })
  afterEach(() => {
    wrapper?.unmount()
    vi.useRealTimers()
    document.body.innerHTML = '' // 清掉 Teleport 到 body 的残留节点
  })

  function mountToast(): VueWrapper {
    wrapper = mount(Toast, { global: { plugins: [pinia] } })
    return wrapper
  }

  it('ui.toast → body 渲染 .toast（role=status），1.8s 自动消失', async () => {
    const ui = useUiStore()
    mountToast()
    ui.toast('保存成功', 'success')
    await nextTick()
    let toast = document.querySelector('.toast')
    expect(toast?.textContent).toContain('保存成功')
    expect(toast?.classList.contains('success')).toBe(true)
    expect(document.querySelector('.toast-wrap')?.getAttribute('role')).toBe('status')

    vi.advanceTimersByTime(1800)
    await nextTick()
    expect(document.querySelector('.toast')).toBeNull() // 非错误级 1.8s 消失
  })

  it('error 级 5s 时长（1.8s 仍在，5s 消失）', async () => {
    const ui = useUiStore()
    mountToast()
    ui.toast('出错了', 'error')
    await nextTick()
    expect(document.querySelector('.toast')?.classList.contains('error')).toBe(true)

    vi.advanceTimersByTime(1800)
    await nextTick()
    expect(document.querySelector('.toast')).not.toBeNull() // error 级不随 1.8s 消失

    vi.advanceTimersByTime(3200) // 累计 5000ms
    await nextTick()
    expect(document.querySelector('.toast')).toBeNull()
  })

  it('多条堆叠：各条独立计时，先到先消失', async () => {
    const ui = useUiStore()
    mountToast()
    ui.toast('第一条', 'info')
    ui.toast('第二条', 'error')
    await nextTick()
    expect(document.querySelectorAll('.toast')).toHaveLength(2)

    vi.advanceTimersByTime(1800)
    await nextTick()
    const left = [...document.querySelectorAll('.toast')].map((t) => t.textContent)
    expect(left).toEqual(['第二条']) // 非错误级先走
    vi.advanceTimersByTime(3200)
    await nextTick()
    expect(document.querySelectorAll('.toast')).toHaveLength(0)
  })
})

describe('R29-13 ConfirmDeleteModal 删除确认弹窗', () => {
  function mountModal(props: Partial<{ names: string[]; deleting: boolean; error: string | null }> = {}) {
    return mount(ConfirmDeleteModal, {
      props: {
        names: props.names ?? ['书甲', '书乙'],
        deleting: props.deleting ?? false,
        error: props.error ?? null,
      },
      // teleport stub：内容留在 wrapper 内，事件与 DOM 同体断言（VTU 惯例）
      global: { stubs: { teleport: true } },
    })
  }

  it('渲染计数文案 + 书名清单；确认/取消按钮上抛对应事件', async () => {
    const wrapper = mountModal()
    expect(wrapper.find('.confirm-text').text()).toContain('2 本书')
    expect(wrapper.findAll('.confirm-name').map((n) => n.text())).toEqual(['书甲', '书乙'])
    expect(wrapper.find('.confirm-err').exists()).toBe(false)
    expect(wrapper.find('.confirm-icon-danger').exists()).toBe(true) // 危险态图标

    await wrapper.find('.btn.danger').trigger('click')
    expect(wrapper.emitted('confirm')).toHaveLength(1)
    await wrapper.findAll('.btn')[0]!.trigger('click') // 取消按钮在首位
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('遮罩点击自身 → cancel（@click.self）', async () => {
    const wrapper = mountModal()
    await wrapper.find('.confirm-overlay').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('error prop → 错误条渲染', () => {
    const wrapper = mountModal({ error: '删除失败：网络错误' })
    expect(wrapper.find('.confirm-err').text()).toBe('删除失败：网络错误')
  })

  it('deleting=true → 双按钮禁用、确认按钮切「删除中…」', () => {
    const wrapper = mountModal({ deleting: true })
    const btns = wrapper.findAll('.btn')
    expect(btns.map((b) => (b.element as HTMLButtonElement).disabled)).toEqual([true, true])
    expect(wrapper.find('.btn.danger').text()).toBe('删除中…')
  })
})

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
})
