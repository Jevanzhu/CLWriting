// @vitest-environment happy-dom
/**
 * R1010b-FE-P2-2（2026-09-10 内存专项重审修复批）回归：useFocusTrap activeTraps 摘除。
 *
 * 修复前：浮层打开 push 登记条目，onCleanup 只置 disposed 标志从不移除——数组界 =
 * 历史打开次数（本批内存专项唯一无界堆增长点），且已卸载组件条目经 targetRef/闭包
 * 把 detached DOM 钉在堆里。修复：onCleanup 按 seq findIndex + splice 摘除本条目，
 * 活条目集合 = 并发浮层数；并补 test-only 探针 __focusTrapActiveCountForTest。
 *
 * 手法：v-if 显隐 + 组件卸载两类关闭路径（use-focus-trap-nested.test.ts 同款夹具思路），
 * 另以轻量 Tab 断言确认摘除不破坏顶层让渡（完整行为回归见该既有文件）。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import {
  useFocusTrap,
  __focusTrapActiveCountForTest,
} from '../../../src/studio/web-next/src/composables/useFocusTrap'

const ToggleHarness = defineComponent({
  setup() {
    const open = ref(false)
    const el = ref<HTMLElement | null>(null)
    useFocusTrap(el)
    return { open, el }
  },
  template: `<div v-if="open" ref="el" tabindex="-1"><button id="h1">H1</button><button id="h2">H2</button></div>`,
})

const NestedHarness = defineComponent({
  setup() {
    const aOpen = ref(false) // 下层（先开）
    const bOpen = ref(false) // 上层（后开）
    const elA = ref<HTMLElement | null>(null)
    const elB = ref<HTMLElement | null>(null)
    useFocusTrap(elA)
    useFocusTrap(elB)
    return { aOpen, bOpen, elA, elB }
  },
  template: `
    <div>
      <div v-if="aOpen" ref="elA" tabindex="-1" data-trap="a">
        <button id="a1">A1</button><button id="a2">A2</button>
      </div>
      <div v-if="bOpen" ref="elB" tabindex="-1" data-trap="b">
        <button id="b1">B1</button><button id="b2">B2</button>
      </div>
    </div>
  `,
})

function pressTab(): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  document.dispatchEvent(e)
  return e
}

describe('R1010b-FE-P2-2: activeTraps 开→关摘除（无界增长防线）', () => {
  it('开→关 N 轮后计数每轮归 0（登记不随历史打开次数累积）', async () => {
    const w = mount(ToggleHarness, { attachTo: document.body })
    const vm = w.vm as unknown as { open: boolean }
    for (let i = 0; i < 5; i++) {
      vm.open = true
      await nextTick()
      expect(__focusTrapActiveCountForTest()).toBe(1)
      vm.open = false // ref 置 null → watch cleanup → 按 seq 摘除
      await nextTick()
      expect(__focusTrapActiveCountForTest()).toBe(0) // 修复前：恒 1（残留 disposed 条目）
    }
    w.unmount()
    expect(__focusTrapActiveCountForTest()).toBe(0)
  })

  it('浮层开着时组件直接卸载：登记同样摘除', async () => {
    const w = mount(ToggleHarness, { attachTo: document.body })
    ;(w.vm as unknown as { open: boolean }).open = true
    await nextTick()
    expect(__focusTrapActiveCountForTest()).toBe(1)
    w.unmount() // 组件销毁 → watcher 停止 → cleanup 摘除
    expect(__focusTrapActiveCountForTest()).toBe(0)
  })
})

describe('R1010b-FE-P2-2: 嵌套浮层计数 + 让渡不回归', () => {
  it('外内两层同时活跃计数 2；逐层关闭归 0；Tab 让渡行为不变', async () => {
    const w = mount(NestedHarness, { attachTo: document.body })
    const vm = w.vm as unknown as { aOpen: boolean; bOpen: boolean }

    vm.aOpen = true
    await nextTick()
    expect(__focusTrapActiveCountForTest()).toBe(1)
    vm.bOpen = true
    await nextTick()
    expect(__focusTrapActiveCountForTest()).toBe(2) // 活条目 = 并发浮层数

    // 让渡：上层框内非边界按 Tab 不被下层抢拉（R8C-F2 行为保持）
    document.getElementById('b1')!.focus()
    const e = pressTab()
    expect(e.defaultPrevented).toBe(false)
    expect(document.activeElement?.id).toBe('b1')

    vm.bOpen = false
    await nextTick()
    expect(__focusTrapActiveCountForTest()).toBe(1)

    vm.aOpen = false
    await nextTick()
    expect(__focusTrapActiveCountForTest()).toBe(0)
    w.unmount()
  })
})
