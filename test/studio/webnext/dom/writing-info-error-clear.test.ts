/**
 * WritingInfoPanel 切书清 err 行为族（happy-dom）。
 * （原 r34d-e2-panels 的 R34D-27 节，按行为单拆。）
 *
 * R34D-27（三十四轮批 E2）：getConfig 成功路径不清 err——A 书失败粘滞到 B 书（面板
 * 常驻不随切书重建）；修复 = 切书先清 err，新错误只由本次 catch 落位。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
}))
vi.mock('../../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
}))
// doc store 同 import 此模块（getContent/saveContent/finalizeDoc），mock 需齐名导出
vi.mock('../../../../src/studio/web-next/src/api/documents', () => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  createDoc: vi.fn(),
  listTrash: vi.fn(),
  restoreTrash: vi.fn(),
  purgeTrash: vi.fn(),
}))
vi.mock('../../../../src/studio/web-next/src/api/prefs', () => ({
  getBookPrefs: vi.fn(async () => ({})),
  putBookPrefs: vi.fn(async () => ({})),
  getGlobalPrefs: vi.fn(async () => ({})),
  putGlobalPrefs: vi.fn(async () => ({})),
}))
// 重评-0914-三轮 nano R7-1：ApiError 本地复刻收编——工厂改 importOriginal 展开，真类单源 src/studio/web-next/src/api/client.ts
vi.mock('../../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/studio/web-next/src/api/client')>()
  return {
    ...actual,
    getToken: vi.fn(() => 'test-token'),
  }
})

import WritingInfoPanel from '../../../../src/studio/web-next/src/components/panels/WritingInfoPanel.vue'
import FocusStatsBar from '../../../../src/studio/web-next/src/components/shell/FocusStatsBar.vue'
import { useWorkspaceStore } from '../../../../src/studio/web-next/src/stores/workspace'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.getConfig.mockResolvedValue({})
})

describe('R34D-27: WritingInfoPanel 成功路径清 err（A 书错误不粘滞 B 书）', () => {
  it('A 书 getConfig 失败 → 切 B 书成功 → err 清除', async () => {
    mocks.getConfig.mockRejectedValueOnce(new Error('HTTP 502')).mockResolvedValueOnce({})
    const w = mount(WritingInfoPanel, { props: { bookName: '书A' } })
    await flushPromises()
    expect(w.find('.side-hint.err').exists()).toBe(true) // A 书失败如实显示

    await w.setProps({ bookName: '书B' })
    await flushPromises()
    // 修复点：成功路径清 err——修复前 err 粘滞（面板常驻不随切书重建）
    expect(w.find('.side-hint.err').exists()).toBe(false)
    w.unmount()
  })

  it('守恒：B 书自身失败仍如实显示错误', async () => {
    mocks.getConfig.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('HTTP 502'))
    const w = mount(WritingInfoPanel, { props: { bookName: '书A' } })
    await flushPromises()
    expect(w.find('.side-hint.err').exists()).toBe(false)
    await w.setProps({ bookName: '书B' })
    await flushPromises()
    expect(w.find('.side-hint.err').exists()).toBe(true)
    w.unmount()
  })
})

// 书级配置读单源（workspace.loadBookConfig）的对外可观察面：右栏信息面板与专注统计条
// 同书常驻、挂载即各读一次 book.yaml——请求点数只应由底层 api 层承担一笔（在途合并 +
// 缓存共享），三处配置读取 = O(1) 请求，而非 O(消费方数) 笔。
describe('书级配置读单源：同书两消费方挂载 → 底层 getConfig 只发一笔', () => {
  it('WritingInfoPanel + FocusStatsBar 同书挂载 → getConfig 调用一次，两方共享同一份配置', async () => {
    const ws = useWorkspaceStore()
    ws.bookName = '书A'
    ws.activeDocId = null
    mocks.getConfig.mockResolvedValue({ book: { chapter_target_words: 2222 } })

    const panel = mount(WritingInfoPanel, { props: { bookName: '书A' } })
    const bar = mount(FocusStatsBar) // 第二消费方落在第一笔在途窗内 → 吃到同一笔
    await flushPromises()

    expect(mocks.getConfig).toHaveBeenCalledTimes(1)
    expect(mocks.getConfig).toHaveBeenCalledWith('书A')
    expect(bar.text()).toContain('2,222') // 两消费方读的是同一份配置（专注条章目标区）
    panel.unmount()
    bar.unmount()
  })
})
