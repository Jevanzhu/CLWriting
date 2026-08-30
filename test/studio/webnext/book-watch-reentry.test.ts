// @vitest-environment happy-dom
/**
 * R26-18（二十六轮）：Book.vue 切书 watch 同书重入短路。
 *
 * 场景：切书守卫（Z-8 冲突 / F1 flush 失败）拒绝后 router.replace 回原书——路由回跳
 * 再次触发 watch(bookName)，此时 n === lastBook（书未变），修复前会把整套切书流程
 * （workbench.clear → flushDirty → setBook → 各 store clear）对「留在原书」的原书再跑
 * 一遍：作者明确选择留下，工作台态/树/对话却被清空。修复后 n === lastBook 直接返回，
 * 原书状态原封（首载 lastBook==='' 不受影响）。
 *
 * 挂载脚手架沿 f1-flush-failure-guard 先例：视图全 stub，只测切书编排。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  fetchChatHistory: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: mocks.getContent,
  saveContent: mocks.saveContent,
  finalizeDoc: mocks.finalizeDoc,
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
  },
  getToken: vi.fn(() => 'test-token'),
}))

// 子视图全部 stub（本测试只关心切书 watch 编排，不渲染任何视图内容）
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
vi.mock('../../../src/studio/web-next/src/composables/useSse', () => ({ useSse: vi.fn() }))
vi.mock('../../../src/studio/web-next/src/composables/useChatTier', () => ({
  useChatTier: vi.fn(() => ({ refresh: vi.fn() })),
}))

// 可变路由 mock：params.name 即「当前书」。reactive 代理经 hoisted 持有者暴露——
// 测试必须通过代理改值（直改原始对象不触发 Vue 依赖收集，Book.vue 的 watch 不感知）
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
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'
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

describe('R26-18: 切书守卫拒绝回退原书 → 同书重入 watch 零动作', () => {
  it('冲突拒绝 → replace 回原书 → 重入不清工作台态/文档缓存（clear 只在首载跑过 1 次）', async () => {
    const doc = useDocStore()
    const ui = useUiStore()
    const wb = useWorkbenchStore()
    const askSpy = vi.spyOn(ui, 'ask').mockResolvedValue(false)
    const clearSpy = vi.spyOn(wb, 'clear')
    const w = mount(Book)
    await flushPromises()
    expect(clearSpy).toHaveBeenCalledTimes(1) // 首载（immediate）切书流程跑过一次

    // A 书造「冲突 + dirty」文档（Z-8 形态），并留原书工作台态
    mocks.getContent.mockResolvedValueOnce('盘上内容')
    await doc.open(makeNode('d1'))
    doc.patch('d1', '本地未落盘编辑')
    doc.get('d1')!.conflict = true
    wb.textOut = 'A 书生成正文残留'

    // 请求切书 → 守卫拦截 → 拒绝 → 回退路由
    routeHolder.route!.params.name = '书B'
    await flushPromises()
    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(routerMock.replace).toHaveBeenCalledWith('/book/' + encodeURIComponent('书A'))

    // 模拟 replace 生效：路由跳回原书 → watch 重入，n === lastBook
    routeHolder.route!.params.name = '书A'
    await flushPromises()

    // 修复点：重入短路——clear 不再执行（仍只有首载 1 次），原书状态原封
    expect(clearSpy).toHaveBeenCalledTimes(1)
    expect(wb.textOut).toBe('A 书生成正文残留')
    expect(doc.bookName).toBe('书A')
    expect(doc.get('d1')).toBeDefined() // 缓存未被 setBook 清掉
    w.unmount()
  })

  it('flush 失败拒绝回退（F1 形态）→ lastBook 恢复 prev，重入短路不再重复弹窗/清态', async () => {
    const doc = useDocStore()
    const ui = useUiStore()
    const wb = useWorkbenchStore()
    const askSpy = vi.spyOn(ui, 'ask').mockResolvedValue(false)
    const clearSpy = vi.spyOn(wb, 'clear')
    const w = mount(Book)
    await flushPromises()

    // dirty（非冲突）文档 + 保存失败 → F1 守卫形态
    mocks.getContent.mockResolvedValueOnce('盘上内容')
    await doc.open(makeNode('d2'))
    doc.patch('d2', '编辑')
    mocks.saveContent.mockRejectedValue(new Error('网络断了'))

    routeHolder.route!.params.name = '书B'
    await flushPromises()
    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(routerMock.replace).toHaveBeenCalledWith('/book/' + encodeURIComponent('书A'))
    // 切书尝试本身已按第五轮口径提前 clear 过一次（clear 在 flushDirty 之前）
    const clearsAfterAttempt = clearSpy.mock.calls.length
    expect(clearsAfterAttempt).toBeGreaterThanOrEqual(1)

    routeHolder.route!.params.name = '书A'
    await flushPromises()

    // 修复点：lastBook 已恢复 prev → 重入短路，不再重跑 flushDirty/setBook/clear
    //（修复前：重入整套流程重跑——clear 多打一次 + 保存失败弹窗对已选「留下」的作者再弹一次）
    expect(clearSpy).toHaveBeenCalledTimes(clearsAfterAttempt)
    expect(askSpy).toHaveBeenCalledTimes(1) // 不重复弹「保存失败」确认
    expect(doc.bookName).toBe('书A')
    expect(doc.get('d2')!.dirty).toBe(true) // dirty 文档仍在（等作者重试保存）
    w.unmount()
  })

  it('对照：真切书（无冲突）→ 流程照常执行，守卫不误伤', async () => {
    const doc = useDocStore()
    const wb = useWorkbenchStore()
    const clearSpy = vi.spyOn(wb, 'clear')
    const w = mount(Book)
    await flushPromises()

    routeHolder.route!.params.name = '书B'
    await flushPromises()

    expect(doc.bookName).toBe('书B')
    expect(wb.textOut).toBe('') // 切书 clear 执行（残留清掉）
    expect(clearSpy).toHaveBeenCalledTimes(2) // 首载 + 本次切书
    w.unmount()
  })
})
