// @vitest-environment happy-dom
/**
 * Toast 全局提示行为族（happy-dom）。
 * （原 r29-components-zero-coverage 的 R29-13 Toast 节，按行为单拆。）
 *
 * R29-13（二十九轮批 F）：组件面零直测补齐——ui.toast 触发 → Teleport 渲染到 body
 * （.toast role=status）+ 分级自动消失（error 5s / 其余 1.8s，R76-35 口径）+ 多条
 * 堆叠各条独立计时先到先消失。Teleport 组件内容不在 wrapper.element 子树内，直接查
 * document.body。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import Toast from '../../../src/studio/web-next/src/components/ui/Toast.vue'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

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
    const toast = document.querySelector('.toast')
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
