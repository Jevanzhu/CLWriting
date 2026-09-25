/**
 * R64-32（十二轮批 A）回归：setBook 复位 treeExpanded——切书 → 展开路径复位默认
 * （prefs 拉取失败也不带入 A 书展开态）。
 *
 * 环境说明：node 环境（无 happy-dom pragma），prefs store 按原 doc-lru-evict 惯例
 * stub（R43-14 loadBookPrefs 失败分支的 ps.apply() 直写 document，node 下会抛；
 * 本文件不测 CSS 注入）。getBookPrefs 走真实 api（node 下相对 URL fetch 必失败）
 * 恰好进失败分支。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: vi.fn(),
  getContentPayload: vi.fn(async () => ({ content: '内容' })),
  saveContent: vi.fn(),
}))
// 重评-0914-三轮 nano R7-1：ApiError 本地复刻收编——工厂改 importOriginal 展开，真类单源 src/studio/web-next/src/api/client.ts
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return {
    ...actual,
    getToken: vi.fn(() => 'test-token'),
  }
})
vi.mock('../../../src/studio/web-next/src/stores/prefs', () => ({
  usePrefsStore: () => ({
    bookPageWidth: null,
    bookAutosaveInterval: null,
    apply: vi.fn(),
  }),
}))

import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('R64-32: setBook 复位 treeExpanded', () => {
  it('切书 → 展开路径复位默认（prefs 拉取失败也不带入 A 书展开态）', () => {
    const ws = useWorkspaceStore()
    ws.bookName = '书A'
    ws.treeExpanded = ['写作/正文/第一卷', '设定']
    ws.setBook('书B')
    expect(ws.treeExpanded).toEqual(['写作'])
  })
})
