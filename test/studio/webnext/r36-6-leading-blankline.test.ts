// @vitest-environment happy-dom
/**
 * R36-6（三十六轮）：正文前导空行在首次后续键入时被拽回（R31-30 补笔残余缺口）。
 *
 * 机理：mergeFm 无条件剥 `/^\n+/`；EditorView.onBodyChange 补笔后 store 已记录作者
 * 留的正文前空行，首次后续键入 `merged !== e.content` 走 mergeFm 分支把前导剥掉 → body
 * computed 变化 → CmHost 全量替换把 CM6 的前导回车拽掉。
 *
 * 修复（方案 b 落地）：
 * 1. mergeFm 增 stripLeading 选项——默认仍剥（加载/粘贴/对账等「明确来源」写入口径
 *    不变），编辑路径传 { stripLeading: false } 保前导；
 * 2. body computed 只剥 fm/body 分隔的首个换行（`.replace(/^\n/, '')`），作者留白
 *    原样展示且与 store 一致，不再触发 CmHost 的全量替换拽回。
 *
 * 本文件：mergeFm 选项纯测 + EditorView 组件流程（CmHost 以宿主可控 emit 的 stub 代，
 * CodeMirror 在 happy-dom 起不来，流程语义在 onBodyChange/patch/body computed 层）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { mergeFm } from '../../../src/studio/web-next/src/shared/words'

const mocks = vi.hoisted(() => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  updateChapterMetaDoc: vi.fn(),
  getConfig: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: mocks.getContent,
  saveContent: mocks.saveContent,
  finalizeDoc: mocks.finalizeDoc,
  updateChapterMetaDoc: mocks.updateChapterMetaDoc,
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
  getTree: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  ApiError: class ApiError extends Error {
    status = 0
    code?: string
  },
  getToken: vi.fn(() => null),
}))

// CmHost stub：宿主（测试体）可通过 holder.emitNext 驱动 update:modelValue 派发，
// 等价真实 CM6 的 doc 变更 emit；props.modelValue 即 EditorView 当前展示的 body。
const holder = vi.hoisted(() => ({
  emitNext: null as null | ((v: string) => void),
}))
vi.mock('../../../src/studio/web-next/src/editor/CmHost.vue', () => ({
  default: {
    name: 'CmHost',
    props: ['modelValue', 'mode', 'typewriter', 'historyKey', 'readonly'],
    emits: ['update:modelValue', 'selectionChange'],
    template: '<div class="cm-host-stub" />',
    mounted(this: { $emit: (e: 'update:modelValue', v: string) => void }) {
      holder.emitNext = (v: string) => this.$emit('update:modelValue', v)
    },
  },
}))

import EditorView from '../../../src/studio/web-next/src/views/EditorView.vue'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const BOOK = 'test-book'
const NODE: TreeNode = {
  path: '写作/正文/0001-开篇.md',
  name: '0001-开篇.md',
  isDirectory: false,
  role: 'chapter',
  docId: 'd1',
  status: 'draft',
  children: [],
}
const FM_HEAD = '---\n标题: 开篇\n---'
const PLAIN_BODY = '正文'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  holder.emitNext = null
  mocks.getContent.mockResolvedValue(`${FM_HEAD}\n\n${PLAIN_BODY}`)
  mocks.saveContent.mockReset()
  mocks.finalizeDoc.mockReset()
  mocks.getConfig.mockResolvedValue({ kind: 'long' })
})

// ── 纯函数：mergeFm stripLeading 选项 ────────────────────────────

describe('R36-6 mergeFm stripLeading（方案 b）', () => {
  it('默认仍剥前导（加载/粘贴/对账等明确来源契约不变——既有 words.test 锚）', () => {
    const full = '---\n标题: x\n---\n\n旧\n'
    expect(mergeFm(full, '\n\n新正文')).toBe('---\n标题: x\n---\n\n新正文')
  })

  it('编辑路径传 { stripLeading: false } → 前导空行原样保留', () => {
    const full = '---\n标题: x\n---\n\n旧\n'
    expect(mergeFm(full, '\n\n新正文', { stripLeading: false })).toBe('---\n标题: x\n---\n\n\n\n新正文')
  })
})

// ── 组件流程：补笔 → 后续键入 → 前导空行仍保留 ──────────────────

describe('R36-6 EditorView 前导空行往返', () => {
  it('回车补笔后首次后续键入：store 与展示层前导空行均保留（旧实现被拽回）', async () => {
    const doc = useDocStore()
    const tree = useTreeStore()
    vi.spyOn(tree, 'load').mockResolvedValue(undefined)
    doc.setBook(BOOK)
    await doc.open(NODE)

    const w = mount(EditorView, { props: { docId: 'd1' } })
    await flushPromises()
    let cm = w.findComponent({ name: 'CmHost' })
    // 常规加载：只剥 fm/body 分隔首换行，正文展示无前导
    expect(cm.props('modelValue')).toBe(PLAIN_BODY)

    // 作者在正文首行按回车（R31-30 补笔窗）：CM6 内容 = '\n正文'
    expect(holder.emitNext).not.toBeNull()
    holder.emitNext!('\n正文')
    await flushPromises()
    // store 按编辑器为准记录前导（fm 分隔照常单行收敛：--- 后一个空行 + 用户一个空行）
    expect(doc.get('d1')!.content).toBe(`${FM_HEAD}\n\n\n${PLAIN_BODY}`)
    cm = w.findComponent({ name: 'CmHost' })
    // 展示层保留用户前导空行（只剥分隔首换行）——CM6 视觉不跳
    expect(cm.props('modelValue')).toBe(`\n${PLAIN_BODY}`)

    // 首次后续键入（R36-6 拽回点）：CM6 内容 = '\n你正文'
    holder.emitNext!('\n你正文')
    await flushPromises()
    // 修复点：store 前导仍在（旧实现 mergeFm 剥前导 → store 变 '---\n\n你正文'）
    expect(doc.get('d1')!.content).toBe(`${FM_HEAD}\n\n\n你正文`)
    cm = w.findComponent({ name: 'CmHost' })
    // 修复点：展示层前导仍在（旧实现 body → '你正文'，CmHost 全量替换拽回回车）
    expect(cm.props('modelValue')).toBe('\n你正文')
    w.unmount()
  })

  it('含作者留白的正文加载 → 展示保留前导（只剥分隔首换行），后续编辑不丢', async () => {
    const doc = useDocStore()
    const tree = useTreeStore()
    vi.spyOn(tree, 'load').mockResolvedValue(undefined)
    // 磁盘内容：--- 分隔后作者留了一个空行再写字
    mocks.getContent.mockResolvedValue(`${FM_HEAD}\n\n\n留白后的正文`)
    doc.setBook(BOOK)
    await doc.open(NODE)

    const w = mount(EditorView, { props: { docId: 'd1' } })
    await flushPromises()
    const cm = w.findComponent({ name: 'CmHost' })
    expect(cm.props('modelValue')).toBe('\n留白后的正文')

    // 后续编辑（改稿）：前导空行继续保留在 store 与展示层
    holder.emitNext!('\n留白后的正文（修改）')
    await flushPromises()
    expect(doc.get('d1')!.content).toBe(`${FM_HEAD}\n\n\n留白后的正文（修改）`)
    expect(w.findComponent({ name: 'CmHost' }).props('modelValue')).toBe('\n留白后的正文（修改）')
    w.unmount()
  })

  it('常规加载（无作者留白）→ 展示仍干净，编辑合并不引入多余空行', async () => {
    const doc = useDocStore()
    const tree = useTreeStore()
    vi.spyOn(tree, 'load').mockResolvedValue(undefined)
    doc.setBook(BOOK)
    await doc.open(NODE)

    const w = mount(EditorView, { props: { docId: 'd1' } })
    await flushPromises()
    expect(w.findComponent({ name: 'CmHost' }).props('modelValue')).toBe(PLAIN_BODY)

    // 正文中段改动（不带前导）：合并结果与旧契约一致（--- 分隔后单行收敛）
    holder.emitNext!('正文改')
    await flushPromises()
    expect(doc.get('d1')!.content).toBe(`${FM_HEAD}\n\n正文改`)
    expect(w.findComponent({ name: 'CmHost' }).props('modelValue')).toBe('正文改')
    w.unmount()
  })
})