/**
 * 杂项②回归：flushSyncOnUnload 同步落盘的总预算上限（2s）。
 *
 * 串行同步 XHR 无限排队会把页面卸载卡死在浏览器手里——加总预算，请求之间检查
 * deadline，超时放弃余下文档（尽力而为语义）。覆盖：预算内文档照常发；
 * 预算耗尽放弃余下；单文档/快速路径不受预算误伤。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  ApiError: class ApiError extends Error {},
  getToken: vi.fn(() => 'test-token'),
}))

import { getContent } from '../../../src/studio/web-next/src/api/documents'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const BOOK = 'test-book'
const calls: string[] = []

/** 模拟同步 XHR：send 即记录；每次调用推进虚拟时钟 costMs（同步请求阻塞卸载窗口）。
 *  预算检查读 Date.now()——桩掉 Date.now 让「同步 XHR 耗时」可控。 */
function stubSyncXhr(costMsPerCall: number): void {
  let now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  class FakeXHR {
    url = ''
    open(_m: string, url: string): void { this.url = url }
    setRequestHeader(): void {}
    send(): void {
      calls.push(this.url.split('/documents/')[1]?.split('/content')[0] ?? '')
      now += costMsPerCall // 同步 XHR 阻塞：时间流逝
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
}

async function openDirty(docId: string): Promise<void> {
  const doc = useDocStore()
  doc.setBook(BOOK)
  vi.mocked(getContent).mockResolvedValueOnce('a')
  await doc.open({
    path: `写作/正文/${docId}.md`,
    name: `${docId}.md`,
    isDirectory: false,
    role: 'chapter',
    docId,
    children: [],
  } as TreeNode)
  doc.patch(docId, '未保存内容')
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  calls.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('flushSyncOnUnload · 总预算上限（2s）', () => {
  it('每次同步 XHR 阻塞 800ms：第 4 份文档超预算放弃（尽力而为，只发 3 份）', async () => {
    stubSyncXhr(800)
    for (const id of ['d1', 'd2', 'd3', 'd4']) await openDirty(id)
    useDocStore().flushSyncOnUnload()
    // 请求前查 deadline：d1(0) d2(800) d3(1600) 均在 2000ms 内发出；d4 检查时 2400ms 已超
    expect(calls).toEqual(['d1', 'd2', 'd3'])
  })

  it('每次阻塞 1200ms：第 3 份起放弃（预算检查在请求之间生效）', async () => {
    stubSyncXhr(1200)
    for (const id of ['s1', 's2', 's3']) await openDirty(id)
    useDocStore().flushSyncOnUnload()
    // s1(0) s2(1200) 发出；s3 检查时 2400ms 超预算 → 放弃（快照兜底）
    expect(calls).toEqual(['s1', 's2'])
  })

  it('单文档快速落盘不受预算影响（预算不误伤常规路径）', async () => {
    stubSyncXhr(10)
    await openDirty('only')
    useDocStore().flushSyncOnUnload()
    expect(calls).toEqual(['only'])
  })
})
