// @vitest-environment happy-dom
/**
 * ErrorBoundary 错误边界行为族（happy-dom）。
 * 合并自 r29-components-zero-coverage（R29-13 节）与 r0912-error-boundary-rebuild
 * （R0912-FE-P3-10），组件同一、装置同构（可控爆炸子组件 + console.error 静音）。
 *
 * - R29-13（二十九轮批 F）：高危零直测组件补 mount 级用例——正常子组件不受影响；
 *   子组件抛错 → 兜底 UI（标题/错误消息）+ slot 停渲染 + console.error 留痕；
 *   源头止血后重试恢复正常内容。
 * - R0912-FE-P3-10（2026-09-11 重评-0911b 修复批）：重试 = epoch++ keyed 子树重建，
 *   不再只是清 error ref 的原样重渲染；重试后同错误复现（确定性渲染错误）→ 兜底文案
 *   切「重载窗口」口径 + 按钮改「再次重建子树」，不再引导无效重试；错误改变 → 不误标
 *   「复现」，维持常规重试口径。
 *
 * 合并去重：R0912 的「源头止血后重试恢复」与 R29-13 的「重试 → 清错重渲染」同行为，
 * 取并集断言（补 .eb-reload-hint 缺席检查）保留一条（-1）。
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

// ── R29-13：基础兜底/恢复 ────────────────────────

describe('R29-13 ErrorBoundary 错误边界', () => {
  it('正常子组件不受影响：无兜底 UI，slot 内容原样渲染', () => {
    const err = ref<string | null>(null)
    const wrapper = mount(ErrorBoundary, {
      slots: { default: () => h(makeThrower(err)) },
    })
    expect(wrapper.find('.eb-fallback').exists()).toBe(false)
    expect(wrapper.find('.ok').text()).toBe('恢复后的正文')
  })

  it('子组件抛错 → 兜底 UI 渲染（标题/错误消息），slot 不再渲染且 console.error 留痕', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = ref<string | null>('渲染爆炸')
    const wrapper = mount(ErrorBoundary, {
      slots: { default: () => h(makeThrower(err)) },
    })
    await nextTick() // 兜底切队 microtask flush
    expect(wrapper.find('.eb-fallback').exists()).toBe(true)
    expect(wrapper.find('.eb-title').text()).toBe('渲染出错')
    expect(wrapper.find('.eb-msg').text()).toBe('渲染爆炸')
    expect(wrapper.find('.ok').exists()).toBe(false)
    // 组件自身留痕：console.error('[ErrorBoundary]', err)
    expect(errSpy).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('重试 → 清错重渲染；源头止血后恢复正常内容', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = ref<string | null>('渲染爆炸')
    const wrapper = mount(ErrorBoundary, {
      slots: { default: () => h(makeThrower(err)) },
    })
    await nextTick()
    expect(wrapper.find('.eb-fallback').exists()).toBe(true)
    err.value = null // 先止血（真实使用：修复源头），再点重试
    await wrapper.find('.eb-retry').trigger('click')
    await nextTick()
    expect(wrapper.find('.eb-fallback').exists()).toBe(false)
    expect(wrapper.find('.ok').text()).toBe('恢复后的正文')
    // 正常口径：未发生复现，无「重载窗口」提示
    expect(wrapper.find('.eb-reload-hint').exists()).toBe(false)
    wrapper.unmount()
  })
})

// ── R0912-FE-P3-10：重试强制子树重建 ────────────────────────

describe('ErrorBoundary 重试子树重建（R0912-FE-P3-10）', () => {
  it('确定性错误：重试后同错误立即复现 → 「重载窗口」口径 + 按钮改「再次重建子树」', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = ref<string | null>('渲染爆炸')
    const wrapper = mount(ErrorBoundary, {
      slots: { default: () => h(makeThrower(err)) },
    })
    await nextTick()
    expect(wrapper.find('.eb-reload-hint').exists()).toBe(false)
    await wrapper.find('.eb-retry').trigger('click') // err 仍非空：重挂后必再炸
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
