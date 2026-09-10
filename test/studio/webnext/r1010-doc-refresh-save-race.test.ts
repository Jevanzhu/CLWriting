/**
 * R1010-P2-3（2026-09-10 全量重评 GLM-5.3 修复批）回归：doc.refresh 与在途/刚落定保存的竞态守卫。
 *
 * 修复前 refresh 入口无 e.saving 守卫、双 await（getContent/sha256Revision）后只复检书名：
 * ① 窗口内一次保存**已落定**（savedAt 推进）→ clean 分支把 e.content 整体回退到保存前的
 *   服务端内容、dirty 分支用旧哈希覆盖 doSave 刚写入的新 baselineRevision → 下次保存必吃
 *   假 REVISION_CONFLICT，作者信横幅选「重载」会丢弃真实本地编辑；
 * ② 窗口内保存**仍在途**（e.saving）→ 同款陈旧 baseline 覆盖风险。
 * 修复后：入口对齐 reloadFromRemote/overwriteRemote 守卫族（e.saving 直接拒），双 await 后
 * 复查「书名 / 条目身份 / e.saving / e.savedAt 快照」任一命中即整体放弃写回（R59 迟到结果
 * 放弃口径）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const toastSpy = vi.fn()

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
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
  useUiStore: () => ({ toast: toastSpy }),
}))

import { getContent, saveContent, type SaveOk } from '../../../src/studio/web-next/src/api/documents'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { sha256Revision } from '../../../src/studio/web-next/src/shared/revision'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

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

function stubLocalStorage(): void {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  toastSpy.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('R1010-P2-3 · refresh 与保存交叠守卫', () => {
  it('refresh 的 GET 窗口内保存已落定（savedAt 推进）→ 整体放弃写回：内容/基线不被陈旧服务端态覆盖', async () => {
    stubLocalStorage()
    const doc = useDocStore()
    doc.setBook('A书')
    vi.mocked(getContent).mockResolvedValueOnce('旧内容')
    await doc.open(makeNode('写作/正文/第1章.md', 'd1'))
    doc.patch('d1', '作者新编辑') // dirty

    let resolveGet!: (v: string) => void
    vi.mocked(getContent).mockReturnValueOnce(new Promise<string>((r) => (resolveGet = r)))
    const refreshP = doc.refresh('d1') // GET 挂起中（抓到的是保存前的服务端内容）

    // 窗口内一次手动保存落定：PUT 成功 → baseline = 新 revision、dirty 清、savedAt 推进
    vi.mocked(saveContent).mockResolvedValueOnce({ ok: true as const, revision: 'sha256:新基线' })
    await expect(doc.save('d1', 'manual')).resolves.toBe(true)

    resolveGet('旧内容') // 迟到的 refresh 响应（保存前拍的服务端快照）
    await expect(refreshP).resolves.toBe(false)

    const e = doc.get('d1')!
    expect(e.content).toBe('作者新编辑') // 修复前：clean 分支回退成「旧内容」
    expect(e.baselineRevision).toBe('sha256:新基线') // 修复前：被 hash('旧内容') 覆盖 → 下次保存假 409
    expect(e.dirty).toBe(false)
  })

  it('refresh 的 await 窗口内保存仍在途（e.saving）→ 迟到响应放弃写回，基线不动', async () => {
    stubLocalStorage()
    const doc = useDocStore()
    doc.setBook('A书')
    vi.mocked(getContent).mockResolvedValueOnce('旧内容')
    await doc.open(makeNode('写作/正文/第1章.md', 'd1'))
    const e = doc.get('d1')!
    const baseBefore = e.baselineRevision
    doc.patch('d1', '作者新编辑') // dirty → refresh 走 dirty 分支

    // refresh 先入场（saving=false 过入口闸），GET 挂起
    let resolveGet!: (v: string) => void
    vi.mocked(getContent).mockReturnValueOnce(new Promise<string>((r) => (resolveGet = r)))
    const refreshP = doc.refresh('d1')

    // 窗口内保存启动：doSave 首行同步置 e.saving=true，PUT 在途
    let resolveSave!: (v: SaveOk) => void
    vi.mocked(saveContent).mockReturnValueOnce(
      new Promise<SaveOk>((r) => (resolveSave = r)),
    )
    const saveP = doc.save('d1', 'manual')

    resolveGet('旧内容') // 迟到的服务端旧内容（保存前拍的快照）
    await expect(refreshP).resolves.toBe(false)

    expect(e.content).toBe('作者新编辑') // 合并结果不落（fm 合并放弃）
    expect(e.baselineRevision).toBe(baseBefore) // 基线不被旧哈希覆盖
    expect(e.dirty).toBe(true)

    resolveSave({ ok: true, revision: 'sha256:新基线' })
    await expect(saveP).resolves.toBe(true)
    expect(e.baselineRevision).toBe('sha256:新基线') // 保存链接管基线
  })

  it('入口闸：e.saving=true 时 refresh 直接拒（不发 GET）——对齐 reloadFromRemote 口径', async () => {
    stubLocalStorage()
    const doc = useDocStore()
    doc.setBook('A书')
    vi.mocked(getContent).mockResolvedValueOnce('旧内容')
    await doc.open(makeNode('写作/正文/第1章.md', 'd1'))
    doc.patch('d1', '作者新编辑')

    let resolveSave!: (v: SaveOk) => void
    vi.mocked(saveContent).mockReturnValueOnce(
      new Promise<SaveOk>((r) => (resolveSave = r)),
    )
    const saveP = doc.save('d1', 'manual') // saving = true

    const getCalls = vi.mocked(getContent).mock.calls.length
    await expect(doc.refresh('d1')).resolves.toBe(false)
    expect(vi.mocked(getContent).mock.calls.length).toBe(getCalls) // 未发新 GET

    resolveSave({ ok: true, revision: 'sha256:新基线' })
    await expect(saveP).resolves.toBe(true)
  })

  it('对照：无保存交叠时 refresh 照常工作（守卫不误伤常规链路）', async () => {
    stubLocalStorage()
    const doc = useDocStore()
    doc.setBook('A书')
    vi.mocked(getContent).mockResolvedValueOnce('旧内容')
    await doc.open(makeNode('写作/正文/第1章.md', 'd1'))
    doc.patch('d1', '作者新编辑')
    // 外部只改了 fm（服务端 fm 与本地不同、正文同）→ dirty 分支正常合并
    vi.mocked(getContent).mockResolvedValueOnce('---\n标题: 服务端新标题\n---\n作者新编辑')
    await expect(doc.refresh('d1')).resolves.toBe(true)
    const e = doc.get('d1')!
    expect(e.content).toContain('服务端新标题')
    expect(e.content).toContain('作者新编辑')
    expect(e.baselineRevision).toBe(await sha256Revision('---\n标题: 服务端新标题\n---\n作者新编辑'))
  })
})
