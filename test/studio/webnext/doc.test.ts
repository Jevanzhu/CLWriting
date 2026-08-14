/**
 * doc store · 保存状态机测试（T4.4 第一批）。
 *
 * 覆盖 5b9c888 审阅修复的两条主线：
 *   ① 保存竞态——save 快照对比，await 期间新输入不误清 dirty
 *   ② 冲突死锁——409 置 conflict + autosave 跳过 + 重载/覆盖两条出路
 * 以及乐观锁主链路（正式/legacy 统一 PUT / 前置守卫）。
 *
 * 复用根 vitest（node 环境）；shared/revision 真实跑 WebCrypto 以验证对拍口径。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  // doc.ts 仅用 instanceof + err.code + err.message，mock 同结构即可
  ApiError: class ApiError extends Error {
    status: number
    code?: string
    // 与真实 client.ApiError 同构（message, status, code）——doc.ts 判 instanceof + code
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

import { getContent, saveContent, type SaveOk } from '../../../src/studio/web-next/src/api/documents'
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
    role: 'chapter',
    docId,
    children: [],
  } as TreeNode
}

/** 打开一个文档并返回 store 引用（便于链式断言）。 */
async function openDoc(docId: string, path: string, content: string) {
  const doc = useDocStore()
  doc.setBook(BOOK)
  vi.mocked(getContent).mockResolvedValueOnce(content)
  await doc.open(makeNode(path, docId))
  return doc
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('doc store · open / patch', () => {
  it('open 正式文档：读内容 + 算基线 revision + dirty 初始 false', async () => {
    const doc = await openDoc('d1', '写作/正文/第1章-x.md', '正文')
    const e = doc.get('d1')!
    expect(e.content).toBe('正文')
    expect(e.dirty).toBe(false)
    expect(e.baselineRevision).toMatch(/^sha256:[0-9a-f]+$/)
  })

  it('open legacy：同样算 baselineRevision（与正式文档一致）', async () => {
    const doc = await openDoc('legacy:设定/旧.md', '设定/旧.md', 'x')
    const e = doc.get('legacy:设定/旧.md')!
    // legacy 文档不再特殊：统一算基线 revision（保存走正常乐观锁路径）
    expect(e.baselineRevision).toMatch(/^sha256:[0-9a-f]+$/)
  })

  it('patch：内容变 → dirty；内容不变 → 不标', async () => {
    const doc = await openDoc('d1', '写作/正文/第1章.md', 'a')
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
    const opened = await openDoc('d1', '写作/正文/第1章.md', 'a')
    expect(await opened.save('d1')).toBe(false) // 非 dirty
    expect(saveContent).not.toHaveBeenCalled()
  })

  it('saving 中 → 不重入', async () => {
    const doc = await openDoc('d1', '写作/正文/第1章.md', 'a')
    doc.patch('d1', 'b')
    let resolve!: (v: SaveOk | PromiseLike<SaveOk>) => void
    vi.mocked(saveContent).mockReturnValueOnce(new Promise((r) => (resolve = r)))
    const p = doc.save('d1') // 进行中
    expect(await doc.save('d1')).toBe(false) // 重入被拒
    resolve({ ok: true, revision: 'sha256:h', superseded: false })
    await p
  })
})

describe('doc store · save 成功', () => {
  it('正式文档：乐观锁 PUT + baseline 更新 + dirty 清', async () => {
    const doc = await openDoc('d1', '写作/正文/第1章.md', 'a')
    const oldBase = doc.get('d1')!.baselineRevision
    doc.patch('d1', 'b')
    vi.mocked(saveContent).mockResolvedValueOnce({ ok: true, revision: 'sha256:new', superseded: false })
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
  })

  it('legacy：同样走 saveContent 乐观锁（不再降级盲写）', async () => {
    const doc = await openDoc('legacy:设定/x.md', '设定/x.md', 'a')
    const oldBase = doc.get('legacy:设定/x.md')!.baselineRevision
    doc.patch('legacy:设定/x.md', 'b')
    vi.mocked(saveContent).mockResolvedValueOnce({ ok: true, revision: 'sha256:new', superseded: false })
    const ok = await doc.save('legacy:设定/x.md')
    expect(ok).toBe(true)
    expect(saveContent).toHaveBeenCalledWith(
      BOOK,
      'legacy:设定/x.md',
      expect.objectContaining({
        content: 'b',
        expectedRevision: oldBase,
        origin: 'manual',
      }),
    )
  })
})

describe('doc store · 5b9c888 审阅修复', () => {
  it('① 保存竞态：await 期间新输入，成功后 dirty 不误清', async () => {
    const doc = await openDoc('d1', '写作/正文/第1章.md', 'a')
    doc.patch('d1', 'b')
    let resolveSave!: (v: SaveOk | PromiseLike<SaveOk>) => void
    vi.mocked(saveContent).mockReturnValueOnce(new Promise((r) => (resolveSave = r)))
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
    const doc = await openDoc('d1', '写作/正文/第1章.md', 'a')
    doc.patch('d1', 'b')
    vi.mocked(saveContent).mockRejectedValueOnce(new ApiError('版本冲突', 409, 'REVISION_CONFLICT'))
    const ok = await doc.save('d1')
    expect(ok).toBe(false)
    const e = doc.get('d1')!
    expect(e.conflict).toBe(true)
    expect(e.error).toBe('此文档已在其他地方修改')
  })

  it('② 冲突未决时 autosave 跳过（不再发请求）', async () => {
    const doc = await openDoc('d1', '写作/正文/第1章.md', 'a')
    doc.patch('d1', 'b')
    vi.mocked(saveContent).mockRejectedValueOnce(new ApiError('x', 409, 'REVISION_CONFLICT'))
    await doc.save('d1') // 触发冲突
    vi.mocked(saveContent).mockClear()
    expect(await doc.save('d1', 'autosave')).toBe(false)
    expect(saveContent).not.toHaveBeenCalled()
  })

  it('② 冲突出路①重载：丢弃本地修改，取远端最新', async () => {
    const doc = await openDoc('d1', '写作/正文/第1章.md', 'a')
    doc.patch('d1', '本地改')
    const e = doc.get('d1')!
    e.conflict = true
    vi.mocked(getContent).mockResolvedValueOnce('远端最新')
    await doc.reloadFromRemote('d1')
    expect(e.content).toBe('远端最新')
    expect(e.dirty).toBe(false)
    expect(e.conflict).toBe(false)
  })

  it('② 冲突出路②覆盖：取远端基线后写本地内容', async () => {
    const doc = await openDoc('d1', '写作/正文/第1章.md', 'a')
    doc.patch('d1', '本地覆盖')
    const e = doc.get('d1')!
    e.conflict = true
    vi.mocked(getContent).mockResolvedValueOnce('远端当前')
    vi.mocked(saveContent).mockResolvedValueOnce({ ok: true, revision: 'sha256:over', superseded: false })
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
    const doc = await openDoc('d1', '写作/正文/第1章.md', 'a')
    doc.patch('d1', 'b')
    vi.mocked(saveContent).mockRejectedValueOnce(new Error('网络断了'))
    const ok = await doc.save('d1')
    expect(ok).toBe(false)
    const e = doc.get('d1')!
    expect(e.conflict).toBe(false)
    expect(e.error).toBe('网络断了')
  })
})

describe('doc store · V-P1-2 卸载兜底（flushSyncOnUnload）', () => {
  interface XhrCall { method: string; url: string; headers: Record<string, string>; body: string }
  const calls: XhrCall[] = []
  class FakeXHR {
    method = ''
    url = ''
    headers: Record<string, string> = {}
    open(method: string, url: string): void { this.method = method; this.url = url }
    setRequestHeader(k: string, v: string): void { this.headers[k] = v }
    send(body: string): void { calls.push({ method: this.method, url: this.url, headers: this.headers, body }) }
  }

  beforeEach(() => {
    calls.length = 0
    vi.stubGlobal('XMLHttpRequest', FakeXHR)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('dirty 文档 → 同步 XHR PUT（正确 URL/token/乐观锁负载）', async () => {
    const doc = await openDoc('d1', '写作/正文/第1章.md', 'a')
    doc.patch('d1', '未保存内容')
    const base = doc.get('d1')!.baselineRevision
    expect(() => doc.flushSyncOnUnload()).not.toThrow()
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.method).toBe('PUT')
    expect(call.url).toBe('/api/books/test-book/documents/d1/content')
    expect(call.headers['x-studio-token']).toBe('test-token')
    const payload = JSON.parse(call.body) as { content: string; expectedRevision: string; origin: string }
    expect(payload.content).toBe('未保存内容')
    expect(payload.expectedRevision).toBe(base)
    expect(payload.origin).toBe('autosave')
  })

  it('clean / 冲突未决文档 → 跳过不发', async () => {
    const doc = await openDoc('d1', '写作/正文/第1章.md', 'a')
    doc.flushSyncOnUnload() // 非 dirty
    const doc2 = await openDoc('d2', '写作/正文/第2章.md', 'a')
    doc2.patch('d2', 'b')
    doc2.get('d2')!.conflict = true // 冲突未决：同步盲写只会再 409
    doc2.flushSyncOnUnload()
    expect(calls).toHaveLength(0)
  })

  it('XHR 抛异常 → 不中断其余文档的兜底', async () => {
    vi.stubGlobal('XMLHttpRequest', class {
      open(): void {}
      setRequestHeader(): void {}
      send(): void { throw new Error('页面正在销毁') }
    })
    const doc = await openDoc('d1', '写作/正文/第1章.md', 'a')
    doc.patch('d1', 'b')
    expect(() => doc.flushSyncOnUnload()).not.toThrow()
  })
})
