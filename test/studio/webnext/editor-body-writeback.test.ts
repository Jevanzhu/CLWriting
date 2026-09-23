// @vitest-environment happy-dom
/**
 * RC 源码重审 B-2（Opus-5.5 轮）回归：编辑器正文回写的「防抖合并 + 冲刷点」。
 *
 * 被测行为（源码锚：views/EditorView.vue 的 commitBodyWriteback/onBodyChange/docId
 * 同步 watch/onUnmounted、shared/body-writeback.ts、stores/doc.ts 的 save/flushDirty
 * 顶部、pages/Book.vue 的 hasUnsavedWork）：
 *   ① 同一防抖窗内的多次按键只落回一笔（改前：每键一遍全文 mergeFm/patch/重切）；
 *   ② **末次输入不丢**——到点落回的是槽内最新正文，不是起窗快照；
 *   ③ 切档（props.docId 变）**同步**冲刷上一档防抖尾，且落点按登记时的 docId
 *      （不得写进新档 → R51-I-6 同型跨档污染面）；
 *   ④ 卸载（切视图销毁 EditorView）冲刷防抖尾；
 *   ⑤ 保存/冲刷/关窗链（doc.save、doc.flushDirty，后者经 flushBeforeClose 与切书
 *      守卫共用）先冲刷：窗内刚键入、store 尚未置脏的正文也必须随本笔落盘；
 *   ⑥ frontmatter 语义逐字节不变：回写只改正文，fm 段原样，且与直算 mergeFm 等价；
 *      正文前导空行（R36-6）往返后编辑区文本不变、撤销栈未被全量替换清空。
 *
 * 真挂 EditorView + 真 CmHost（真 CM6，对齐 cm-history-reset / f5 先例），按键经
 * view.dispatch 打真实输入链路；防抖窗 200ms，故「窗内」断言一律同步（不 await），
 * 「到点」断言 sleep 到窗后。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { EditorView } from '../../../src/studio/web-next/node_modules/@codemirror/view'
import { undo } from '../../../src/studio/web-next/node_modules/@codemirror/commands'

const mocks = vi.hoisted(() => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  getConfig: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: mocks.getContent,
  // 重评-0912-4 P1-1：doOpen 走完整载荷——委托包装既有 getContent mock
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
vi.mock('../../../src/studio/web-next/src/api/settings', () => ({
  getCompletionNames: vi.fn(async () => ({ characters: [], items: [] })),
}))
// 重评-0914-三轮 nano R7-1：ApiError 收编 importOriginal，真类单源 api/client.ts
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return { ...actual, getToken: vi.fn(() => 'test-token') }
})

import EditorViewComp from '../../../src/studio/web-next/src/views/EditorView.vue'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { mergeFm, splitFrontmatter } from '../../../src/studio/web-next/src/shared/words'
import {
  registerBodyWriteback,
  scheduleBodyWriteback,
  flushBodyWriteback,
  hasPendingBodyWriteback,
} from '../../../src/studio/web-next/src/shared/body-writeback'
import type { SaveOk } from '../../../src/studio/web-next/src/api/documents'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const BOOK = 'test-book'
/** 防抖窗 200ms（shared/body-writeback.ts WRITEBACK_WINDOW_MS）——到点断言留 60ms 余量。 */
const WINDOW_MS = 200
const AFTER_WINDOW_MS = WINDOW_MS + 60
const FM_HEAD = '---\n标题: 第1章\n---\n\n'
const P1 = '写作/正文/第1章-一.md'
const P2 = '写作/正文/第2章-二.md'
const DOC1 = `${FM_HEAD}正文`
const DOC2 = '---\n标题: 第2章\n---\n\n第二章正文'
const OK: SaveOk = { ok: true, revision: 'sha256:x', superseded: false }

/** 服务端内容台账（路径 → 内容）：open 经 getContent 读，逐用例重置。 */
let contents: Record<string, string>

function makeNode(path: string, docId: string): TreeNode {
  return { path, name: path.split('/').pop()!, isDirectory: false, role: 'chapter', docId, status: 'draft', children: [] }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 真挂 EditorView（真 CmHost）：tree 预置两章，activeDocId 由 props 驱动。 */
function mountEditor(docId: string | null): ReturnType<typeof mount> {
  return mount(EditorViewComp, { props: { docId }, attachTo: document.body })
}

function cmView(w: ReturnType<typeof mount>): EditorView {
  const el = w.element.querySelector('.cm-content')
  expect(el).not.toBeNull()
  const v = EditorView.findFromDOM(el as HTMLElement)
  expect(v).not.toBeNull()
  return v!
}

/** 同步打一键（真输入链路：CM6 事务 → updateListener → emit → 父层登记）。 */
function typeKey(view: EditorView): void {
  const pos = view.state.doc.length
  view.dispatch({
    changes: { from: pos, to: pos, insert: 'x' },
    selection: { anchor: pos + 1 },
    userEvent: 'input.type',
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  contents = { [P1]: DOC1, [P2]: DOC2 }
  mocks.getContent.mockReset().mockImplementation(async (_b: string, path: string) => contents[path] ?? '')
  mocks.saveContent.mockReset().mockResolvedValue(OK)
  mocks.finalizeDoc.mockReset()
  mocks.getConfig.mockReset().mockResolvedValue({ kind: 'long' })
  const doc = useDocStore()
  doc.setBook(BOOK)
  useTreeStore().raw = [makeNode(P1, 'd1'), makeNode(P2, 'd2')]
})

describe('B-2 正文回写防抖合并（EditorView + 真 CmHost）', () => {
  let w: ReturnType<typeof mount> | null = null
  afterEach(async () => {
    // 环境拆卸前排空：未卸载组件残留的微任务重渲染会在 happy-dom 拆卸后抛错（editor-view 先例）
    w?.unmount()
    w = null
    await flushPromises()
  })

  it('窗内连打多键合并为一笔落回：中间不 patch，到点恰好一笔且含末次输入', async () => {
    const doc = useDocStore()
    w = mountEditor('d1')
    await vi.waitFor(() => expect(doc.get('d1')).toBeDefined())
    await flushPromises()
    const view = cmView(w)
    const patchSpy = vi.spyOn(doc, 'patch')

    typeKey(view)
    typeKey(view)
    typeKey(view)

    // 窗内（同步断言，未过 200ms）：正文只在编辑器里，store 零落回、零置脏
    expect(patchSpy).not.toHaveBeenCalled()
    expect(doc.get('d1')!.content).toBe(DOC1)
    expect(doc.get('d1')!.dirty).toBe(false)

    await sleep(AFTER_WINDOW_MS)
    // 合并为一笔（改前 3 键 3 笔），且落的是槽内最新正文（末次输入不丢）
    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(doc.get('d1')!.content).toBe(`${FM_HEAD}正文xxx`)
    expect(doc.get('d1')!.dirty).toBe(true)
  })

  it('切档（props.docId 变）同步冲刷上一档防抖尾，新档内容零污染', async () => {
    const doc = useDocStore()
    w = mountEditor('d1')
    await vi.waitFor(() => expect(doc.get('d1')).toBeDefined())
    await flushPromises()
    const view = cmView(w)

    typeKey(view)
    typeKey(view)
    expect(doc.get('d1')!.content).toBe(DOC1) // 前置：仍在窗内，尚未落回

    const p = w.setProps({ docId: 'd2' })
    // 切档当拍即冲刷（远早于 200ms 窗）：sync watch 在 props 落定瞬间执行，早于子层
    // CmHost 的切档全量替换与新档一切消费
    await p
    expect(doc.get('d1')!.content).toBe(`${FM_HEAD}正文xx`)
    expect(doc.get('d1')!.dirty).toBe(true)
    await vi.waitFor(() => expect(doc.get('d2')).toBeDefined())
    await flushPromises()
    // 落点按登记时的 docId：新档未被旧档正文污染
    expect(doc.get('d2')!.content).toBe(DOC2)
    expect(doc.get('d2')!.dirty).toBe(false)
    expect(cmView(w).state.doc.toString()).toBe('第二章正文') // 编辑器已切到新档正文
  })

  it('卸载（切视图销毁 EditorView）冲刷防抖尾', async () => {
    const doc = useDocStore()
    w = mountEditor('d1')
    await vi.waitFor(() => expect(doc.get('d1')).toBeDefined())
    await flushPromises()
    const view = cmView(w)

    typeKey(view)
    typeKey(view)
    expect(doc.get('d1')!.content).toBe(DOC1) // 前置：窗内未落回
    w.unmount()
    w = null
    // 卸载同步冲刷（onUnmounted：先 flush 再注销执行体）
    expect(doc.get('d1')!.content).toBe(`${FM_HEAD}正文xx`)
    expect(doc.get('d1')!.dirty).toBe(true)
  })

  it('保存链先冲刷：doc.save 落盘内容含窗内末次键入（⌘S 不落后于屏幕）', async () => {
    const doc = useDocStore()
    w = mountEditor('d1')
    await vi.waitFor(() => expect(doc.get('d1')).toBeDefined())
    await flushPromises()
    const view = cmView(w)

    typeKey(view)
    typeKey(view)
    expect(doc.get('d1')!.dirty).toBe(false) // 前置：窗内回写未到点，条目尚未置脏

    expect(await doc.save('d1', 'manual')).toBe(true)
    const sent = (mocks.saveContent.mock.calls[0]![2] as { content: string }).content
    expect(sent).toBe(`${FM_HEAD}正文xx`)
  })

  it('flushDirty 扫描前冲刷：窗内未置脏的键入随切书/关窗一并落盘', async () => {
    const doc = useDocStore()
    w = mountEditor('d1')
    await vi.waitFor(() => expect(doc.get('d1')).toBeDefined())
    await flushPromises()
    const view = cmView(w)

    typeKey(view)
    typeKey(view)
    expect(doc.get('d1')!.dirty).toBe(false) // 前置：不在 dirty 扫描面内（改前此处即静默丢弃面）

    expect(await doc.flushDirty()).toEqual([])
    const sent = (mocks.saveContent.mock.calls[0]![2] as { content: string }).content
    expect(sent).toBe(`${FM_HEAD}正文xx`)
    expect(doc.get('d1')!.content).toBe(`${FM_HEAD}正文xx`)
    expect(doc.get('d1')!.dirty).toBe(false) // 已随本轮落盘
  })

  it('窗内外部刷新（doc.refresh）不吞防抖尾：先落尾再取服务端 fm，本地正文保留', async () => {
    const doc = useDocStore()
    w = mountEditor('d1')
    await vi.waitFor(() => expect(doc.get('d1')).toBeDefined())
    await flushPromises()
    const view = cmView(w)

    typeKey(view)
    typeKey(view)
    expect(doc.get('d1')!.dirty).toBe(false) // 前置：窗内未落回 → 条目仍 clean

    // 外部改了 fm（服务端内容不含窗内键入）：refresh 前须先落尾，否则 clean 分支整体
    // 覆盖服务端内容、窗内键入被吞（改前逐键即 dirty，走 dirty 分支保留本地正文）
    contents[P1] = '---\n标题: 新标题\n---\n\n正文'
    expect(await doc.refresh('d1')).toBe(true)
    const e = doc.get('d1')!
    expect(splitFrontmatter(e.content)!.fmRaw).toBe('标题: 新标题') // fm 以服务端为准
    expect(splitFrontmatter(e.content)!.body).toContain('正文xx') // 本地正文（含窗内键入）保留
    expect(e.dirty).toBe(true)
    // 尾已在 refresh 内落定：到点不再补一笔（flush 幂等、定时器已清）
    await sleep(AFTER_WINDOW_MS)
    expect(doc.get('d1')!.content).toBe(e.content)
  })

  it('fm 语义不变：回写只改正文，fm 段逐字节原样（等价于直算 mergeFm）', async () => {
    const doc = useDocStore()
    w = mountEditor('d1')
    await vi.waitFor(() => expect(doc.get('d1')).toBeDefined())
    await flushPromises()
    const view = cmView(w)

    typeKey(view)
    typeKey(view)
    await sleep(AFTER_WINDOW_MS)

    const e = doc.get('d1')!
    expect(e.content).toBe(mergeFm(DOC1, '正文xx', { stripLeading: false })) // 与直算等价
    expect(splitFrontmatter(e.content)!.fmRaw).toBe(splitFrontmatter(DOC1)!.fmRaw) // fm 原样
    expect(splitFrontmatter(e.content)!.body).toBe('\n正文xx') // 正文 = 编辑区文本 + 分隔换行
  })

  it('正文前导空行（R36-6）往返不动：回写后编辑区文本不变且仍可撤销', async () => {
    contents[P1] = `${FM_HEAD}\n正文` // fm/body 分隔后的额外空行 = 作者留白
    const doc = useDocStore()
    w = mountEditor('d1')
    await vi.waitFor(() => expect(doc.get('d1')).toBeDefined())
    await flushPromises()
    const view = cmView(w)
    expect(view.state.doc.toString()).toBe('\n正文') // 只剥分隔首换行，留白保留

    typeKey(view) // 单键：CM6 会把 500ms 内相邻输入并入同一 history 事件，单键便于钉 undo 粒度
    await sleep(AFTER_WINDOW_MS)

    // 往返不动：回写经 mergeFm 拼回 store 后，body computed 仍与编辑区逐字节一致
    //（不一致即触发 CmHost 的 applyExternalReplace 全量替换，前导空行被拽回）
    expect(view.state.doc.toString()).toBe('\n正文x')
    expect(doc.get('d1')!.content).toBe(`${FM_HEAD}\n正文x`)
    // 撤销栈未被清（全量替换走两步真重置会清栈 → undo 返 false）
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('\n正文')
  })
})

describe('B-2 回写队列单元（跨档登记 / 注销语义）', () => {
  beforeEach(() => {
    registerBodyWriteback(null)
    vi.useFakeTimers()
  })
  afterEach(() => {
    registerBodyWriteback(null)
    vi.useRealTimers()
  })

  it('跨档登记：旧档尾巴未落时先落旧档（不跨档合并），新档各自成笔', () => {
    const seen: Array<[string, string]> = []
    registerBodyWriteback((id, body) => seen.push([id, body]))
    scheduleBodyWriteback('d1', 'A')
    scheduleBodyWriteback('d1', 'A2') // 同档：只更新槽（尾随节流，不重置窗）
    scheduleBodyWriteback('d2', 'B') // 跨档：先落旧档槽内最新值
    expect(seen).toEqual([['d1', 'A2']])
    flushBodyWriteback()
    expect(seen).toEqual([['d1', 'A2'], ['d2', 'B']])
    vi.advanceTimersByTime(1000)
    expect(seen).toHaveLength(2) // 幂等：到点不重复落回
    expect(hasPendingBodyWriteback()).toBe(false)
  })

  it('注销丢弃未落槽（调用方须先 flush——EditorView onUnmounted 即此序）', () => {
    const fn = vi.fn()
    registerBodyWriteback(fn)
    scheduleBodyWriteback('d1', 'A')
    expect(hasPendingBodyWriteback()).toBe(true)
    registerBodyWriteback(null)
    expect(hasPendingBodyWriteback()).toBe(false)
    flushBodyWriteback()
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(fn).not.toHaveBeenCalled()
  })

  it('无执行体（工作台/总览态无编辑器）时登记不滞留残槽', () => {
    registerBodyWriteback(null)
    scheduleBodyWriteback('d1', 'A')
    expect(hasPendingBodyWriteback()).toBe(false)
  })
})
