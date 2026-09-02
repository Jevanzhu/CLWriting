// @vitest-environment happy-dom
/**
 * R37-1（三十七轮批E）回归：flushDirty 不再跳过在途保存条目。
 *
 * 修复前：flushDirty 过滤条件 !e.saving 把「saving 中的脏条目」排除出扫描——本轮跳过、
 * failed 也不含它，调用方（Book.vue 切书守卫）以为已落盘即 setBook 清缓存，在途保存
 * 与其链式重存覆盖的编辑被静默丢失。
 * 修复后：先收集 saving 条目的在途 promise，allSettled 落定后重扫闭环。
 *
 * 数据面：(a) saving 中 flush → 等 inflight 落定后成功保存、failed 空；
 *         (b) inflight 落定失败 → flush 重试仍败 → failed 含该 docId；
 *         (c) inflight 落定后条目又变 dirty（快照后新键入）→ flush 闭环再存；
 *         (d) inflight 落成 conflict → 不进 failed（留给守卫复查口径）。
 * 组件面：Book.vue 切书链在 flushDirty 返回后复查 conflictedDirtyDocs——flush 等待
 *         窗口内落成的 conflict 走 Z-8 同款决断弹窗（确认丢弃切书 / 拒绝回退原书）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  updateChapterMetaDoc: vi.fn(),
  fetchChatHistory: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: mocks.getContent,
  saveContent: mocks.saveContent,
  finalizeDoc: mocks.finalizeDoc,
  updateChapterMetaDoc: mocks.updateChapterMetaDoc,
}))
vi.mock('../../../src/studio/web-next/src/api/chat', () => ({
  sendChat: vi.fn(),
  clearChatHistory: vi.fn(),
  confirmTool: vi.fn(),
  fetchChatHistory: mocks.fetchChatHistory,
  fetchChatBranches: vi.fn(async () => ({ branches: [], activeBranchId: null })),
  regenerateChat: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  ApiError: class ApiError extends Error {
    status = 0
    code?: string
    constructor(message: string, status: number, code?: string) {
      super(message)
      this.status = status
      this.code = code
    }
  },
  getToken: vi.fn(() => 'test-token'),
}))

// 子视图全部 stub（组件面用例只关心切书守卫编排，不渲染任何视图内容）
const stub = vi.hoisted(() => ({ template: '<div />' }))
vi.mock('../../../src/studio/web-next/src/components/shell/WorkspaceShell.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/EditorView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/WorkbenchView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/OnboardView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/OverviewView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/RelationsView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/LearnView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/StyleView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/AuditView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/composables/useHeartbeat', () => ({ useHeartbeat: vi.fn() }))
vi.mock('../../../src/studio/web-next/src/composables/useSse', () => ({ useSse: vi.fn(() => ({ resync: vi.fn() })) }))
vi.mock('../../../src/studio/web-next/src/composables/useChatTier', () => ({ useChatTier: vi.fn(() => ({ refresh: vi.fn() })) }))

// 可变路由 mock（对齐 f1-flush-failure-guard 的双路径钉法）
const routeHolder = vi.hoisted(() => ({ route: null as { params: { name: string } } | null }))
const routerMock = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock('vue-router', async () => {
  const { reactive } = await import('vue')
  routeHolder.route = reactive({ params: { name: '书A' } })
  return { useRoute: () => routeHolder.route, useRouter: () => routerMock }
})
vi.mock('../../../src/studio/web-next/node_modules/vue-router', async () => {
  const { reactive } = await import('vue')
  routeHolder.route = routeHolder.route ?? reactive({ params: { name: '书A' } })
  return { useRoute: () => routeHolder.route, useRouter: () => routerMock }
})

import Book from '../../../src/studio/web-next/src/pages/Book.vue'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import { ApiError } from '../../../src/studio/web-next/src/api/client'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

function makeNode(docId: string): TreeNode {
  return {
    path: `写作/正文/${docId}.md`,
    name: `${docId}.md`,
    isDirectory: false,
    role: 'chapter',
    docId,
    children: [],
  } as TreeNode
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  routeHolder.route!.params.name = '书A'
  mocks.getContent.mockResolvedValue('内容')
  mocks.fetchChatHistory.mockResolvedValue({ messages: [] })
})

// ── 数据面：flushDirty 等待在途保存 ────────────────────────

describe('R37-1: flushDirty 先落定在途保存再扫描', () => {
  async function openDirty(docId: string): Promise<void> {
    const doc = useDocStore()
    doc.setBook('书A')
    mocks.getContent.mockResolvedValueOnce('a')
    await doc.open(makeNode(docId))
    doc.patch(docId, '未保存内容')
  }

  it('(a) 条目 saving 中调用 flushDirty → 等 inflight 落定后成功保存，返回空 failed 且不重复发请求', async () => {
    await openDirty('d1')
    const doc = useDocStore()
    let release!: (v: { ok: true; revision: string; superseded: boolean }) => void
    const gate = new Promise<{ ok: true; revision: string; superseded: boolean }>((r) => { release = r })
    mocks.saveContent.mockImplementationOnce(() => gate)

    const saveP = doc.save('d1', 'manual') // 在途保存（saving=true、dirty=true）
    expect(doc.get('d1')!.saving).toBe(true)
    const flushP = doc.flushDirty()

    release({ ok: true, revision: 'sha256:r1', superseded: false })
    await Promise.all([saveP, flushP])

    // 修复点：在途落定后条目 clean，不重发第二笔 PUT；failed 为空（修复前该条目被
    // !e.saving 过滤出扫描、flush 空转返回，上层 setBook 清缓存即静默丢编辑）
    expect(mocks.saveContent).toHaveBeenCalledTimes(1)
    expect(await flushP).toEqual([]) // 注：flushP 已 await，此处取值断言集合语义
    expect(doc.get('d1')!.dirty).toBe(false)
  })

  it('(b) inflight 落定失败 → flushDirty 重试后仍败 → failed 含该 docId', async () => {
    await openDirty('d2')
    const doc = useDocStore()
    mocks.saveContent.mockRejectedValue(new Error('网络断了')) // 在途这笔与 flush 的重试都失败

    const saveP = doc.save('d2', 'manual') // 在途 → 落定失败（仍 dirty）
    await saveP
    expect(doc.get('d2')!.dirty).toBe(true)

    const failed = await doc.flushDirty() // 无在途的常规失败路径（对照组）
    expect(failed).toEqual(['d2'])
  })

  it('(b\') saving 中调用 flushDirty 且 inflight 落定失败 → 等待后重试、重试仍败 → failed 含该 docId', async () => {
    await openDirty('d3')
    const doc = useDocStore()
    let rejectFirst!: (e: Error) => void
    const gate = new Promise<never>((_, rej) => { rejectFirst = rej })
    mocks.saveContent.mockImplementationOnce(() => gate)
    mocks.saveContent.mockRejectedValueOnce(new Error('重试也失败'))

    const saveP = doc.save('d3', 'manual')
    const flushP = doc.flushDirty()
    rejectFirst(new Error('网络断了'))
    await Promise.allSettled([saveP, flushP])

    // 修复点：在途失败被 flush 感知并重试；重试仍败进 failed（修复前 saving 条目
    // 整轮不可见，failed 空 → 上层以为已落盘）
    expect(mocks.saveContent).toHaveBeenCalledTimes(2)
    expect(doc.get('d3')!.dirty).toBe(true)
  })

  it('(c) inflight 落定后条目又变 dirty（快照后新键入）→ flushDirty 闭环再存最新内容', async () => {
    await openDirty('d4')
    const doc = useDocStore()
    let release!: (v: { ok: true; revision: string; superseded: boolean }) => void
    const gate = new Promise<{ ok: true; revision: string; superseded: boolean }>((r) => { release = r })
    mocks.saveContent.mockImplementationOnce(() => gate)
    mocks.saveContent.mockResolvedValueOnce({ ok: true, revision: 'sha256:r2', superseded: false })

    const saveP = doc.save('d4', 'manual')
    doc.patch('d4', '快照后的新键入') // 在途快照不含这段
    const flushP = doc.flushDirty()
    release({ ok: true, revision: 'sha256:r1', superseded: false })
    await Promise.all([saveP, flushP])

    // 修复点：在途成功但 content !== snapshot → dirty 残留，flush 重扫补存新内容
    expect(mocks.saveContent).toHaveBeenCalledTimes(2)
    const secondBody = mocks.saveContent.mock.calls[1]![2] as { content: string }
    expect(secondBody.content).toBe('快照后的新键入')
    expect(doc.get('d4')!.dirty).toBe(false)
  })

  it('(d) inflight 落成 REVISION_CONFLICT → 不进 failed（conflict 留给 Book.vue 复查口径）', async () => {
    await openDirty('d5')
    const doc = useDocStore()
    mocks.saveContent.mockRejectedValueOnce(new ApiError('conflict', 409, 'REVISION_CONFLICT'))

    const saveP = doc.save('d5', 'manual')
    const flushP = doc.flushDirty()
    await Promise.allSettled([saveP, flushP])

    expect(await doc.flushDirty()).toEqual([]) // conflict 不算 failed（另有 conflictedDirtyDocs 口径）
    expect(doc.get('d5')!.conflict).toBe(true)
    expect(doc.get('d5')!.dirty).toBe(true)
  })
})

// ── 组件面：Book.vue flush 后复查冲突（Z-8 同款决断） ────────────────────────

describe('R37-1: Book.vue 切书守卫——flush 等待窗口内落成的 conflict 走决断弹窗', () => {
  async function openDirty(doc: ReturnType<typeof useDocStore>): Promise<void> {
    mocks.getContent.mockResolvedValueOnce('内容')
    await doc.open(makeNode('d1'))
    doc.patch('d1', '未落盘的编辑')
  }

  /** 场景编排：在途保存挂起时切书 → flush 等待窗口内 inflight 落成 409 conflict（或成功对照） */
  async function switchBookWhileSaving(conflict: boolean): Promise<void> {
    const doc = useDocStore()
    const w = mount(Book)
    await flushPromises()
    await openDirty(doc)

    let settle!: () => void
    const gate = conflict
      ? new Promise<never>((_, rej) => { settle = () => rej(new ApiError('conflict', 409, 'REVISION_CONFLICT')) })
      : new Promise<{ ok: true; revision: string; superseded: boolean }>((res) => {
          settle = () => res({ ok: true, revision: 'sha256:x', superseded: false })
        })
    mocks.saveContent.mockImplementationOnce(() => gate)
    void doc.save('d1', 'manual') // 在途（saving=true：上方 Z-8 预检看不见）

    routeHolder.route!.params.name = '书B'
    await flushPromises() // watch 跑到 flushDirty 内部等待在途
    settle() // 在途落成 conflict（或成功对照）
    await flushPromises()
    w.unmount()
  }

  it('确认丢弃 → 冲突弹窗（Z-8 文案）后照常切书', async () => {
    const ui = useUiStore()
    const askSpy = vi.spyOn(ui, 'ask').mockResolvedValue(true)
    await switchBookWhileSaving(true)

    // 修复点：flush 返回空 failed，但复查 conflictedDirtyDocs 命中 → 弹冲突决断
    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(askSpy.mock.calls[0]![0].title).toContain('修改冲突')
    expect(useDocStore().bookName).toBe('书B') // 确认丢弃 → 照常切换
  })

  it('拒绝 → 回退路由留在原书，conflict 脏条目缓存不清（可回编辑器重载/覆盖）', async () => {
    const ui = useUiStore()
    const askSpy = vi.spyOn(ui, 'ask').mockResolvedValue(false)
    await switchBookWhileSaving(true)

    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(routerMock.replace).toHaveBeenCalledWith('/book/' + encodeURIComponent('书A'))
    const doc = useDocStore()
    expect(doc.bookName).toBe('书A')
    expect(doc.get('d1')).toBeDefined()
    expect(doc.get('d1')!.conflict).toBe(true)
  })

  it('对照：flush 等待窗口内在途保存成功（无 conflict）→ 不弹窗直接切书', async () => {
    const ui = useUiStore()
    const askSpy = vi.spyOn(ui, 'ask').mockResolvedValue(true)
    await switchBookWhileSaving(false)
    expect(askSpy).not.toHaveBeenCalled()
    expect(useDocStore().bookName).toBe('书B')
  })
})
