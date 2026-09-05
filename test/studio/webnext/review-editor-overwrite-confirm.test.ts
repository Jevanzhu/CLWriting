// @vitest-environment happy-dom
/**
 * 重评-29（全库代码重评审 2026-09-05）回归：EditorDocHead「覆盖」按钮补 danger 确认。
 *
 * 此前「覆盖」是全库唯一单击即静默丢弃远端版本的入口（@click 直调
 * doc.overwriteRemote），与库内危险操作确认惯例不一致（useChatComposer 清空对话 /
 * useChapterTreeActions 删章均 ui.ask danger 二次确认后才执行）。修复后：
 * - 点「覆盖」→ 先 ui.ask（danger，文案点名「丢弃服务器上的远端版本，以本地内容为准」），
 *   不直接调 overwriteRemote；
 * - ask 取消 → overwriteRemote 不被调；ask 确认 → overwriteRemote(docId) 被调；
 * - 确认弹窗开着连点「覆盖」→ ask 仍只一次（overwriting 旗防重复触发，:disabled
 *   在 dispatchEvent 下不拦 handler，防重入靠 handler 自身守卫）；
 * - 「重载」出路不受影响（丢的是可重拉的本地未存内容，保持单击直调）。
 * 手法：直挂 EditorDocHead（不经 EditorView 巨石）+ pinia 真实 store + spyOn(ui,'ask')
 * （vitest spyOn 默认透传原实现：confirmState 真开弹窗、resolveConfirm 收口，同时留调用记录）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  updateChapterMetaDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  // 本测试不触网，doc store 仅在保存链用 instanceof ApiError——mock 同构即可（doc.test.ts 先例）
  ApiError: class ApiError extends Error {
    status = 0
    code?: string
  },
  getToken: vi.fn(() => null),
}))

import { getContent } from '../../../src/studio/web-next/src/api/documents'
import EditorDocHead from '../../../src/studio/web-next/src/components/editor/EditorDocHead.vue'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const BOOK = 'test-book'

function makeNode(docId: string): TreeNode {
  return {
    path: '写作/正文/0001-标题.md',
    name: '0001-标题.md',
    isDirectory: false,
    role: 'chapter',
    docId,
    status: 'draft',
    children: [],
  }
}

/** 挂一台带冲突未决 entry 的顶栏卡：open 建缓存后置 conflict=true（外部修改未决）。 */
async function mountHeadWithConflict(): Promise<{
  w: VueWrapper
  doc: ReturnType<typeof useDocStore>
  ui: ReturnType<typeof useUiStore>
}> {
  const doc = useDocStore()
  doc.setBook(BOOK)
  vi.mocked(getContent).mockResolvedValue('---\n标题: 标题\n---\n正文')
  await doc.open(makeNode('d1'))
  const e = doc.get('d1')!
  e.conflict = true
  const w = mount(EditorDocHead, {
    props: { docId: 'd1', bookKind: 'long', wordCount: 100, title: '标题' },
  })
  return { w, doc, ui: useUiStore() }
}

function overwriteBtn(w: VueWrapper) {
  const btn = w.findAll('button.conflict-btn').find((b) => b.text() === '覆盖')
  expect(btn, '冲突未决时应渲染「覆盖」按钮').toBeDefined()
  return btn!
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('重评-29: 覆盖按钮 danger 确认', () => {
  it('点「覆盖」→ ui.ask 被调（danger + 文案点名丢弃远端版本），确认前不落 overwriteRemote', async () => {
    const { w, doc, ui } = await mountHeadWithConflict()
    const askSpy = vi.spyOn(ui, 'ask')
    const overwriteSpy = vi.spyOn(doc, 'overwriteRemote').mockResolvedValue(undefined)

    await overwriteBtn(w).trigger('click')
    await flushPromises()

    expect(askSpy).toHaveBeenCalledTimes(1)
    const opts = askSpy.mock.calls[0]![0]!
    expect(opts.danger).toBe(true)
    expect(opts.message).toContain('远端版本')
    expect(opts.message).toContain('本地内容为准')
    // 确认弹窗开着（confirmState 挂起），覆盖动作等确认
    expect(ui.confirmState).not.toBeNull()
    expect(overwriteSpy).not.toHaveBeenCalled()
    ui.resolveConfirm(false) // 收口挂起 promise，防跨用例泄漏
    w.unmount()
  })

  it('ask 取消 → overwriteRemote 不被调', async () => {
    const { w, doc, ui } = await mountHeadWithConflict()
    const overwriteSpy = vi.spyOn(doc, 'overwriteRemote').mockResolvedValue(undefined)

    await overwriteBtn(w).trigger('click')
    ui.resolveConfirm(false)
    await flushPromises()

    expect(overwriteSpy).not.toHaveBeenCalled()
    expect(ui.confirmState).toBeNull() // 弹窗已收口
    w.unmount()
  })

  it('ask 确认 → overwriteRemote(docId) 被调一次', async () => {
    const { w, doc, ui } = await mountHeadWithConflict()
    const overwriteSpy = vi.spyOn(doc, 'overwriteRemote').mockResolvedValue(undefined)

    await overwriteBtn(w).trigger('click')
    ui.resolveConfirm(true)
    await flushPromises()

    expect(overwriteSpy).toHaveBeenCalledTimes(1)
    expect(overwriteSpy).toHaveBeenCalledWith('d1')
    w.unmount()
  })

  it('确认弹窗开着连点「覆盖」→ ask 仍只一次，确认后 overwriteRemote 只落一次（防重复触发）', async () => {
    const { w, doc, ui } = await mountHeadWithConflict()
    const askSpy = vi.spyOn(ui, 'ask')
    const overwriteSpy = vi.spyOn(doc, 'overwriteRemote').mockResolvedValue(undefined)

    const btn = overwriteBtn(w)
    await btn.trigger('click') // 第一次：开弹窗（overwriting 旗置位）
    await btn.trigger('click') // 第二次：handler 守卫直接短路
    expect(askSpy).toHaveBeenCalledTimes(1)

    ui.resolveConfirm(true)
    await flushPromises()
    expect(overwriteSpy).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('「重载」出路不受影响：单击直调 reloadFromRemote，不经确认', async () => {
    const { w, doc, ui } = await mountHeadWithConflict()
    const askSpy = vi.spyOn(ui, 'ask')
    const reloadSpy = vi.spyOn(doc, 'reloadFromRemote').mockResolvedValue(undefined)

    const reload = w.findAll('button.conflict-btn').find((b) => b.text() === '重载')
    await reload!.trigger('click')
    await flushPromises()

    expect(reloadSpy).toHaveBeenCalledWith('d1')
    expect(askSpy).not.toHaveBeenCalled() // 确认只加在覆盖侧，重载口径不变
    w.unmount()
  })
})
