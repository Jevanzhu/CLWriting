// @vitest-environment happy-dom
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
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
}))
// doc store 同 import 此模块（getContent/saveContent/finalizeDoc），mock 需齐名导出
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  createDoc: vi.fn(),
  listTrash: vi.fn(),
  restoreTrash: vi.fn(),
  purgeTrash: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getBookPrefs: vi.fn(async () => ({})),
  putBookPrefs: vi.fn(async () => ({})),
  getGlobalPrefs: vi.fn(async () => ({})),
  putGlobalPrefs: vi.fn(async () => ({})),
}))
// 重评-0914-三轮 nano R7-1：ApiError 本地复刻收编——工厂改 importOriginal 展开，真类单源 src/studio/web-next/src/api/client.ts
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return {
    ...actual,
    getToken: vi.fn(() => 'test-token'),
  }
})

import WritingInfoPanel from '../../../src/studio/web-next/src/components/panels/WritingInfoPanel.vue'

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
