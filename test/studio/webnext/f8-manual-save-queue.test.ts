/**
 * F8（五十九轮）回归：manual save（⌘S）遇在途保存不再静默 no-op——链式排在在途
 * promise 后重存一次（在途快照之后的新输入不在其负载内）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  ApiError: class ApiError extends Error {
    status = 0
    code?: string
  },
  getToken: vi.fn(() => 'test-token'),
}))
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: () => ({ toast: vi.fn() }),
}))

import { getContent, saveContent, type SaveOk } from '../../../src/studio/web-next/src/api/documents'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const OK: SaveOk = { ok: true, revision: 'sha256:x', superseded: false }

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(getContent).mockResolvedValue('a')
})

async function openDirty(): Promise<ReturnType<typeof useDocStore>> {
  const doc = useDocStore()
  doc.setBook('test-book')
  await doc.open({
    path: '写作/正文/第1章.md',
    name: '第1章.md',
    isDirectory: false,
    role: 'chapter',
    docId: 'd1',
    children: [],
  } as TreeNode)
  doc.patch('d1', 'b')
  return doc
}

describe('F8: manual save 链式排队', () => {
  it('在途 autosave 期间 ⌘S：等其完成后补存在途快照之后的新输入（修复前：静默 no-op 丢一次显式保存）', async () => {
    const doc = await openDirty()
    let resolve1!: (v: SaveOk | PromiseLike<SaveOk>) => void
    vi.mocked(saveContent)
      .mockImplementationOnce(() => new Promise((r) => (resolve1 = r)))
      .mockImplementationOnce(async () => OK)

    const p1 = doc.save('d1', 'autosave') // 在途（快照='b'）
    doc.patch('d1', 'c') // 在途窗口内新输入——不在 p1 负载内
    const p2 = doc.save('d1') // ⌘S：链式排队
    resolve1(OK)
    expect(await p2).toBe(true) // 修复点：补存 c 成功而非 no-op
    await p1

    expect(saveContent).toHaveBeenCalledTimes(2)
    const second = vi.mocked(saveContent).mock.calls[1]!
    expect(second[2]).toMatchObject({ content: 'c', origin: 'manual' })
    expect(doc.get('d1')!.dirty).toBe(false)
  })

  it('在途保存期间无新输入 → 排队后无需重存（单请求，不空转）', async () => {
    const doc = await openDirty()
    let resolve1!: (v: SaveOk | PromiseLike<SaveOk>) => void
    vi.mocked(saveContent).mockImplementationOnce(() => new Promise((r) => (resolve1 = r)))
    const p1 = doc.save('d1', 'autosave')
    const p2 = doc.save('d1') // 在途且无新输入
    resolve1(OK)
    expect(await p2).toBe(false) // 完成后已非 dirty：不再重存
    await p1
    expect(saveContent).toHaveBeenCalledTimes(1)
  })

  it('autosave 遇在途维持 no-op（节拍自会重扫，不排队）', async () => {
    const doc = await openDirty()
    let resolve1!: (v: SaveOk | PromiseLike<SaveOk>) => void
    vi.mocked(saveContent).mockImplementationOnce(() => new Promise((r) => (resolve1 = r)))
    const p1 = doc.save('d1', 'autosave')
    doc.patch('d1', 'c')
    expect(await doc.save('d1', 'autosave')).toBe(false) // 维持原语义
    resolve1(OK)
    await p1
    expect(saveContent).toHaveBeenCalledTimes(1) // 未排队重存
  })
})
