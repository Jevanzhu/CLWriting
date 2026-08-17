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

// ── CC-P2-15：refresh 本地正文保护 ──────────────────────

describe('doc store · refresh 本地正文保护（CC-P2-15）', () => {
  const FM_OLD = '---\n标题: 旧标题\n---\n\n旧正文'
  const FM_NEW = '---\n标题: 新标题\n---\n\n服务端正文'

  it('非脏：整体对齐磁盘（fm+正文都取服务端），dirty 清', async () => {
    const doc = await openDoc('d1', '写作/正文/第1章-x.md', FM_OLD)
    vi.mocked(getContent).mockResolvedValueOnce(FM_NEW)
    await doc.refresh('d1')
    const e = doc.get('d1')!
    expect(e.content).toBe(FM_NEW)
    expect(e.dirty).toBe(false)
    expect(e.baselineRevision).toBe(await sha256Revision(FM_NEW))
  })

  it('脏：只取服务端 fm，正文保留本地，dirty 不清（修复前：整体覆盖丢未保存编辑）', async () => {
    const doc = await openDoc('d1', '写作/正文/第1章-x.md', FM_OLD)
    doc.patch('d1', '---\n标题: 旧标题\n---\n\n本地未保存正文')
    vi.mocked(getContent).mockResolvedValueOnce(FM_NEW)
    await doc.refresh('d1')
    const e = doc.get('d1')!
    expect(e.content).toContain('标题: 新标题') // fm 已对齐磁盘
    expect(e.content).toContain('本地未保存正文') // 正文未被覆盖
    expect(e.content).not.toContain('服务端正文')
    expect(e.dirty).toBe(true) // 未保存编辑仍在
  })

  it('await 窗口内的键盘输入同样受保护（旧调用方守卫盖不到的微竞态）', async () => {
    const doc = await openDoc('d1', '写作/正文/第1章-x.md', FM_OLD)
    vi.mocked(getContent).mockImplementationOnce(async () => {
      // 模拟 fetch 在途时作者继续敲字（此刻才变脏）
      doc.patch('d1', '---\n标题: 旧标题\n---\n\n窗口内新输入')
      return FM_NEW
    })
    await doc.refresh('d1')
    const e = doc.get('d1')!
    expect(e.content).toContain('标题: 新标题')
    expect(e.content).toContain('窗口内新输入')
    expect(e.dirty).toBe(true)
  })

  it('脏但服务端内容与本地一致（autosave 已落）→ 正常归位 dirty=false', async () => {
    const doc = await openDoc('d1', '写作/正文/第1章-x.md', FM_OLD)
    doc.patch('d1', FM_NEW)
    vi.mocked(getContent).mockResolvedValueOnce(FM_NEW)
    await doc.refresh('d1')
    const e = doc.get('d1')!
    expect(e.content).toBe(FM_NEW)
    expect(e.dirty).toBe(false)
  })
})

// ── ee-P1-7：refresh 净分支 sha256 await 窗口竞态 ──────────────────────

describe('doc store · refresh 净分支 sha256 窗口竞态（ee-P1-7）', () => {
  it('窗口内键入：dirty 不被误清、键入内容保留（修复前：autosave/beforeunload 双兜底同跳过，关窗即丢编辑）', async () => {
    const doc = await openDoc('d1', '写作/正文/第1章-x.md', '旧内容')
    const e = doc.get('d1')!
    const oldBase = e.baselineRevision
    // 手动可控 deferred：getContent 归来后才打开净分支的 sha256 竞态窗口
    let resolveGet!: (v: string) => void
    vi.mocked(getContent).mockReturnValueOnce(new Promise<string>((r) => (resolveGet = r)))
    const p = doc.refresh('d1') // 不 await：refresh 此刻挂在 getContent 上
    resolveGet('服务端内容')
    // 微任务泵推进到净分支窗口内：content 已指向服务端值、baselineRevision 尚未推进。
    // 二者同时成立 ⇔ refresh 正挂在 await sha256Revision 上（crypto.subtle 跨宏任务才会归来），
    // patch 必须精确落在这个窗口里才复现本 bug（落早了走 dirty 分支、落晚了修复前后行为一致）
    for (let i = 0; i < 1000 && !(e.content === '服务端内容' && e.baselineRevision === oldBase); i++) {
      await Promise.resolve()
    }
    expect(e.content).toBe('服务端内容') // 已进入净分支（e.content = content 已执行）
    expect(e.baselineRevision).toBe(oldBase) // sha256 未归来：确在窗口内
    doc.patch('d1', '作者键入的内容') // 模拟窗口内作者键入（patch 置 dirty）
    await p
    expect(e.dirty).toBe(true) // 修复点：不得误清 dirty（否则状态条谎报「已保存」）
    expect(e.content).toBe('作者键入的内容') // 键入内容未被覆盖/丢弃
    // baseline 仍推进为磁盘内容指纹（冲突检测的「已知磁盘态」），与本地是否分叉无关
    expect(e.baselineRevision).toBe(await sha256Revision('服务端内容'))
  })

  it('反向对照：窗口内无键入 → dirty 归位 false、内容对齐磁盘、baseline 推进', async () => {
    const doc = await openDoc('d1', '写作/正文/第1章-x.md', '旧内容')
    const e = doc.get('d1')!
    let resolveGet!: (v: string) => void
    vi.mocked(getContent).mockReturnValueOnce(new Promise<string>((r) => (resolveGet = r)))
    const p = doc.refresh('d1')
    resolveGet('服务端内容')
    await p
    expect(e.content).toBe('服务端内容')
    expect(e.dirty).toBe(false)
    expect(e.baselineRevision).toBe(await sha256Revision('服务端内容'))
  })
})
