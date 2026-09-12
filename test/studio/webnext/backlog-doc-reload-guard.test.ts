/**
 * R59 清偿批（R57-E-2）回归：reloadFromRemote 的 await 窗口守卫。
 *
 * 现状：冲突出路①「重载」在 getContent + sha256Revision 的 await 窗口内对新键入
 * 零防护——窗口内作者的键入是「重载」决断之后的新编辑，却被远端内容静默覆盖且
 * dirty 被误清（autosave / 关窗冲刷双兜底同时失明）。同文件 refresh（CC-P2-15 /
 * ee-P1-7）与 syncCleanWithTree 均已有同款窗口复检守卫，唯此处缺位。
 * 修复：决断时刻快照 content，双窗口后统一复检（切书 / 条目被替换 / 在途保存 /
 * 内容已偏离快照）命中任一即放弃覆盖。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/documents', () => {
  const getContent = vi.fn()
  return {
    getContent,
    // 重评-0912-4 P1-1:doOpen 改走完整载荷——委托默认包装既有 getContent mock(suspect 分支默认不触发)
    getContentPayload: vi.fn(async (...a: Parameters<typeof getContent>) => ({ content: await getContent(...a) })),
    saveContent: vi.fn(),
    finalizeDoc: vi.fn(),
  }
})
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  // doc.ts 仅用 instanceof + err.code，mock 同构即可（同 doc.test.ts 口径）
  ApiError: class ApiError extends Error {
    status: number
    code?: string
    constructor(message: string, status: number, code?: string) {
      super(message)
      this.name = 'ApiError'
      this.status = status
      this.code = code
    }
  },
  getToken: vi.fn(() => 'test-token'),
}))
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: () => ({ toast: vi.fn() }),
}))
vi.mock('../../../src/studio/web-next/src/stores/words', () => ({
  useWordsStore: () => ({ ensureBaseline: vi.fn(async () => {}) }),
}))

import { getContent } from '../../../src/studio/web-next/src/api/documents'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const BOOK = '书A'

function makeNode(docId: string, path = `写作/正文/${docId}.md`): TreeNode {
  return { path, name: path.split('/').pop()!, isDirectory: false, role: 'chapter', docId, children: [] } as TreeNode
}

async function openDoc(docId: string, serverContent: string) {
  const doc = useDocStore()
  doc.setBook(BOOK)
  vi.mocked(getContent).mockResolvedValueOnce(serverContent)
  await doc.open(makeNode(docId))
  return doc
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('R59 清偿批（R57-E-2）：reloadFromRemote await 窗口守卫', () => {
  it('窗口内新键入：不被远端内容静默覆盖，dirty/conflict 保留待作者重新决断（修复前被覆盖+dirty 误清）', async () => {
    const doc = await openDoc('d1', '盘上内容')
    doc.patch('d1', '本地改动')
    const e = doc.get('d1')!
    e.conflict = true
    // 手动 deferred：让 reloadFromRemote 挂在 getContent 上，制造决断后的键入窗口
    let resolveGet!: (v: string) => void
    vi.mocked(getContent).mockReturnValueOnce(new Promise<string>((r) => (resolveGet = r)))
    const p = doc.reloadFromRemote('d1')
    doc.patch('d1', '决断后的新键入') // 重载决断之后、await 归来之前的键入
    resolveGet('远端最新')
    await p
    expect(e.content).toBe('决断后的新键入') // 修复点：键入不被覆盖（修复前 = '远端最新'）
    expect(e.dirty).toBe(true) // 修复点：新键入未落盘，dirty 保留（修复前误清）
    expect(e.conflict).toBe(true) // 决断未完成：冲突保留，横幅仍在供作者重新决断
  })

  it('窗口内在途保存（saving 置位）：同样放弃覆盖，不与保存链互踩', async () => {
    const doc = await openDoc('d1', '盘上内容')
    doc.patch('d1', '本地改动')
    const e = doc.get('d1')!
    e.conflict = true
    let resolveGet!: (v: string) => void
    vi.mocked(getContent).mockReturnValueOnce(new Promise<string>((r) => (resolveGet = r)))
    const p = doc.reloadFromRemote('d1')
    e.saving = true // 模拟窗口内有保存启动（快照语义已被保存链接管）
    resolveGet('远端最新')
    await p
    expect(e.content).toBe('本地改动') // 修复前 = '远端最新'（与在途保存互踩）
    expect(e.dirty).toBe(true)
  })

  it('对照：窗口内无新键入 → 重载照常生效（远端内容落位、dirty/conflict 清）', async () => {
    const doc = await openDoc('d1', '盘上内容')
    doc.patch('d1', '本地改动')
    const e = doc.get('d1')!
    e.conflict = true
    vi.mocked(getContent).mockResolvedValueOnce('远端最新')
    await doc.reloadFromRemote('d1')
    expect(e.content).toBe('远端最新')
    expect(e.dirty).toBe(false)
    expect(e.conflict).toBe(false)
  })
})
