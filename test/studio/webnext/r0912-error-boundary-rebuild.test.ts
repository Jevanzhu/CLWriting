// @vitest-environment happy-dom
/**
 * R0912-FE-P3-10（2026-09-11 重评-0911b 修复批）：ErrorBoundary 重试强制子树重建。
 * - 重试 = epoch++ keyed 重挂（组件重挂机制），不再只是清 error ref 的原样重渲染；
 * - 重试后同错误复现（确定性渲染错误）→ 兜底文案切「重载窗口」口径，不再引导无效重试；
 * - 重试后错误改变（新错误）→ 不误标「复现」，常规重试口径。
 * 基础兜底/恢复行为见 r29-components-zero-coverage.test.ts（R29-13，零回归）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, ref, nextTick } from 'vue'
import ErrorBoundary from '../../../src/studio/web-next/src/components/ui/ErrorBoundary.vue'

/** 可控爆炸子组件：err.value 非空时渲染抛该错误（null 正常渲染）。 */
function makeThrower(err: { value: string | null }) {
  return defineComponent({
    setup() {
      return () => {
        const msg = err.value
        if (msg) throw new Error(msg)
        return h('div', { class: 'ok' }, '恢复后的正文')
      }
    },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ErrorBoundary 重试子树重建（R0912-FE-P3-10）', () => {
  it('源头止血后重试 → 子树重挂恢复正常内容（重挂机制生效）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = ref<string | null>('渲染爆炸')
    const wrapper = mount(ErrorBoundary, {
      slots: { default: () => h(makeThrower(err)) },
    })
    await nextTick()
    expect(wrapper.find('.eb-fallback').exists()).toBe(true)
    err.value = null // 先止血
    await wrapper.find('.eb-retry').trigger('click')
    await nextTick()
    expect(wrapper.find('.eb-fallback').exists()).toBe(false)
    expect(wrapper.find('.ok').text()).toBe('恢复后的正文')
    // 正常口径：未发生复现，无「重载窗口」提示
    expect(wrapper.find('.eb-reload-hint').exists()).toBe(false)
    wrapper.unmount()
  })

  it('确定性错误：重试后同错误立即复现 → 「重载窗口」口径 + 按钮改「再次重建子树」', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = ref<string | null>('渲染爆炸')
    const wrapper = mount(ErrorBoundary, {
      slots: { default: () => h(makeThrower(err)) },
    })
    await nextTick()
    expect(wrapper.find('.eb-reload-hint').exists()).toBe(false)
    await wrapper.find('.eb-retry').trigger('click') // err 仍 true：重挂后必再炸
    await nextTick()
    await nextTick()
    expect(wrapper.find('.eb-fallback').exists()).toBe(true)
    expect(wrapper.find('.eb-msg').text()).toBe('渲染爆炸')
    expect(wrapper.find('.eb-reload-hint').exists()).toBe(true)
    expect(wrapper.find('.eb-reload-hint').text()).toContain('重载窗口')
    expect(wrapper.find('.eb-retry').text()).toContain('再次重建子树')
    wrapper.unmount()
  })

  it('重试后出现的是不同错误 → 不误标「复现」，维持常规重试口径', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = ref<string | null>('渲染爆炸')
    const wrapper = mount(ErrorBoundary, {
      slots: { default: () => h(makeThrower(err)) },
    })
    await nextTick()
    err.value = '另一种爆炸' // 重挂后是新错误（非同错误复现）
    await wrapper.find('.eb-retry').trigger('click')
    await nextTick()
    await nextTick()
    expect(wrapper.find('.eb-fallback').exists()).toBe(true)
    expect(wrapper.find('.eb-msg').text()).toBe('另一种爆炸')
    expect(wrapper.find('.eb-reload-hint').exists()).toBe(false)
    expect(wrapper.find('.eb-retry').text()).toContain('重试')
    wrapper.unmount()
  })
})
