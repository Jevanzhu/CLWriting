// @vitest-environment happy-dom
/**
 * 四轮-E402 回归：程序化全量替换不回发 emit（零输入不置脏）。
 *
 * 机理（全量源码独立重评四轮 E402）：CmHost 两处程序化全量替换——applyDocSwitch
 * （切文档）/ applyExternalReplace（SSE sync / doc.refresh / 冲突取服务端版）——替换
 * 事务此前同步触发 updateListener 回发 update:modelValue；父层 EditorView.onBodyChange
 * 以 mergeFm 规范形往返重组，对非规范 fm 存量文件（fence 尾随空格 / BOM / CRLF，
 * 解析侧 frontmatter-core 容忍）merged !== content 即 doc.patch 置脏 → autosave 30s
 * 内作者零输入重写并规范化文件。修复：替换事务携带 programmaticReplace 注解，
 * updateListener 见注解跳过本笔回发（lastLocalEmit 照常同步，watch 的同文档外部
 * 同步判据 R39-20 不变；真实用户输入 / undo / redo 无注解照常 emit）。
 *
 * 分层（库内既有口径）：
 * - CmHost 组件级（真实 CM6，f5-cm-composition-guard 同款）：切文档 / 外部替换不回发、
 *   真实键入照常回发、空→空切档后键入不吞（抑制不粘滞）、undo 照常回发；
 * - EditorView 集成级（真实 CmHost + doc store，r43-17 同款）：非规范 fm（起始 fence
 *   尾随空格）文件切档 → 零 patch 不置脏；真实键入 → 照常 patch 置脏。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { EditorView as CdView } from '@codemirror/view'
import { undo } from '../../../src/studio/web-next/node_modules/@codemirror/commands'

const mocks = vi.hoisted(() => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  getConfig: vi.fn(),
  getCompletionNames: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: mocks.getContent,
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
vi.mock('../../../src/studio/web-next/src/api/settings', () => ({
  getCompletionNames: mocks.getCompletionNames,
}))
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
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.getContent.mockReset().mockResolvedValue('正文')
  mocks.saveContent.mockReset()
  mocks.finalizeDoc.mockReset()
  mocks.getConfig.mockReset().mockResolvedValue({ kind: 'long' })
  mocks.getCompletionNames.mockReset().mockResolvedValue({ characters: [], items: [] })
})

// ── CmHost 组件级（真实 CM6） ──────────────────────────────────────

function mountHost(doc: string, historyKey = 'd1'): ReturnType<typeof mount> {
  return mount(CmHost, { props: { modelValue: doc, mode: 'text', historyKey }, attachTo: document.body })
}

function hostView(w: ReturnType<typeof mount>): CdView {
  const el = w.element.querySelector('.cm-content')
  expect(el).not.toBeNull()
  const v = CdView.findFromDOM(el as HTMLElement)
  expect(v).not.toBeNull()
  return v!
}

function docText(w: ReturnType<typeof mount>): string {
  return (w.element.querySelector('.cm-content') as HTMLElement).textContent ?? ''
}

describe('四轮-E402: 切文档程序化替换不回发（applyDocSwitch）', () => {
  it('非组合态切档 → 内容替换到位且零回发；随后真实键入照常回发（抑制只压本笔）', async () => {
    const w = mountHost('旧章初文')
    expect(w.emitted('update:modelValue')).toBeUndefined() // 挂载初值不产生事务

    await w.setProps({ modelValue: '新章内容', historyKey: 'd2' })
    await new Promise((r) => setTimeout(r, 0))
    expect(docText(w)).toBe('新章内容') // 替换本身不受抑制影响（应用路径不变）
    // 修复点：切档回发归零——修复前此处回发 '新章内容'，经父层 mergeFm 往返对
    // 非规范 fm 新章零输入置脏
    expect(w.emitted('update:modelValue')).toBeUndefined()

    // 抑制不粘滞：随后的真实键入照常回发
    const view = hostView(w)
    view.dispatch({ changes: { from: 4, to: 4, insert: '改' } })
    await new Promise((r) => setTimeout(r, 0))
    const emits = w.emitted('update:modelValue') ?? []
    expect(emits.length).toBe(1)
    expect(emits[0]![0]).toBe('新章内容改')
    w.unmount()
  })

  it('空→空切档（空 ChangeSet，docChanged=false）→ 布尔位形态会粘滞吞回发，注解按事务判定不吞', async () => {
    const w = mountHost('', 'd1')
    await w.setProps({ modelValue: '', historyKey: 'd2' })
    await new Promise((r) => setTimeout(r, 0))
    expect(docText(w)).toBe('')
    // 后续真实键入必须照常回发（修复若用「置位等下次 docChanged 消费」的布尔位，
    // 本用例红：空替换事务消费不到标志位，首次键入回写被吞）
    const view = hostView(w)
    view.dispatch({ changes: { from: 0, to: 0, insert: '首字' } })
    await new Promise((r) => setTimeout(r, 0))
    const emits = w.emitted('update:modelValue') ?? []
    expect(emits.length).toBe(1)
    expect(emits[0]![0]).toBe('首字')
    w.unmount()
  })
})

describe('四轮-E402: 同文档外部同步不回发（applyExternalReplace）', () => {
  it('SSE sync/refresh 形态的外部全量替换 → 替换到位且零回发；undo 语义零变化照常回发', async () => {
    const w = mountHost('初文')
    const view = hostView(w)

    await w.setProps({ modelValue: '外部全量新文' }) // historyKey 不变 = 同文档路径
    await new Promise((r) => setTimeout(r, 0))
    expect(docText(w)).toBe('外部全量新文')
    expect(w.emitted('update:modelValue')).toBeUndefined() // 修复点：外部替换不回发

    // undo/redo 不受注解影响：真实键入 → ⌘Z 撤销，两次都照常回发（既有语义）
    view.dispatch({ changes: { from: 6, to: 6, insert: '续' } })
    await new Promise((r) => setTimeout(r, 0))
    let emits = w.emitted('update:modelValue') ?? []
    expect(emits.length).toBe(1)
    expect(emits[0]![0]).toBe('外部全量新文续')
    expect(undo(view)).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    emits = w.emitted('update:modelValue') ?? []
    expect(emits.length).toBe(2)
    expect(emits[1]![0]).toBe('外部全量新文')
    w.unmount()
  })
})

// ── EditorView 集成级（真实 CmHost + doc store，全链路置脏判据） ─────────

const BOOK = 'e402-book'
const CANON_D1 = '---\n标题: 第1章\n---\n\n甲文'
// 非规范 fm：起始 fence 尾随空格（frontmatter-core R54-E-2 容忍形；mergeFm 重组即
// 丢尾随空格 → onBodyChange 的 merged !== content 即 patch 置脏，正是本批病灶）
const NONCANON_D2 = '--- \n标题: 第2章\n---\n\n乙文'
const CANON_D2 = '---\n标题: 第2章\n---\n\n乙文'

function makeNode(docId: string, path: string): TreeNode {
  return {
    path,
    name: path.split('/').pop() ?? path,
    isDirectory: false,
    role: 'chapter',
    docId,
    status: 'draft',
    children: [],
  }
}

async function mountEditorOnD1(): Promise<ReturnType<typeof mount>> {
  const doc = useDocStore()
  const tree = useTreeStore()
  doc.setBook(BOOK)
  tree.raw = [makeNode('d1', '写作/正文/第1章-甲.md'), makeNode('d2', '写作/正文/第2章-乙.md')]
  mocks.getContent.mockImplementation(async (_book: string, path: string) =>
    path.includes('第1章') ? CANON_D1 : NONCANON_D2,
  )
  // 两文档预开入缓存：切 docId 走 applyDocSwitch 真路径（不经 open 重拉）
  await doc.open(tree.byDocId.get('d1')!)
  await doc.open(tree.byDocId.get('d2')!)
  const w = mount(EditorView, { props: { docId: 'd1' }, attachTo: document.body })
  await flushPromises()
  return w
}

describe('四轮-E402: 非规范 fm 文件切档零输入不置脏（EditorView 全链路）', () => {
  it('规范章 → 非规范 fm 章：切档不 patch 不置脏；真实键入照常 patch 置脏', async () => {
    const doc = useDocStore()
    const w = await mountEditorOnD1()
    const patchSpy = vi.spyOn(doc, 'patch')
    patchSpy.mockClear()

    await w.setProps({ docId: 'd2' })
    await flushPromises()
    // 新章内容渲染到位（切换本身不回归）
    const el = w.element.querySelector('.cm-content') as HTMLElement
    const view = CdView.findFromDOM(el)
    expect(view).not.toBeNull()
    expect(view!.state.doc.toString()).toBe('乙文')
    // 修复点：切档零 patch——修复前 applyDocSwitch 回发 '乙文' → mergeFm 重组丢 fence
    // 尾随空格 → patch 规范形 → d2 零输入 dirty → autosave 静默改写
    expect(patchSpy).not.toHaveBeenCalled()
    expect(doc.get('d2')!.dirty).toBe(false)
    expect(doc.get('d2')!.content).toBe(NONCANON_D2) // 存量非规范形不被规范化改写

    // 作者真实键入：照常 patch（mergeFm 合并正文、fm 侧规范化属既有编辑写入口径）
    view!.dispatch({ changes: { from: 2, to: 2, insert: '改' } })
    await flushPromises()
    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(doc.get('d2')!.dirty).toBe(true)
    expect(doc.get('d2')!.content).toBe(`${CANON_D2}改`)
    w.unmount()
    await flushPromises()
  })
})
