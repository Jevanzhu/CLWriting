// @vitest-environment happy-dom
/**
 * F5（五十九轮）回归：CmHost 外部全量替换的 IME 组合态守卫（真实 CM6 行为级）。
 * 中文输入组合中（compositionstart → compositionend 之间）外部同步（refresh/SSE）
 * 到达：不立即整段替换（会吞组合中文本），挂起到 compositionend 后应用。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { EditorView } from '@codemirror/view'

vi.mock('../../../src/studio/web-next/src/api/settings', () => ({
  getCompletionNames: vi.fn(async () => ({ characters: [], items: [] })),
}))

import CmHost from '../../../src/studio/web-next/src/editor/CmHost.vue'

beforeEach(() => {
  setActivePinia(createPinia())
})

function mountHost(): ReturnType<typeof mount> {
  return mount(CmHost, {
    props: { modelValue: '初文', mode: 'text', historyKey: 'd1' },
    attachTo: document.body,
  })
}

function contentEl(w: ReturnType<typeof mount>): HTMLElement {
  const el = w.element.querySelector('.cm-content')
  expect(el).not.toBeNull()
  return el as HTMLElement
}

function docText(w: ReturnType<typeof mount>): string {
  return contentEl(w).textContent ?? ''
}

describe('F5: 外部全量替换的 IME 组合态守卫', () => {
  it('组合中外部替换挂起 → compositionend 后应用（修复前：组合文本被整段替换吞掉）', async () => {
    const w = mountHost()
    expect(docText(w)).toBe('初文')

    // 进入 IME 组合态（真实 CM6 DOMObserver 侦听 contentDOM 的 composition 事件）
    contentEl(w).dispatchEvent(new Event('compositionstart', { bubbles: true }))
    await w.setProps({ modelValue: '外部全量新文' })
    await new Promise((r) => setTimeout(r, 0))
    expect(docText(w)).toBe('初文') // 修复点：组合中不替换，挂起

    contentEl(w).dispatchEvent(new Event('compositionend', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    expect(docText(w)).toBe('外部全量新文') // 组合结束后应用挂起值
    w.unmount()
  })

  it('非组合态 → 外部替换即时应用（守卫不误伤常规同步）', async () => {
    const w = mountHost()
    await w.setProps({ modelValue: '外部全量新文' })
    await new Promise((r) => setTimeout(r, 0))
    expect(docText(w)).toBe('外部全量新文')
    w.unmount()
  })

  it('B-1: 挂起后继续组字 → compositionend 应用最新值，续打组合文本不被抹掉（修复前：登记时旧快照把续打整段抹掉且不可 undo）', async () => {
    const w = mountHost()
    // 6.43.x 的公开静态方法是 findFromDOM（自 .cm-content 向上定位所属 EditorView）
    const view = EditorView.findFromDOM(contentEl(w))
    expect(view).not.toBeNull()

    contentEl(w).dispatchEvent(new Event('compositionstart', { bubbles: true }))
    // 外部全量替换到达（组合中）→ 挂起（修复前登记的快照 = '外部全量新文'）
    await w.setProps({ modelValue: '外部全量新文' })
    await new Promise((r) => setTimeout(r, 0))
    expect(docText(w)).toBe('初文') // 组合中不替换

    // 用户继续组字（真实 dispatch 进 CM6 state）→ emit 回写由父层镜像回 prop
    //（此时 v === doc，watch 不再刷新挂起标记——旧实现登记的快照因此过期）
    view!.dispatch({ changes: { from: view!.state.doc.length, insert: '续打中文' } })
    const emittedCalls = w.emitted('update:modelValue') ?? []
    const emittedText = emittedCalls[emittedCalls.length - 1]?.[0] as string
    expect(emittedText).toBe('初文续打中文')
    await w.setProps({ modelValue: emittedText })

    contentEl(w).dispatchEvent(new Event('compositionend', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    // 修复后：组合文本保留（用户续打覆盖外部变更，同 dirty 本地优先口径）
    expect(docText(w)).toBe('初文续打中文')
    w.unmount()
  })

  it('B-1/B-25: compositionend 已排定后卸载 → 延迟回调不对 destroyed view 派发、无回写无异常', async () => {
    const w = mountHost()
    contentEl(w).dispatchEvent(new Event('compositionstart', { bubbles: true }))
    await w.setProps({ modelValue: '外部全量新文' })
    contentEl(w).dispatchEvent(new Event('compositionend', { bubbles: true }))
    w.unmount() // setTimeout 仍排定；view 已 destroy 且置 null（B-25）
    const before = w.emitted('update:modelValue')?.length ?? 0
    await new Promise((r) => setTimeout(r, 0))
    expect(w.emitted('update:modelValue')?.length ?? 0).toBe(before)
  })
})
