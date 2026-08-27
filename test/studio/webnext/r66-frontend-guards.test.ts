// @vitest-environment happy-dom
/**
 * 十四轮（链序 66）E 域前端守卫回归：R66-30~36。
 * - R66-30/31/32 失败 toast 书名守卫（History/MetaForm/Review 三面板 catch 漏配）
 * - R66-33 对话发送失败 + 切书 → 文本存草稿回切回填（useChatComposer）
 * - R66-34 改名前 flushDirty 失败中止（SettingsBook）
 * - R66-35 快捷插入无活动文档 → toast 反馈（ContextQuickPanel）
 * - R66-36 StyleView 死 watch 移除后 onMounted 加载仍在（:key 重建架构，见 Book.vue H-2）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import HistoryPanel from '../../../src/studio/web-next/src/components/panels/HistoryPanel.vue'
import MetaFormPanel from '../../../src/studio/web-next/src/components/panels/MetaFormPanel.vue'
import ReviewPanel from '../../../src/studio/web-next/src/components/panels/ReviewPanel.vue'
import ChatPanel from '../../../src/studio/web-next/src/components/panels/ChatPanel.vue'
import SettingsBook from '../../../src/studio/web-next/src/components/ui/SettingsBook.vue'
import ContextQuickPanel from '../../../src/studio/web-next/src/components/panels/ContextQuickPanel.vue'
import StyleView from '../../../src/studio/web-next/src/views/StyleView.vue'
import { useDocStore, type DocEntry } from '../../../src/studio/web-next/src/stores/doc'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import { useChatStore } from '../../../src/studio/web-next/src/stores/chat'
import { useStyleStore } from '../../../src/studio/web-next/src/stores/style'
import type { SnapshotEntry } from '../../../src/studio/web-next/src/api/snapshots'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

// ── mock API 层（拦截真实网络请求） ────────────────────

const mocks = vi.hoisted(() => ({
  listSnapshots: vi.fn(),
  restoreSnapshot: vi.fn(),
  updateDocMeta: vi.fn(),
  getConfig: vi.fn(),
  renameBook: vi.fn(),
  getTree: vi.fn(),
  sendChat: vi.fn(),
  confirmTool: vi.fn(),
  clearChatHistory: vi.fn(),
  interrupt: vi.fn(),
  runReview: vi.fn(),
  getReviewEnvelope: vi.fn(),
  runVerdictDoc: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/snapshots', () => ({
  listSnapshots: mocks.listSnapshots,
  restoreSnapshot: mocks.restoreSnapshot,
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  updateDocMeta: mocks.updateDocMeta,
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
  renameBook: mocks.renameBook,
  getTree: mocks.getTree,
}))
vi.mock('../../../src/studio/web-next/src/api/chat', () => ({
  sendChat: mocks.sendChat,
  confirmTool: mocks.confirmTool,
  clearChatHistory: mocks.clearChatHistory,
}))
vi.mock('../../../src/studio/web-next/src/api/stream', () => ({
  interrupt: mocks.interrupt,
}))
vi.mock('../../../src/studio/web-next/src/api/review', () => ({
  runReview: mocks.runReview,
  getReviewEnvelope: mocks.getReviewEnvelope,
  runVerdictDoc: mocks.runVerdictDoc,
}))
vi.mock('../../../src/studio/web-next/src/composables/useChatTier', () => ({
  useChatTier: () => ({
    chatTier: null,
    activeModel: 'test-model',
    activeEffort: 'low',
    models: ['test-model'],
    tierLoading: false,
    onModelChange: vi.fn(),
    onEffortChange: vi.fn(),
  }),
  EFFORT_LEVELS: ['low', 'medium', 'high'],
}))

// happy-dom localStorage 缺 clear()，Map-backed 替身（照 meta-form-panel.test 范型）
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

/** 只用到 reject 的延迟 Promise（控制「await 窗口内切书」时序） */
function deferredReject(): { reject: (e: Error) => void } {
  let reject!: (e: Error) => void
  new Promise<never>((_res, rej) => {
    reject = rej
  })
  return { reject }
}

function seedDoc(over: Partial<DocEntry> = {}): DocEntry {
  return {
    docId: 'd1',
    path: '大纲/章纲/0001-开篇.md',
    name: '开篇',
    role: 'chapter',
    mode: 'md',
    content: '---\n钩子类型: 悬念钩\n字数目标: 3000\n---\n章纲正文',
    baselineRevision: `sha256:${'a'.repeat(64)}`,
    dirty: false,
    saving: false,
    savedAt: null,
    error: null,
    conflict: false,
    ...over,
  }
}

function snap(): SnapshotEntry {
  return { id: 's1', time: Date.now(), origin: 'manual', reason: '', words: 100, pinned: false }
}

/** 正文树（ReviewPanel 可审判定用；照 review-panel.test.ts seedTree 精简版） */
function seedTree(): void {
  const tree = useTreeStore()
  const leaf: TreeNode = {
    path: '写作/正文/0001-开篇.md',
    name: '0001-开篇.md',
    isDirectory: false,
    role: '',
    children: [],
    docId: 'doc_ch1',
    status: 'draft',
  }
  tree.raw = [
    {
      path: '写作',
      name: '写作',
      isDirectory: true,
      role: '',
      children: [
        { path: '写作/正文', name: '正文', isDirectory: true, role: '', children: [leaf] },
      ],
    },
  ]
}

beforeEach(() => {
  setActivePinia(createPinia())
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.listSnapshots.mockResolvedValue([snap()])
  mocks.restoreSnapshot.mockResolvedValue(undefined)
  mocks.updateDocMeta.mockResolvedValue(undefined)
  mocks.getConfig.mockResolvedValue({})
  mocks.sendChat.mockResolvedValue(undefined)
  mocks.clearChatHistory.mockResolvedValue(undefined)
  mocks.interrupt.mockResolvedValue(undefined)
  mocks.getReviewEnvelope.mockResolvedValue(undefined)
  mocks.runVerdictDoc.mockResolvedValue(undefined)
})

// ── R66-30：HistoryPanel 恢复失败 toast 书名守卫 ───────

describe('R66-30: HistoryPanel 恢复失败 toast 书名守卫', () => {
  async function mountAndConfirm(book: string) {
    const doc = useDocStore()
    doc.docs.set('d1', seedDoc())
    const ws = useWorkspaceStore()
    ws.activeDocId = 'd1'
    const w = mount(HistoryPanel, { props: { bookName: book } })
    await flushPromises()
    await w.find('.restore-btn').trigger('click')
    useUiStore().resolveConfirm(true)
    await flushPromises() // onRestore 走到 await restoreSnapshot（挂起）
    return w
  }

  it('恢复失败且已切书 → 不在 B 书界面 toast（修复前错误打在 B 书上）', async () => {
    mocks.restoreSnapshot.mockImplementation(() => new Promise(() => {}))
    const d = deferredReject()
    mocks.restoreSnapshot.mockImplementation(
      () =>
        new Promise((_res, rej) => {
          d.reject = rej
        }),
    )
    const w = await mountAndConfirm('书甲')
    await w.setProps({ bookName: '书乙' }) // await 窗口内切书
    d.reject(new Error('恢复炸了'))
    await flushPromises()
    expect(useUiStore().toasts).toHaveLength(0)
  })

  it('恢复失败仍在原书 → error toast（对照组，守卫不误伤）', async () => {
    const d = deferredReject()
    mocks.restoreSnapshot.mockImplementation(
      () =>
        new Promise((_res, rej) => {
          d.reject = rej
        }),
    )
    await mountAndConfirm('书甲')
    d.reject(new Error('恢复炸了'))
    await flushPromises()
    const ui = useUiStore()
    expect(ui.toasts.at(-1)?.kind).toBe('error')
  })
})

// ── R66-31：MetaFormPanel 保存失败 toast 书名守卫 ──────

describe('R66-31: MetaFormPanel 保存失败 toast 书名守卫', () => {
  async function mountAndSave(book: string) {
    const doc = useDocStore()
    doc.docs.set('d1', seedDoc())
    const ws = useWorkspaceStore()
    ws.activeDocId = 'd1'
    const w = mount(MetaFormPanel, { props: { bookName: book } })
    await nextTick()
    await w.find('.save-btn').trigger('click')
    await flushPromises() // onSave 走到 await updateDocMeta（挂起）
    return w
  }

  it('保存失败且已切书 → 不在 B 书界面 toast', async () => {
    const d = deferredReject()
    mocks.updateDocMeta.mockImplementation(
      () =>
        new Promise((_res, rej) => {
          d.reject = rej
        }),
    )
    const w = await mountAndSave('书甲')
    await w.setProps({ bookName: '书乙' })
    d.reject(new Error('保存炸了'))
    await flushPromises()
    expect(useUiStore().toasts).toHaveLength(0)
  })

  it('保存失败仍在原书 → error toast（对照组）', async () => {
    const d = deferredReject()
    mocks.updateDocMeta.mockImplementation(
      () =>
        new Promise((_res, rej) => {
          d.reject = rej
        }),
    )
    await mountAndSave('书甲')
    d.reject(new Error('保存炸了'))
    await flushPromises()
    expect(useUiStore().toasts.at(-1)?.kind).toBe('error')
  })
})

// ── R66-32：ReviewPanel 裁决失败 toast 书名守卫 ────────

describe('R66-32: ReviewPanel 裁决失败 toast 书名守卫', () => {
  async function mountAndVerdict(book: string) {
    seedTree()
    const ws = useWorkspaceStore()
    ws.activeDocId = 'doc_ch1'
    const w = mount(ReviewPanel, { props: { bookName: book } })
    await flushPromises()
    await w.findAll('.rev-verdict-btn')[0]!.trigger('click') // 通过
    await flushPromises() // setVerdict 走到 await runVerdictDoc（挂起）
    return w
  }

  it('裁决失败且已切书 → 不在 B 书界面 toast', async () => {
    const d = deferredReject()
    mocks.runVerdictDoc.mockImplementation(
      () =>
        new Promise((_res, rej) => {
          d.reject = rej
        }),
    )
    const w = await mountAndVerdict('书甲')
    await w.setProps({ bookName: '书乙' })
    d.reject(new Error('裁决炸了'))
    await flushPromises()
    expect(useUiStore().toasts).toHaveLength(0)
  })

  it('裁决失败仍在原书 → error toast（对照组）', async () => {
    const d = deferredReject()
    mocks.runVerdictDoc.mockImplementation(
      () =>
        new Promise((_res, rej) => {
          d.reject = rej
        }),
    )
    await mountAndVerdict('书甲')
    d.reject(new Error('裁决炸了'))
    await flushPromises()
    expect(useUiStore().toasts.at(-1)?.kind).toBe('error')
  })
})

// ── R66-33：发送失败 + 切书 → 失败草稿回切回填 ────────

describe('R66-33: useChatComposer 失败草稿（发送失败+切书）', () => {
  it('失败时已切书 → 不误弹 B 书消息；回切原书输入框回填原文', async () => {
    const d = deferredReject()
    mocks.sendChat.mockImplementation(
      () =>
        new Promise((_res, rej) => {
          d.reject = rej
        }),
    )
    const w = mount(ChatPanel, { props: { bookName: '书甲' } })
    const textarea = w.find('.chat-input')
    await textarea.setValue('救命文稿')
    await textarea.trigger('keydown', { key: 'Enter' })
    await flushPromises() // sendChat 挂起中
    await w.setProps({ bookName: '书乙' }) // 失败返回前切书
    d.reject(new Error('发送炸了'))
    await flushPromises()
    const chat = useChatStore()
    // 书名守卫：不 popUser（B 书末条不可误弹）、不写 B 书对话区 error
    expect(chat.error).toBeNull()
    // 文本先被存草稿：此时输入框仍空
    expect((w.find('.chat-input').element as HTMLTextAreaElement).value).toBe('')
    await w.setProps({ bookName: '书甲' }) // 回切原书
    await nextTick()
    expect((w.find('.chat-input').element as HTMLTextAreaElement).value).toBe('救命文稿')
  })

  it('失败仍在原书 → popUser 回滚 + 设 error（既有行为不受影响）', async () => {
    mocks.sendChat.mockRejectedValue(new Error('发送炸了'))
    const chat = useChatStore()
    const w = mount(ChatPanel, { props: { bookName: '书丙' } })
    const textarea = w.find('.chat-input')
    await textarea.setValue('普通消息')
    await textarea.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(chat.messages).toHaveLength(0)
    expect(typeof chat.error).toBe('string')
    expect((w.find('.chat-input').element as HTMLTextAreaElement).value).toBe('')
  })
})

// ── R66-34：SettingsBook 改名前冲排失败中止 ────────────

describe('R66-34: SettingsBook 改名前 flushDirty 失败中止', () => {
  it('flushDirty 返回失败清单 → toast 报错且不发起改名（修复前照常搬目录，断救援路径）', async () => {
    const ui = useUiStore()
    ui.settingsOpen = true
    const ws = useWorkspaceStore()
    ws.bookName = '旧名'
    mocks.getConfig.mockResolvedValue({ book: { title: '旧名' } })
    vi.spyOn(useDocStore(), 'flushDirty').mockResolvedValue(['d1'])
    const w = mount(SettingsBook, { shallow: true })
    await flushPromises() // watch immediate 读 getConfig → 基线 = 旧名
    const inp = w.find('input[aria-label="书名"]')
    await inp.setValue('新名')
    await inp.trigger('change')
    await flushPromises()
    expect(mocks.renameBook).not.toHaveBeenCalled()
    const last = useUiStore().toasts.at(-1)
    expect(last?.kind).toBe('error')
    expect(last?.msg).toContain('保存失败')
  })
})

// ── R66-35：ContextQuickPanel 无活动文档反馈 ───────────

describe('R66-35: ContextQuickPanel 快捷插入无活动文档反馈', () => {
  it('无活动文档点插入 → toast 提示而非静默（修复前点击无响应）', async () => {
    const tree = useTreeStore()
    tree.raw = [
      {
        path: '设定',
        name: '设定',
        isDirectory: true,
        role: '',
        children: [
          {
            path: '设定/魔法体系.md',
            name: '魔法体系.md',
            isDirectory: false,
            role: '',
            children: [],
            docId: 'doc_s1',
          },
        ],
      },
    ]
    const ws = useWorkspaceStore()
    ws.activeDocId = null
    const requestInsert = vi.spyOn(ws, 'requestInsert')
    const w = mount(ContextQuickPanel, { props: { bookName: '书甲' } })
    await nextTick()
    await w.find('.insert-btn').trigger('click')
    const last = useUiStore().toasts.at(-1)
    expect(last?.kind).toBe('info')
    expect(last?.msg).toContain('没有打开中的文档')
    expect(requestInsert).not.toHaveBeenCalled()
  })
})

// ── R66-36：StyleView 死 watch 移除后挂载加载仍在 ───────

describe('R66-36: StyleView 挂载即加载（:key 重建架构下 onMounted 是唯一加载入口）', () => {
  it('mount → style.load(bookName) 恰好一次', async () => {
    const style = useStyleStore()
    const loadSpy = vi.spyOn(style, 'load').mockResolvedValue(null)
    mount(StyleView, { props: { bookName: '书甲' }, shallow: true })
    await flushPromises()
    expect(loadSpy).toHaveBeenCalledTimes(1)
    expect(loadSpy).toHaveBeenCalledWith('书甲')
  })
})
