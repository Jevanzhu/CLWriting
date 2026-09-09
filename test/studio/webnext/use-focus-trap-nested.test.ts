// @vitest-environment happy-dom
/**
 * R8C-F2（2026-09-09 修复批）回归：嵌套浮层 Tab 焦点让渡。
 *
 * 修复前：全部 useFocusTrap 在 document capture 期无条件处理 Tab、无「上层遮罩
 * 开着则让渡」判据——设置弹窗先开（trap 先注册先执行），确认框（Teleport 到
 * body，位于设置弹窗 DOM 外）压上后，确认框内按 Tab → 下层 trap 先命中
 * 「activeElement 不在自身」→ preventDefault + 焦点拉回设置弹窗首元素，
 * 确认框内 Tab 卡死（确认钮键盘不可达）。修复：模块级活跃 trap 登记表
 *（注册序 = 浮层层级序），仅最顶层处理 Tab，下层静默让渡；上层关闭/卸载后
 * 下一层自动恢复处理权。
 *
 * 手法：双 trap 夹具（下层 A 先挂、上层 B 后挂，v-if 显隐模拟浮层开闭），
 * 真实 KeyboardEvent 直派（VTU trigger 对 Tab 的 key 透传不可靠，r50-d1 同款）。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { useFocusTrap } from '../../../src/studio/web-next/src/composables/useFocusTrap'

const Harness = defineComponent({
  setup() {
    const aOpen = ref(true) // 下层（先开：设置弹窗序）
    const bOpen = ref(false) // 上层（后开：确认框序）
    const elA = ref<HTMLElement | null>(null)
    const elB = ref<HTMLElement | null>(null)
    useFocusTrap(elA)
    useFocusTrap(elB)
    return { aOpen, bOpen, elA, elB }
  },
  template: `
    <div>
      <div v-if="aOpen" ref="elA" tabindex="-1" data-trap="a">
        <button id="a1">A1</button>
        <button id="a2">A2</button>
      </div>
      <div v-if="bOpen" ref="elB" tabindex="-1" data-trap="b">
        <button id="b1">B1</button>
        <button id="b2">B2</button>
      </div>
    </div>
  `,
})

function pressTab(shift = false): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true, shiftKey: shift })
  document.dispatchEvent(e)
  return e
}

function vmOf(w: ReturnType<typeof mount>): { aOpen: boolean; bOpen: boolean } {
  return w.vm as unknown as { aOpen: boolean; bOpen: boolean }
}

describe('R8C-F2: 嵌套浮层 Tab 顶层让渡', () => {
  it('单层：Tab 框内首尾包夹循环照常（最底层自持处理权）', async () => {
    const w = mount(Harness, { attachTo: document.body })
    await nextTick()
    expect(document.activeElement?.id).toBe('a1') // 打开自动聚焦首个可交互元素
    document.getElementById('a2')!.focus()
    const e = pressTab()
    expect(e.defaultPrevented).toBe(true)
    expect(document.activeElement?.id).toBe('a1')
    w.unmount()
  })

  it('嵌套：上层确认框内 Tab → 焦点留在上层框内（下层不得抢拉回自己框）', async () => {
    const w = mount(Harness, { attachTo: document.body })
    await nextTick()
    vmOf(w).bOpen = true // 上层浮层开（后注册 → 层级更高）
    await nextTick()
    expect(document.activeElement?.id).toBe('b1') // 后开者夺焦点

    // 上层框内中间元素按 Tab：顶层 trap 无需动作 → 不 preventDefault、
    // 焦点不得被下层 trap 拉回 a1（修复前红形态：此处 activeElement 变 a1）
    const e = pressTab()
    expect(e.defaultPrevented).toBe(false)
    expect(document.activeElement?.id).toBe('b1')

    // 上层框内末位按 Tab：顶层 trap 拦截循环回首元素（证明处理权确在上层）
    document.getElementById('b2')!.focus()
    const e2 = pressTab()
    expect(e2.defaultPrevented).toBe(true)
    expect(document.activeElement?.id).toBe('b1')
    w.unmount()
  })

  it('上层关闭 → 下层自动恢复 Tab 处理权（disposed 随 onCleanup 置位）', async () => {
    const w = mount(Harness, { attachTo: document.body })
    await nextTick()
    const vm = vmOf(w)
    vm.bOpen = true
    await nextTick()
    vm.bOpen = false // 上层关闭（ref 置 null → cleanup → disposed）
    await nextTick()
    document.getElementById('a2')!.focus()
    const e = pressTab()
    expect(e.defaultPrevented).toBe(true)
    expect(document.activeElement?.id).toBe('a1')
    w.unmount()
  })
})