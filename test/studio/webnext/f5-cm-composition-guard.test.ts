// @vitest-environment happy-dom
/**
 * F5（五十九轮）回归：CmHost 外部全量替换的 IME 组合态守卫（真实 CM6 行为级）。
 * 中文输入组合中（compositionstart → compositionend 之间）外部同步（refresh/SSE）
 * 到达：不立即整段替换（会吞组合中文本），挂起到 compositionend 后应用。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

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
})
