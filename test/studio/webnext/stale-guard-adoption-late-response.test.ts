// @vitest-environment happy-dom
/**
 * R0916-7-P3-26（0916-7 批）回归：手写请求代计数换装 useStaleGuard 后，语义逐位不变
 * ——「旧请求迟到」仍被丢弃（换装不改判定，本文件钉住换装后的行为）。
 *
 * ① EditorView 顶栏书类型（原 kindReqId）：A 书 getConfig 挂起 → 切 B 书快响应落位 →
 *    A 迟归不得覆盖（P2-19 病灶：切书后顶栏 pill 显示旧书类型）。
 * ② CmHost 补全名单（原 compReqId）：A 书 getCompletionNames 挂起 → 切 B 书成功 →
 *    A 的空名单/失败迟归不得顶掉 B 的名单（F103 病灶：@ 补全弹旧书名单或整空）。
 *
 * 组件级真件挂载（真实 CM6 + 全真 store，仅假网络面）；书切守卫第三处（bookGen）的
 * 迟到用例在 book-switch-guard-segments.test.ts（同一状态机的段测面）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { EditorView as CdView } from '@codemirror/view'
import { Transaction } from '@codemirror/state'
import { CompletionContext } from '../../../src/studio/web-next/node_modules/@codemirror/autocomplete'

const mocks = vi.hoisted(() => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  getConfig: vi.fn(),
  getCompletionNames: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: mocks.getContent,
  getContentPayload: vi.fn(async (...a: Parameters<typeof mocks.getContent>) => ({
    content: await mocks.getContent(...a),
  })),
  saveContent: mocks.saveContent,
  finalizeDoc: mocks.finalizeDoc,
  updateChapterMetaDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
  getTree: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/settings')>()
  return { ...actual, getCompletionNames: mocks.getCompletionNames }
})
vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getGlobalPrefs: vi.fn(async () => ({ prefs: {}, revision: 'r0' })),
  putGlobalPrefs: vi.fn(async () => ({ revision: 'r1' })),
  getBookPrefs: vi.fn(async () => ({})),
  putBookPrefs: vi.fn(async () => ({})),
}))

import CmHost from '../../../src/studio/web-next/src/editor/CmHost.vue'
import EditorView from '../../../src/studio/web-next/src/views/EditorView.vue'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const CONTENT = '---\n标题: 第1章\n---\n\n正文'

function makeNode(docId: string): TreeNode {
  return {
    path: '写作/正文/第1章-甲.md',
    name: '第1章-甲.md',
    isDirectory: false,
    role: 'chapter',
    docId,
    status: 'draft',
    children: [],
  }
}

/** 等组件内异步链（getConfig / getCompletionNames 的 mock promise）结算。 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.getContent.mockReset().mockResolvedValue(CONTENT)
  mocks.saveContent.mockReset()
  mocks.finalizeDoc.mockReset()
  mocks.getConfig.mockReset().mockResolvedValue({ kind: 'long' })
  mocks.getCompletionNames.mockReset().mockResolvedValue({ characters: [], items: [] })
})

describe('R0916-7-P3-26: EditorView 顶栏书类型请求代（原 kindReqId）', () => {
  let w: ReturnType<typeof mount> | null = null

  // 环境拆卸前排空：未排尽的 promise 链会在 happy-dom 拆卸后重渲染抛错（editor-view.test.ts 同款）
  afterEach(async () => {
    w?.unmount()
    w = null
    await flushPromises()
  })

  it('A 书慢响应迟归不覆盖 B 书类型（切换后 pill 停在 B 书）', async () => {
    const doc = useDocStore()
    const tree = useTreeStore()
    tree.raw = [makeNode('d1')]

    let releaseA!: (v: { kind: string }) => void
    const slowA = new Promise<{ kind: string }>((r) => {
      releaseA = r
    })
    mocks.getConfig.mockImplementation((name: string) => (name === '书A' ? slowA : Promise.resolve({ kind: 'short' })))

    doc.setBook('书A')
    await doc.open(tree.byDocId.get('d1')!)
    w = mount(EditorView, { props: { docId: 'd1' } })
    await flushPromises()
    expect(mocks.getConfig).toHaveBeenCalledWith('书A') // 组件挂载即刻拉当前书类型

    // 切书：B 书快响应落位（pill = 短篇）。直拨 doc.bookName（不经 setBook）——setBook
    // 会清 docs 缓存使 entry 归空、顶栏整块（含 pill）退出渲染，pill 无从断言
    doc.bookName = '书B'
    await settle()
    expect(w.find('.book-kind').text()).toBe('短篇')

    // A 书迟归：守卫作废——不得把 旧书的「长篇」盖回 pill
    releaseA({ kind: 'long' })
    await settle()
    expect(w.find('.book-kind').text()).toBe('短篇')
  })

  it('对照：无后发请求的迟归照常落位（守卫不误伤单请求路径）', async () => {
    const doc = useDocStore()
    const tree = useTreeStore()
    tree.raw = [makeNode('d1')]
    let releaseA!: (v: { kind: string }) => void
    mocks.getConfig.mockImplementation(
      () =>
        new Promise<{ kind: string }>((r) => {
          releaseA = r
        }),
    )

    doc.setBook('书A')
    await doc.open(tree.byDocId.get('d1')!)
    w = mount(EditorView, { props: { docId: 'd1' } })
    await flushPromises()
    expect(w.find('.book-kind').exists()).toBe(false) // 未返回前无 pill

    releaseA({ kind: 'short' })
    await settle()
    expect(w.find('.book-kind').text()).toBe('短篇')
  })
})

describe('R0916-7-P3-26: CmHost 补全名单请求代（原 compReqId）', () => {
  let w: ReturnType<typeof mount> | null = null

  afterEach(async () => {
    w?.unmount()
    w = null
    await flushPromises()
  })

  function mountHost(): ReturnType<typeof mount> {
    return mount(CmHost, {
      props: { modelValue: '正文', mode: 'text', historyKey: 'd1' },
      attachTo: document.body,
    })
  }

  /** 键入 '@'（真实用户输入事务形态）后直接调用组件补全源，读它给出的候选标签表。
   *  happy-dom 下 CM6 补全的浮层/接受管线不落定（r51-i2 头注同款环境限制），故按
   *  @codemirror/autocomplete 文档明示的测试手法（CompletionContext 注释：most useful
   *  for testing completion sources）以真 CompletionContext 调源——源产出即「名单里有
   *  什么」的行为面，正是本守卫要守住的东西。 */
  async function typedAtLabels(wrapper: ReturnType<typeof mount>): Promise<string[]> {
    const el = wrapper.element.querySelector('.cm-content') as HTMLElement
    const view = CdView.findFromDOM(el)
    expect(view).not.toBeNull()
    view!.dispatch({
      changes: { from: 2, to: 2, insert: '@' },
      selection: { anchor: 3 },
      annotations: Transaction.userEvent.of('input.type'),
    })
    await settle()
    const vm = wrapper.vm as unknown as {
      characterCompletion: (c: CompletionContext) => { options?: Array<{ label: string }> } | null
    }
    const ctx = new CompletionContext(view!.state, view!.state.selection.main.head, false)
    return (vm.characterCompletion(ctx)?.options ?? []).map((o) => o.label)
  }

  it('A 书空名单迟归不顶掉 B 书名单（@ 仍能配出 B 书候选）', async () => {
    let releaseA!: (v: { characters: string[]; items: string[] }) => void
    const slowA = new Promise<{ characters: string[]; items: string[] }>((r) => {
      releaseA = r
    })
    mocks.getCompletionNames.mockImplementation((name: string) =>
      name === '书A' ? slowA : Promise.resolve({ characters: ['乙角色'], items: ['乙物品'] }),
    )
    useWorkspaceStore().bookName = '书A'
    w = mountHost()
    await settle() // A 书请求挂起

    useWorkspaceStore().bookName = '书B' // 切书 → B 书名单落位
    await settle()

    releaseA({ characters: [], items: [] }) // A 书迟归（空名单——若被采纳则 @ 无候选可配）
    await settle()

    // 修复锚：B 书名单仍在位 → 补全源仍有候选（换装前的迟归会清空名单 → 候选表为空）
    expect(await typedAtLabels(w)).toEqual(['乙角色', '乙物品'])
  })

  it('A 书失败迟归不清空 B 书名单（F103 清空判据只看现行代）', async () => {
    let rejectA!: (e: Error) => void
    const slowA = new Promise<{ characters: string[]; items: string[] }>((_r, rej) => {
      rejectA = rej
    })
    mocks.getCompletionNames.mockImplementation((name: string) =>
      name === '书A' ? slowA : Promise.resolve({ characters: ['乙角色'], items: [] }),
    )
    useWorkspaceStore().bookName = '书A'
    w = mountHost()
    await settle()

    useWorkspaceStore().bookName = '书B'
    await settle()

    rejectA(new Error('服务瞬时异常')) // A 书失败迟归
    await settle()
    await settle() // 失败链多一拍结算（catch 分支）

    expect(await typedAtLabels(w)).toEqual(['乙角色'])
  })
})
