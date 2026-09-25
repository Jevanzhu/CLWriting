/**
 * doc.refresh 链路行为族——按行为合并三散落文件
 * （原 r1010-doc-refresh-save-race / r16-doc-refresh-fail-toast 的 refresh 节 /
 * r51-h3-doc-refresh-treerev，装置同构：documents/client 桩 + 真 store）。
 * （r16 的 syncCleanWithTree 节按行为归 clean-cache-reconcile.test.ts。）
 *
 * - R1010-P2-3（2026-09-10 全量重评 GLM-5.3 修复批）：doc.refresh 与在途/刚落定保存的
 *   竞态守卫。修复前 refresh 入口无 e.saving 守卫、双 await（getContent/sha256Revision）
 *   后只复检书名：窗口内保存已落定 → clean 分支把 e.content 整体回退、dirty 分支用旧哈希
 *   覆盖新 baselineRevision（下次保存必吃假 REVISION_CONFLICT）；保存仍在途 → 同款覆盖
 *   风险。修复后：入口对齐 reloadFromRemote/overwriteRemote 守卫族（e.saving 直接拒），
 *   双 await 后复查「书名/条目身份/e.saving/e.savedAt 快照」任一命中即整体放弃写回。
 * - 重审-16（2026-09-07 全量代码重审 §四.16）：refresh 失败的 UI 面——「fm 以服务端为
 *   准」的关键对齐路径失败时不再静默，toast warning「文档信息刷新失败，显示内容可能已
 *   过期」（同文案同 kind 经合并机制天然防刷屏；返回值语义不变）。
 * - R51-H-3（五十一轮）：doc.refresh 成功分支推进 treeRev（对齐 doSave 成功分支口径）
 *   ——否则 syncCleanWithTree 的 stale 过滤恒命中，refreshed 文档每次树刷新都被冗余重拉。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const getContent = vi.hoisted(() => vi.fn())
vi.mock('../../../src/studio/web-next/src/api/documents', () => {
  return {
    getContent,
    // 重评-0912-4 P1-1:doOpen 改走完整载荷——委托默认包装既有 getContent mock(suspect 分支默认不触发)
    getContentPayload: vi.fn(async (...a: Parameters<typeof getContent>) => ({ content: await getContent(...a) })),
    saveContent: vi.fn(),
    finalizeDoc: vi.fn(),
  }
})
// 重评-0914-三轮 nano R7-1：ApiError 本地复刻收编——工厂改 importOriginal 展开，真类单源 src/studio/web-next/src/api/client.ts
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return {
    ...actual,
    getToken: vi.fn(() => 'test-token'),
  }
})
// R0916-6-P2-5：ui store 不再 mock——真件 + toast 动作 spy（helpers/real-stores 纪律）

import { saveContent, type SaveOk } from '../../../src/studio/web-next/src/api/documents'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { sha256Revision } from '../../../src/studio/web-next/src/shared/revision'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'
import { setupRealStores, recordToasts } from './helpers/real-stores'

const FAIL_MSG = '文档信息刷新失败，显示内容可能已过期'

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

// dirty 镜像等 localStorage 面：Map 替身（node/happy-dom 两环境皆稳）
function createLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
}
vi.stubGlobal('localStorage', createLocalStorage())

let toastSpy: ReturnType<typeof recordToasts>

beforeEach(() => {
  vi.clearAllMocks()
  // 真 pinia + 真 store（toast 用 spy 录制，调用照常生效）
  toastSpy = recordToasts(setupRealStores().ui)
})

// ── R1010-P2-3：refresh 与保存交叠守卫 ────────────────────────

describe('R1010-P2-3 · refresh 与保存交叠守卫', () => {
  it('refresh 的 GET 窗口内保存已落定（savedAt 推进）→ 整体放弃写回：内容/基线不被陈旧服务端态覆盖', async () => {
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

// ── 重审-16：refresh 失败的 UI 面 ────────────────────────

describe('重审-16 · refresh 失败的 UI 面', () => {
  it('refresh 网络失败 → 返 false + toast warning（修复前静默无 UI 面）', async () => {
    const doc = useDocStore()
    doc.setBook('test-book')
    vi.mocked(getContent).mockResolvedValueOnce('正文')
    await doc.open(makeNode('写作/正文/0001-开篇.md', 'd1'))
    vi.mocked(getContent).mockRejectedValueOnce(new Error('fetch failed'))
    const ok = await doc.refresh('d1')
    expect(ok).toBe(false)
    expect(toastSpy).toHaveBeenCalledWith(FAIL_MSG, 'warning')
  })

  it('对照：refresh 成功 → 不 toast', async () => {
    const doc = useDocStore()
    doc.setBook('test-book')
    vi.mocked(getContent).mockResolvedValueOnce('正文')
    await doc.open(makeNode('写作/正文/0001-开篇.md', 'd1'))
    vi.mocked(getContent).mockResolvedValueOnce('新正文')
    const ok = await doc.refresh('d1')
    expect(ok).toBe(true)
    expect(toastSpy).not.toHaveBeenCalled()
  })
})

// ── R51-H-3：refresh 成功推进 treeRev ────────────────────────

describe('R51-H-3: doc.refresh 推进 treeRev', () => {
  it('clean 分支：refresh 成功 → treeRev 对齐当前树版本（旧实现停在开档时版本，syncCleanWithTree 每次树刷新判 stale 冗余重拉）', async () => {
    const doc = useDocStore()
    doc.setBook('A书')
    vi.mocked(getContent).mockResolvedValueOnce('初始内容')
    await doc.open(makeNode('写作/正文/0001-第一章.md', 'd1'))
    const e = doc.get('d1')!
    const tree = useTreeStore()
    expect(e.treeRev).toBe(tree.revision) // open 记录开档时树版本

    tree.revision = 'rev-B' // 树刷新推进版本（外部改动触发）
    vi.mocked(getContent).mockResolvedValueOnce('外部改了 fm 的新内容')
    await expect(doc.refresh('d1')).resolves.toBe(true)
    expect(e.treeRev).toBe('rev-B') // 修复点：不再停在旧版本
  })

  it('dirty 合并分支（CC-P2-15）：refresh 保留本地正文成功 → treeRev 同样推进', async () => {
    const doc = useDocStore()
    doc.setBook('A书')
    vi.mocked(getContent).mockResolvedValueOnce('---\n标题: 一\n---\n\n正文')
    await doc.open(makeNode('写作/正文/0002-第二章.md', 'd2'))
    const tree = useTreeStore()
    tree.revision = 'rev-C'
    doc.patch('d2', '---\n标题: 一\n---\n\n本地未保存编辑')
    vi.mocked(getContent).mockResolvedValueOnce('---\n标题: 一（外部改）\n---\n\n正文')
    await expect(doc.refresh('d2')).resolves.toBe(true)
    const e = doc.get('d2')!
    expect(e.dirty).toBe(true) // 本地编辑保留
    expect(e.content).toContain('本地未保存编辑')
    expect(e.treeRev).toBe('rev-C') // 修复点：dirty 分支也推进
  })
})
