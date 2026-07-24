/**
 * doc store · 保存状态机测试（T4.4 第一批）。
 *
 * 覆盖 5b9c888 审阅修复的两条主线：
 *   ① 保存竞态——save 快照对比，await 期间新输入不误清 dirty
 *   ② 冲突死锁——409 置 conflict + autosave 跳过 + 重载/覆盖两条出路
 * 以及乐观锁主链路（正式 PUT / legacy 盲写 / 前置守卫）。
 *
 * 复用根 vitest（node 环境）；shared/revision 真实跑 WebCrypto 以验证对拍口径。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  putFileBlind: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  // doc.ts 仅用 instanceof + err.code + err.message，mock 同结构即可
  ApiError: class ApiError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.name = 'ApiError'
      this.code = code
    }
  },
}))
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: () => ({ toast: vi.fn() }),
}))

import { getContent, saveContent, putFileBlind } from '../../../src/studio/web-next/src/api/documents'
import { ApiError } from '../../../src/studio/web-next/src/api/client'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { sha256Revision } from '../../../src/studio/web-next/src/shared/revision'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const BOOK = 'test-book'

function makeNode(path: string, docId: string): TreeNode {
  return {
    path,
    name: path.split('/').pop()!,
    isDirectory: false,
    docId,
    children: [],
  } as TreeNode
}

/** 打开一个文档并返回 store 引用（便于链式断言）。 */
async function openDoc(docId: string, path: string, content: string) {
  const doc = useDocStore()
  doc.setBook(BOOK)
  getContent.mockResolvedValueOnce(content)
  await doc.open(makeNode(path, docId))
  return doc
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('doc store · open / patch', () => {
  it('open 正式文档：读内容 + 算基线 revision + dirty 初始 false', async () => {
    const doc = await openDoc('d1', '定稿/正文/第1章-x.md', '正文')
    const e = doc.get('d1')!
    expect(e.content).toBe('正文')
    expect(e.dirty).toBe(false)
    expect(e.baselineRevision).toMatch(/^sha256:[0-9a-f]+$/)
    expect(e.legacy).toBe(false)
  })

  it('open legacy：baselineRevision=null + legacy=true', async () => {
    const doc = await openDoc('legacy:设定/旧.md', '设定/旧.md', 'x')
    const e = doc.get('legacy:设定/旧.md')!
    expect(e.legacy).toBe(true)
    expect(e.baselineRevision).toBeNull()
  })

  it('patch：内容变 → dirty；内容不变 → 不标', async () => {
    const doc = await openDoc('d1', '定稿/正文/第1章.md', 'a')
    doc.patch('d1', 'a')
    expect(doc.get('d1')!.dirty).toBe(false)
    doc.patch('d1', 'b')
    expect(doc.get('d1')!.dirty).toBe(true)
    expect(doc.get('d1')!.content).toBe('b')
  })
})

describe('doc store · save 前置守卫', () => {
  it('未打开 / 非 dirty → false 且不发请求', async () => {
    const doc = useDocStore()
    doc.setBook(BOOK)
    expect(await doc.save('不存在')).toBe(false)
    const opened = await openDoc('d1', '定稿/正文/第1章.md', 'a')
    expect(await opened.save('d1')).toBe(false) // 非 dirty
    expect(saveContent).not.toHaveBeenCalled()
    expect(putFileBlind).not.toHaveBeenCalled()
  })

  it('saving 中 → 不重入', async () => {
    const doc = await openDoc('d1', '定稿/正文/第1章.md', 'a')
    doc.patch('d1', 'b')
    let resolve!: (v: unknown) => void
    saveContent.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    const p = doc.save('d1') // 进行中
    expect(await doc.save('d1')).toBe(false) // 重入被拒
    resolve({ ok: true, revision: 'sha256:h', superseded: false })
    await p
  })
})

describe('doc store · save 成功', () => {
  it('正式文档：乐观锁 PUT + baseline 更新 + dirty 清', async () => {
    const doc = await openDoc('d1', '定稿/正文/第1章.md', 'a')
    const oldBase = doc.get('d1')!.baselineRevision
    doc.patch('d1', 'b')
    saveContent.mockResolvedValueOnce({ ok: true, revision: 'sha256:new', superseded: false })
    const ok = await doc.save('d1')
    expect(ok).toBe(true)
    expect(saveContent).toHaveBeenCalledWith(
      BOOK,
      'd1',
      expect.objectContaining({
        content: 'b',
        expectedRevision: oldBase,
        origin: 'manual',
      }),
    )
    const e = doc.get('d1')!
    expect(e.dirty).toBe(false)
    expect(e.baselineRevision).toBe('sha256:new')
    expect(e.savedAt).toBeTypeOf('number')
    expect(putFileBlind).not.toHaveBeenCalled()
  })

  it('legacy：降级 putFileBlind 盲写，不走 saveContent', async () => {
    const doc = await openDoc('legacy:设定/x.md', '设定/x.md', 'a')
    doc.patch('legacy:设定/x.md', 'b')
    putFileBlind.mockResolvedValueOnce({ ok: true })
    const ok = await doc.save('legacy:设定/x.md')
    expect(ok).toBe(true)
    expect(putFileBlind).toHaveBeenCalledWith(BOOK, '设定/x.md', 'b')
    expect(saveContent).not.toHaveBeenCalled()
  })
})

describe('doc store · 5b9c888 审阅修复', () => {
  it('① 保存竞态：await 期间新输入，成功后 dirty 不误清', async () => {
    const doc = await openDoc('d1', '定稿/正文/第1章.md', 'a')
    doc.patch('d1', 'b')
    let resolveSave!: (v: unknown) => void
    saveContent.mockReturnValueOnce(new Promise((r) => (resolveSave = r)))
    const p = doc.save('d1') // snapshot = 'b'
    doc.patch('d1', 'c') // await 期间继续输入
    expect(doc.get('d1')!.saving).toBe(true)
    resolveSave({ ok: true, revision: 'sha256:bhash', superseded: false })
    await p
    const e = doc.get('d1')!
    expect(e.content).toBe('c') // 新输入保留
    expect(e.dirty).toBe(true) // 关键：c 未落盘，dirty 不误清
    expect(e.baselineRevision).toBe('sha256:bhash') // 基线推进到 b
  })

  it('② 409 冲突：conflict 置位 + error 提示', async () => {
    const doc = await openDoc('d1', '定稿/正文/第1章.md', 'a')
    doc.patch('d1', 'b')
    saveContent.mockRejectedValueOnce(new ApiError('REVISION_CONFLICT', '版本冲突'))
    const ok = await doc.save('d1')
    expect(ok).toBe(false)
    const e = doc.get('d1')!
    expect(e.conflict).toBe(true)
    expect(e.error).toBe('文件已被外部修改')
  })

  it('② 冲突未决时 autosave 跳过（不再发请求）', async () => {
    const doc = await openDoc('d1', '定稿/正文/第1章.md', 'a')
    doc.patch('d1', 'b')
    saveContent.mockRejectedValueOnce(new ApiError('REVISION_CONFLICT', 'x'))
    await doc.save('d1') // 触发冲突
    saveContent.mockClear()
    expect(await doc.save('d1', 'autosave')).toBe(false)
    expect(saveContent).not.toHaveBeenCalled()
  })

  it('② 冲突出路①重载：丢弃本地修改，取远端最新', async () => {
    const doc = await openDoc('d1', '定稿/正文/第1章.md', 'a')
    doc.patch('d1', '本地改')
    const e = doc.get('d1')!
    e.conflict = true
    getContent.mockResolvedValueOnce('远端最新')
    await doc.reloadFromRemote('d1')
    expect(e.content).toBe('远端最新')
    expect(e.dirty).toBe(false)
    expect(e.conflict).toBe(false)
  })

  it('② 冲突出路②覆盖：取远端基线后写本地内容', async () => {
    const doc = await openDoc('d1', '定稿/正文/第1章.md', 'a')
    doc.patch('d1', '本地覆盖')
    const e = doc.get('d1')!
    e.conflict = true
    getContent.mockResolvedValueOnce('远端当前')
    saveContent.mockResolvedValueOnce({ ok: true, revision: 'sha256:over', superseded: false })
    await doc.overwriteRemote('d1')
    expect(e.conflict).toBe(false)
    expect(saveContent).toHaveBeenCalledWith(
      BOOK,
      'd1',
      expect.objectContaining({
        content: '本地覆盖',
        expectedRevision: await sha256Revision('远端当前'),
      }),
    )
  })

  it('非冲突错误：记录 error，不置 conflict', async () => {
    const doc = await openDoc('d1', '定稿/正文/第1章.md', 'a')
    doc.patch('d1', 'b')
    saveContent.mockRejectedValueOnce(new Error('网络断了'))
    const ok = await doc.save('d1')
    expect(ok).toBe(false)
    const e = doc.get('d1')!
    expect(e.conflict).toBe(false)
    expect(e.error).toBe('网络断了')
  })
})
