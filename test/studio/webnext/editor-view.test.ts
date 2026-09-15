// @vitest-environment happy-dom
/**
 * EditorView 组件测试（cc 轮批 3 补强）：持久化 activeDocId 恢复竞态。
 *
 * CC-P1-4：书打开时 getBookPrefs（快）可能先于 tree.load（慢，大书含 git status
 * + 全盘字数）返回——prefs 把 activeDocId 顶上时 byDocId 仍为空，旧实现 watch 仅挂
 * props.docId，触发一次空查找后静默放弃，树到达后无补偿重试 → 编辑器停留空态，
 * 作者需手动点树。修复：watch 同时挂 tree.byDocId.get(docId)，树加载完成重触发补开。
 *
 * 本文件只测恢复竞态这一组件行为；doc store 逻辑（open/save/refresh）在 doc.test.ts。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  getConfig: vi.fn(),
  // 复审-0913-mac适配 P3-7：CmHost stub 暴露的 openSearch spy（全局查找接线断言用）
  openSearch: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: mocks.getContent,
  // 重评-0912-4 P1-1:doOpen 改走完整载荷——委托默认包装既有 getContent mock(suspect 分支默认不触发)
  getContentPayload: vi.fn(
    async (...a: Parameters<typeof mocks.getContent>) => ({ content: await mocks.getContent(...a) }),
  ),
  saveContent: mocks.saveContent,
  finalizeDoc: mocks.finalizeDoc,
  updateChapterMetaDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
  getTree: vi.fn(),
}))
// 重评-0914-三轮 nano R7-1：ApiError 本地复刻收编——工厂改 importOriginal 展开，真类单源 src/studio/web-next/src/api/client.ts
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return {
    ...actual,
    getToken: vi.fn(() => null),
  }
})
// CodeMirror 在 happy-dom 里起不来，且本测试不碰编辑器交互——stub 掉。
// 复审-0913-mac适配 P3-7：stub 按 CmHostExposed 契约 expose openSearch spy，
// 供「全局查找入口 → cmHost.openSearch」接线用例断言（模板 ref 透传 expose）。
vi.mock('../../../src/studio/web-next/src/editor/CmHost.vue', () => ({
  default: {
    name: 'CmHost',
    setup(_props: unknown, { expose }: { expose: (o: Record<string, unknown>) => void }) {
      expose({ openSearch: mocks.openSearch })
      return () => null
    },
  },
}))

import EditorView from '../../../src/studio/web-next/src/views/EditorView.vue'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { APP_FIND_EVENT } from '../../../src/studio/web-next/src/composables/useAppActions'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const BOOK = 'test-book'

function makeNode(docId: string): TreeNode {
  return {
    path: '写作/正文/第1章-标题.md',
    name: '第1章-标题.md',
    isDirectory: false,
    role: 'chapter',
    docId,
    status: 'draft',
    children: [],
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.getContent.mockReset().mockResolvedValue('---\n标题: 标题\n---\n\n正文')
  mocks.saveContent.mockReset()
  mocks.finalizeDoc.mockReset()
  mocks.getConfig.mockReset().mockResolvedValue({ kind: 'long' })
  mocks.openSearch.mockReset() // 模块级 spy 跨用例共享，逐用例清调用记录
})

describe('EditorView: activeDocId 恢复竞态（CC-P1-4）', () => {
  let w: ReturnType<typeof mount> | null = null

  // 环境拆卸前排空：用例不 unmount 时 EditorView 留在树上，测试体内未排尽的 promise 链
  // （doc.open → getContent → 状态回写 → nextTick patch）会在 happy-dom 拆卸后触发重渲染，
  // 抛 unhandled ReferenceError: Document is not defined（全量 exit=1，单跑绿——并行调度
  // 时序差，2026-09-06 win 全量实证）。卸载组件后微任务照常结算但不再 patch。
  afterEach(async () => {
    w?.unmount()
    w = null
    await flushPromises()
  })

  it('prefs 恢复先于 tree.load 到达 → 树加载完成后补开，不停留空态', async () => {
    const doc = useDocStore()
    const tree = useTreeStore()
    doc.setBook(BOOK)

    // 场景前置：EditorView 已挂载（activeDocId 尚为 null）
    w = mount(EditorView, { props: { docId: null } })
    await flushPromises()

    // prefs 恢复把 activeDocId 顶上——此时树还在路上（byDocId 空），无可打开
    await w.setProps({ docId: 'd1' })
    await flushPromises()
    expect(doc.get('d1')).toBeUndefined()
    expect(mocks.getContent).not.toHaveBeenCalled()

    // tree.load 完成：byDocId 出现 d1 → watch 重触发补开（修复前：永不触发）
    tree.raw = [makeNode('d1')]
    // 固定次数 flushPromises 在并行 worker 负载下偶发竞态（watch 补链多轮微任务），
    // 改 vi.waitFor 轮询到断言成立——语义不变（同 chat-store.test.ts 先例）
    await vi.waitFor(() => expect(doc.get('d1')).toBeDefined())
    expect(mocks.getContent).toHaveBeenCalledWith(BOOK, '写作/正文/第1章-标题.md')
  })

  it('树先到、docId 后到（正常点击/晚恢复）→ 一次 open，不重复拉取', async () => {
    const doc = useDocStore()
    const tree = useTreeStore()
    doc.setBook(BOOK)
    tree.raw = [makeNode('d1')]

    w = mount(EditorView, { props: { docId: null } })
    await flushPromises()
    await w.setProps({ docId: 'd1' })
    // 同上：waitFor 轮询替代固定 flush 次数（防并行负载下偶发未结算）
    await vi.waitFor(() => expect(doc.get('d1')).toBeDefined())
    expect(mocks.getContent).toHaveBeenCalledTimes(1)
  })
})

describe('EditorView: 全局查找入口接线（复审-0913-mac适配 P3-7）', () => {
  let w: ReturnType<typeof mount> | null = null

  // 同上（CC-P1-4 describe）：拆卸前排空，防 happy-dom 拆卸后微任务重渲染抛错
  afterEach(async () => {
    w?.unmount()
    w = null
    await flushPromises()
  })

  it('文档打开后派发 APP_FIND_EVENT → 调 CmHost.openSearch（菜单/⌘F 与右键菜单同链路）', async () => {
    const doc = useDocStore()
    const tree = useTreeStore()
    doc.setBook(BOOK)
    tree.raw = [makeNode('d1')]

    w = mount(EditorView, { props: { docId: 'd1' } })
    await flushPromises()
    await vi.waitFor(() => expect(doc.get('d1')).toBeDefined())
    expect(mocks.openSearch).not.toHaveBeenCalled() // 接线不自发触发
    window.dispatchEvent(new CustomEvent(APP_FIND_EVENT))
    expect(mocks.openSearch).toHaveBeenCalledTimes(1)
  })

  it('无活动文档（空态，cmHost 为 null）→ 派发安全 no-op，不调 openSearch', () => {
    w = mount(EditorView, { props: { docId: null } })
    expect(() => window.dispatchEvent(new CustomEvent(APP_FIND_EVENT))).not.toThrow()
    expect(mocks.openSearch).not.toHaveBeenCalled()
  })

  it('卸载后退订：再派发不再触发 openSearch（监听随组件生命周期摘除）', async () => {
    const doc = useDocStore()
    const tree = useTreeStore()
    doc.setBook(BOOK)
    tree.raw = [makeNode('d1')]

    w = mount(EditorView, { props: { docId: 'd1' } })
    await vi.waitFor(() => expect(doc.get('d1')).toBeDefined())
    w.unmount()
    w = null
    await flushPromises()
    window.dispatchEvent(new CustomEvent(APP_FIND_EVENT))
    expect(mocks.openSearch).not.toHaveBeenCalled()
  })
})
