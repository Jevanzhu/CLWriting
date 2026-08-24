// @vitest-environment happy-dom
/**
 * F4（五十九轮）回归：SSE 断连窗口内 text 事件无补发，重连后 textOut 残缺——
 * sync(running=true) 置「不完整」水印（textIncomplete），阻止直接保存残文：
 *   ① store：sync running=true 置位；done/interrupted/error 收尾清除；clear 复位
 *   ② 组件：水印期间 WbDraftCard 按钮禁用 + 明示；WorkbenchView.onSaveDraft 兜底拦截
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'

const streamMocks = vi.hoisted(() => ({
  getState: vi.fn(async () => ({ nextChapter: 3 })),
  spawnRole: vi.fn(),
  interrupt: vi.fn(),
  saveDraft: vi.fn(),
  autoWrite: vi.fn(),
  getDraftPrompt: vi.fn(),
  generateOutline: vi.fn(),
  generateLeadUpdates: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/stream', () => streamMocks)
const traceMocks = vi.hoisted(() => ({ getTraceStats: vi.fn(async () => ({ ruleHits: [] })) }))
vi.mock('../../../src/studio/web-next/src/api/trace-stats', () => traceMocks)
const booksMocks = vi.hoisted(() => ({ getConfig: vi.fn(async () => ({})) }))
vi.mock('../../../src/studio/web-next/src/api/books', () => booksMocks)

import WorkbenchView from '../../../src/studio/web-next/src/views/WorkbenchView.vue'
import WbDraftCard from '../../../src/studio/web-next/src/components/workbench/WbDraftCard.vue'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useProviderStore } from '../../../src/studio/web-next/src/stores/provider'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  streamMocks.getState.mockResolvedValue({ nextChapter: 3 })
  traceMocks.getTraceStats.mockResolvedValue({ ruleHits: [] })
  vi.spyOn(useProviderStore(), 'refresh').mockResolvedValue(undefined)
  vi.spyOn(useTreeStore(), 'load').mockResolvedValue(undefined)
})

describe('F4: workbench store · textIncomplete 水印', () => {
  it('断连重连 sync(running=true) → 置位；done 收尾 → 清除', () => {
    const wb = useWorkbenchStore()
    wb.dispatch({ type: 'role_spawn', role: 'writer' })
    wb.dispatch({ type: 'text', text: '第一段' })
    // 断连（事件丢失）→ 重连，服务端仍在生成
    wb.dispatch({ type: 'sync', running: true })
    expect(wb.textIncomplete).toBe(true) // 修复点：断连窗口丢的 text 无从补回
    wb.dispatch({ type: 'text', text: '后续段落' })
    expect(wb.textIncomplete).toBe(true) // 收尾前保持
    wb.dispatch({ type: 'done' })
    expect(wb.textIncomplete).toBe(false) // 本轮生成收尾解除
  })

  it('interrupted / error 收尾同样解除；clear 复位', () => {
    const wb = useWorkbenchStore()
    wb.dispatch({ type: 'sync', running: true })
    expect(wb.textIncomplete).toBe(true)
    wb.dispatch({ type: 'interrupted' })
    expect(wb.textIncomplete).toBe(false)
    wb.dispatch({ type: 'sync', running: true })
    wb.dispatch({ type: 'error', error: 'x' })
    expect(wb.textIncomplete).toBe(false)
    wb.dispatch({ type: 'sync', running: true })
    wb.clear()
    expect(wb.textIncomplete).toBe(false)
  })

  it('未经历断连（正常事件流）→ 不置位（水印不误伤）', () => {
    const wb = useWorkbenchStore()
    wb.dispatch({ type: 'role_spawn', role: 'writer' })
    wb.dispatch({ type: 'text', text: '完整流' })
    expect(wb.textIncomplete).toBe(false)
    wb.dispatch({ type: 'done' })
    expect(wb.textIncomplete).toBe(false)
  })
})

describe('F4: 组件面 · 水印期间阻止保存残文', () => {
  it('WbDraftCard：水印期间按钮禁用 + 明示原因', async () => {
    const wb = useWorkbenchStore()
    wb.textOut = '残缺正文'
    wb.textIncomplete = true
    const w = mount(WbDraftCard, { props: { draftSaved: null } })
    const btn = w.find('button')
    expect((btn.element as HTMLButtonElement).disabled).toBe(true) // 修复点：禁存残文
    expect(w.find('.incomplete').text()).toContain('不完整')
    w.unmount()
  })

  it('WorkbenchView.onSaveDraft：水印期间兜底拦截（不调 saveDraft，toast 提示）', async () => {
    const wb = useWorkbenchStore()
    const ui = useUiStore()
    wb.textOut = '残缺正文'
    wb.textIncomplete = true
    const w = mount(WorkbenchView, {
      props: { bookName: '书A' },
      global: {
        stubs: { ChatPanel: true, WbStateCard: true, WbAdvanced: true, WbHealCard: true, WbUsageCard: true },
      },
    })
    await flushPromises()
    // 按钮已禁，直发 save 事件模拟键盘/未来入口绕过——onSaveDraft 内的兜底守卫须拦下
    w.findComponent(WbDraftCard).vm.$emit('save')
    await flushPromises()
    expect(streamMocks.saveDraft).not.toHaveBeenCalled() // 修复点：残文不落盘
    expect(ui.toasts.some((t) => t.msg.includes('不完整'))).toBe(true)
    w.unmount()
  })
})
