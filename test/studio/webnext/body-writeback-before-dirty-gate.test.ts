// @vitest-environment happy-dom
/**
 * RC 源码重审 B-2 附批（mac 腿 e2e 首因）回归：防抖尾 × 「先读 dirty 再决定落盘」的决策点。
 *
 * 被测行为（源码锚 = shared/body-writeback.ts 不变量 ②b、useChapterTreeStructure.flushUnsaved、
 * useChapterTreeActions.doDelete、stores/rewrite.run、stores/workspace.openTab）：
 * 正文回写有 ≤200ms 合并窗，窗内键入只登记未落回 store（dirty 仍 false）。这四处决策点
 * 若在窗内直接读 dirty，就「既不冲刷也不保存」整段放行，动线随后按盘上缺末段的内容走。
 * mac 腿 e2e 首因即此：拆分干跑按全文偏移校验吃 400 BAD_INPUT（弹窗不开），后序
 * switch-book 因前序「收尾净零」没跑到而连坐红。
 *
 * 「窗内」态由「只登记不等待」构造（真 shared/body-writeback 槽 + commit 复刻 EditorView
 * 的落回语义），不睡表——断言与计时无关。判定一律看**落盘请求是否携带窗内正文**，
 * 改前该请求为零（dirty 判式整段跳过）。
 *
 * 桩结构：真 pinia（doc/workspace/rewrite 真 store）+ HTTP 层 mock（documents/rewrite/prefs/
 * books/client），tree 与 ui 走既有单例 mock 惯例（对齐 r44-delete-presave-dirty）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'

const treeMock = {
  byPath: new Map<string, { docId: string }>(),
  byDocId: new Map<string, { path: string }>(),
  grouped: [] as unknown[],
  raw: [] as unknown[],
  load: vi.fn(async () => {}),
  updateWordCount: vi.fn(),
}
const askMock = vi.fn(async () => true)
const toastMock = vi.fn()
vi.mock('../../../src/studio/web-next/src/api/documents', () => {
  const getContent = vi.fn(async () => '---\ntitle: 甲\n---\n初始正文')
  return {
    createDoc: vi.fn(),
    renameDoc: vi.fn(),
    moveDoc: vi.fn(),
    copyDoc: vi.fn(),
    deleteDoc: vi.fn(async () => ({ ok: true })),
    updateChapterMetaDoc: vi.fn(),
    batchFinalizeDocs: vi.fn(),
    getContent,
    // 重评-0912-4 P1-1：doOpen 走完整载荷——委托包装既有 getContent mock
    getContentPayload: vi.fn(async (...a: Parameters<typeof getContent>) => ({ content: await getContent(...a) })),
    saveContent: vi.fn(async () => ({ ok: true, revision: 'r1', superseded: false })),
    finalizeDoc: vi.fn(),
    structurePlan: vi.fn(),
    structureApply: vi.fn(),
    structureMergeUndo: vi.fn(),
  }
})
vi.mock('../../../src/studio/web-next/src/api/rewrite', () => ({
  runRewriteDoc: vi.fn(),
  reportAiVersion: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return { ...actual, getToken: vi.fn(() => 'test-token') }
})
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: vi.fn(async () => ({ kind: 'long' })),
  getTree: vi.fn(async () => ({ tree: [] })),
  renameBook: vi.fn(),
}))
// prefs：book 级（workspace 切书）+ global 级（prefs store 模块级接线）都要在
vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getBookPrefs: vi.fn(async () => ({})),
  putBookPrefs: vi.fn(async () => {}),
  getGlobalPrefs: vi.fn(async () => ({ prefs: {}, revision: 0 })),
  putGlobalPrefs: vi.fn(async () => {}),
}))
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: vi.fn(() => ({ toast: toastMock, ask: askMock })),
}))
vi.mock('../../../src/studio/web-next/src/stores/tree', () => ({
  useTreeStore: vi.fn(() => treeMock),
}))

import { saveContent, structurePlan, deleteDoc } from '../../../src/studio/web-next/src/api/documents'
import { runRewriteDoc } from '../../../src/studio/web-next/src/api/rewrite'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import { useRewriteStore } from '../../../src/studio/web-next/src/stores/rewrite'
import { useChapterTreeActions } from '../../../src/studio/web-next/src/composables/useChapterTreeActions'
import { registerBodyWriteback, scheduleBodyWriteback } from '../../../src/studio/web-next/src/shared/body-writeback'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const saveMock = saveContent as ReturnType<typeof vi.fn>
const planMock = structurePlan as ReturnType<typeof vi.fn>
const deleteMock = deleteDoc as ReturnType<typeof vi.fn>
const rewriteMock = runRewriteDoc as ReturnType<typeof vi.fn>

const BOOK = '书A'
const WINDOWED = '窗内新键入的末段'

function node(docId: string): TreeNode {
  return { path: `写作/正文/${docId}.md`, name: `${docId}.md`, isDirectory: false, role: 'chapter', docId, children: [] } as unknown as TreeNode
}

/** 构造「防抖窗内」态：登记一笔正文输入但不等到点——commit 复刻 EditorView 的落回
 *  语义（mergeFm + doc.patch，此处正文形态直接 patch）。内容未落回 store；脏位已由
 *  首笔标脏置上（质量评审 P2-5），决策点仍须先冲刷才能读到窗内正文。 */
function windowedInput(docId: string, body = WINDOWED): void {
  registerBodyWriteback((id, next) => useDocStore().patch(id, next))
  scheduleBodyWriteback(docId, body)
}

/** 打开某章（真 doc store + documents mock），返回该章 docId 便于衔接动作。 */
async function openDoc(docId: string): Promise<void> {
  const doc = useDocStore()
  doc.setBook(BOOK)
  await doc.open(node(docId))
}

function actions(): ReturnType<typeof useChapterTreeActions> {
  return useChapterTreeActions({ bookName: () => BOOK, openError: ref<string | null>(null) })
}

function savedPayload(callIndex = 0): { content: string; origin: string } {
  return (saveMock.mock.calls[callIndex]! as unknown as [string, string, { content: string; origin: string }])[2]
}

function askMessage(): string {
  return ((askMock.mock.calls as unknown[][])[0]![0] as { message: string }).message
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  treeMock.byPath = new Map()
  treeMock.byDocId = new Map()
  treeMock.grouped = []
  treeMock.raw = []
  askMock.mockResolvedValue(true)
})

afterEach(() => {
  // 丢槽：防抖尾是模块级单例，残槽会渗漏到下一用例
  registerBodyWriteback(null)
})

describe('B-2 附批：读 dirty 前先落防抖尾', () => {
  it('拆分（结构操作族首因）：落盘先于干跑，且落的是窗内正文', async () => {
    await openDoc('d1')
    const ws = useWorkspaceStore()
    ws.openTab('d1') // activeDocId = d1（doSplitHere 前置复检）
    // R0916-7-P3-24：光标读取器随单句柄注册（原 setEditorGetCursorOffset 独立函数槽退役）
    ws.setEditorHandle({ getSelection: () => '', getCursorOffset: () => 5 })
    windowedInput('d1')
    // 窗内态取证：内容未落回 store（改前判式在此读到 dirty=false 整段放行）
    expect(useDocStore().get('d1')!.content).not.toContain(WINDOWED)

    planMock.mockResolvedValue({
      plan: { op: 'split', docId: 'd1', planHash: 'ph', tailPreview: WINDOWED, tailWords: 3, headWords: 3 },
    })
    actions().onMenuSelect('split-here', node('d1'))
    await flushPromises()

    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(savedPayload().content).toContain(WINDOWED)
    // 序：落盘（flushUnsaved 首步）先于干跑——否则服务端按缺末段的盘上内容算偏移
    expect(saveMock.mock.invocationCallOrder[0]).toBeLessThan(planMock.mock.invocationCallOrder[0]!)
  })

  it('删除：R44-3 前置落盘在窗内不失守（文案仍承诺可从回收站恢复）', async () => {
    await openDoc('d2')
    windowedInput('d2')
    expect(useDocStore().get('d2')!.content).not.toContain(WINDOWED)

    await actions().doDelete(node('d2'))

    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(savedPayload().content).toContain(WINDOWED)
    expect(savedPayload().origin).toBe('autosave') // R48-88 口径不变
    expect(askMessage()).toContain('可从回收站恢复')
    expect(deleteMock).toHaveBeenCalledWith(BOOK, 'd2')
  })

  it('改写：W-P1-4 基线落盘在窗内不失守（服务端读盘前先落尾）', async () => {
    await openDoc('d3')
    windowedInput('d3')
    expect(useDocStore().get('d3')!.content).not.toContain(WINDOWED)
    rewriteMock.mockResolvedValue({ ok: true, mode: 'whole', original: '旧', rewritten: '新', diff: [] })

    await useRewriteStore().run(BOOK, 'd3', '改紧凑', '')

    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(savedPayload().content).toContain(WINDOWED)
    expect(saveMock.mock.invocationCallOrder[0]).toBeLessThan(rewriteMock.mock.invocationCallOrder[0]!)
  })

  it('切档：openTab 的「切换即存旧档」在窗内不失守', async () => {
    await openDoc('d4')
    useWorkspaceStore().openTab('d4')
    windowedInput('d4')
    expect(useDocStore().get('d4')!.content).not.toContain(WINDOWED)

    const ws = useWorkspaceStore()
    ws.openTab('d5')
    // 切换本身同步完成，存旧档链异步（R0911b-P2②）——多拍 microtask 冲刷整链
    for (let i = 0; i < 10; i++) await Promise.resolve()

    expect(ws.activeDocId).toBe('d5')
    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(savedPayload().content).toContain(WINDOWED)
    expect(savedPayload().origin).toBe('autosave')
  })
})
