// @vitest-environment happy-dom
/**
 * 重评-P3-16（2026-09-09 全量代码重评）：diff 列表渲染无上限回归。
 *
 * RewritePanel（改写 diff 行）与 AuditDiffPanel（遮蔽差异节点）原 v-for 全量渲染，
 * 千行级 diff / 长会话节点全部挂 DOM（max-height 只裁视觉不减节点）。修后对齐
 * CommandPalette RENDER_CAP=100 域内惯例：只裁渲染面前 100 条 + 尾部「已省略 N 行/条」
 * 提示；数据面不动（RewritePanel 统计头仍面向全量）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import RewritePanel from '../../../src/studio/web-next/src/components/panels/RewritePanel.vue'
import AuditDiffPanel from '../../../src/studio/web-next/src/components/audit/AuditDiffPanel.vue'
import type { AuditNodeFE } from '../../../src/studio/web-next/src/api/audit'

// ── RewritePanel：store mock 沿用 rewrite-panel.test.ts 同款 ──

const rewriteMock = vi.hoisted(() => ({
  loading: false,
  error: null as string | null,
  result: null as unknown,
  run: vi.fn(async () => {}),
  accept: vi.fn((): boolean => true),
  reject: vi.fn(),
  clear: vi.fn(),
}))
const wsMock = vi.hoisted(() => ({ state: null as unknown as { activeDocId: string | null; editorGetSelection: unknown } }))

vi.mock('../../../src/studio/web-next/src/stores/rewrite', () => ({
  useRewriteStore: () => rewriteMock,
}))
vi.mock('../../../src/studio/web-next/src/stores/workspace', async () => {
  const { reactive } = await import('vue')
  wsMock.state = reactive({ activeDocId: 'doc_1', editorGetSelection: null })
  return { useWorkspaceStore: () => wsMock.state }
})
vi.mock('../../../src/studio/web-next/src/stores/tree', () => ({
  useTreeStore: () => ({
    byDocId: new Map([['doc_1', { path: '写作/正文/001-开篇.md', docId: 'doc_1' }]]),
  }),
}))
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: () => ({ aiAvailable: true }),
}))

enableAutoUnmount(afterEach)

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  rewriteMock.loading = false
  rewriteMock.error = null
  rewriteMock.result = null
  if (wsMock.state) wsMock.state.activeDocId = 'doc_1'
})

describe('重评-P3-16：RewritePanel diff 渲染上限', () => {
  it('130 行 diff 只渲染前 100 行 + 「已省略 30 行」提示；统计头仍面向全量', async () => {
    rewriteMock.result = {
      ok: true,
      mode: 'whole',
      original: '旧',
      rewritten: '新',
      diff: Array.from({ length: 130 }, (_, i) => ({ type: 'add', text: `行${i}` })),
    }
    const w = mount(RewritePanel, { props: { bookName: '书A' } })
    await flushPromises()
    expect(w.findAll('.diff-line')).toHaveLength(100)
    expect(w.find('.cap-hint').text()).toContain('已省略 30 行')
    // 数据面不动：+/- 统计按全量 diff 计（渲染面裁剪不虚减统计）
    expect(w.find('.stat-add').text()).toBe('+130')
    w.unmount()
  })

  it('不超上限：全量渲染零提示', async () => {
    rewriteMock.result = {
      ok: true,
      mode: 'whole',
      original: '旧',
      rewritten: '新',
      diff: Array.from({ length: 100 }, (_, i) => ({ type: 'same', text: `行${i}` })),
    }
    const w = mount(RewritePanel, { props: { bookName: '书A' } })
    await flushPromises()
    expect(w.findAll('.diff-line')).toHaveLength(100)
    expect(w.find('.cap-hint').exists()).toBe(false)
    w.unmount()
  })
})

describe('重评-P3-16：AuditDiffPanel 节点渲染上限', () => {
  const mkNodes = (n: number): AuditNodeFE[] =>
    Array.from({ length: n }, (_, i) => ({
      seq: i + 1,
      kind: i % 2 === 0 ? 'user-text' : 'assistant',
      role: i % 2 === 0 ? 'user' : 'assistant',
      shadowed: false,
      preview: `消息${i}`,
    }))
  const conv = (n: number) => ({
    events: [],
    eventsTotal: 0,
    modelVisible: mkNodes(n),
    humanVisible: mkNodes(n),
    shadowedCount: 0,
  })

  it('130 节点只渲染前 100 行 + 「已省略 30 条」提示；空态判定仍看全量', () => {
    const w = mount(AuditDiffPanel, { props: { conversation: conv(130) } })
    expect(w.findAll('.diff-row')).toHaveLength(100)
    expect(w.find('.cap-hint').text()).toContain('已省略 30 条')
    expect(w.find('.empty').exists()).toBe(false)
    w.unmount()
  })

  it('切「人类可见」模式后同样裁剪；不超上限零提示', async () => {
    const w = mount(AuditDiffPanel, { props: { conversation: conv(130) } })
    await w.findAll('.audit-seg button')[1]!.trigger('click')
    expect(w.findAll('.diff-row')).toHaveLength(100)
    w.unmount()

    const under = mount(AuditDiffPanel, { props: { conversation: conv(100) } })
    expect(under.findAll('.diff-row')).toHaveLength(100)
    expect(under.find('.cap-hint').exists()).toBe(false)
    under.unmount()
  })
})
