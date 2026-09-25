// @vitest-environment happy-dom
/**
 * R1010c-FE1-P3-2（2026-09-10 全量独立复审修复批）：四面板渲染上限回归。
 *
 * CheckPanel（红/黄项）/ ReviewPanel（阻断/警告）/ ForeshadowPanel（未回收/已回收）/
 * TrashPanel（回收站条目）原 v-for 全量渲染——千项级命中/意见/伏笔/条目全部挂 DOM
 * （max-height 只裁视觉不减节点）。修后对齐域内 RENDER_CAP=100 惯例（先例
 * CommandPalette M-P3-13、RewritePanel/AuditDiffPanel 重评-P3-16、r54 ChapterTree）：
 * 只渲染前 100 条 + 尾部「已省略 N 项」提示行；数据面不动——分组头/统计行计数仍面向
 * 全量（不虚减）。
 *
 * 附 R1010c-FE1-P3-1：TrashPanel 行内操作钮键盘焦点显形 CSS——scoped 样式在
 * happy-dom 不参与计算，按 rp3-4「源码文本锚定」先例断言规则存在。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

// ── 模块 mock（文件级，服务四个面板） ────────────────────

const mocks = vi.hoisted(() => ({
  runCheck: vi.fn(),
  markFalsePositive: vi.fn(),
  runReview: vi.fn(),
  getReviewEnvelope: vi.fn(),
  runVerdictDoc: vi.fn(),
  getForeshadows: vi.fn(),
  createDoc: vi.fn(),
  listTrash: vi.fn(),
  restoreTrash: vi.fn(),
  purgeTrash: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/check', () => ({
  runCheck: mocks.runCheck,
  markFalsePositive: mocks.markFalsePositive,
}))
vi.mock('../../../src/studio/web-next/src/api/review', () => ({
  runReview: mocks.runReview,
  getReviewEnvelope: mocks.getReviewEnvelope,
  runVerdictDoc: mocks.runVerdictDoc,
}))
vi.mock('../../../src/studio/web-next/src/api/foreshadows', () => ({
  getForeshadows: mocks.getForeshadows,
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  createDoc: mocks.createDoc,
  listTrash: mocks.listTrash,
  restoreTrash: mocks.restoreTrash,
  purgeTrash: mocks.purgeTrash,
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => {
  class ApiError extends Error {
    status: number
    code?: string
    constructor(message: string, status: number, code?: string) {
      super(message)
      this.name = 'ApiError'
      this.status = status
      this.code = code
    }
  }
  return { ApiError }
})

import CheckPanel from '../../../src/studio/web-next/src/components/panels/CheckPanel.vue'
import ReviewPanel from '../../../src/studio/web-next/src/components/panels/ReviewPanel.vue'
import ForeshadowPanel from '../../../src/studio/web-next/src/components/panels/ForeshadowPanel.vue'
import TrashPanel from '../../../src/studio/web-next/src/components/panels/TrashPanel.vue'
import { useCheckStore } from '../../../src/studio/web-next/src/stores/check'
import { useReviewStore } from '../../../src/studio/web-next/src/stores/review'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import type { CheckItem } from '../../../src/studio/web-next/src/api/check'
import type { ReviewIssueFE } from '../../../src/studio/web-next/src/api/review'
import type { Foreshadow } from '../../../src/studio/web-next/src/api/foreshadows'

enableAutoUnmount(afterEach)

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.getReviewEnvelope.mockReset().mockResolvedValue(undefined)
  mocks.runReview.mockReset().mockResolvedValue({ ok: true, lenses: [], collected: undefined })
})

/** 一颗含正文文档 doc_ch1 的树（可机检/可三审判定共用） */
function seedBodyTree(): void {
  const tree = useTreeStore()
  tree.raw = [
    {
      path: '写作/正文',
      name: '正文',
      isDirectory: true,
      role: '',
      children: [
        {
          path: '写作/正文/0001-开篇.md',
          name: '0001-开篇.md',
          isDirectory: false,
          role: '',
          children: [],
          docId: 'doc_ch1',
          status: 'draft',
        },
      ],
    },
  ]
}

function checkItem(i: number, level: 'red' | 'yellow'): CheckItem {
  return { checkId: `banned-word`, level, message: `第${i}段命中` }
}

describe('R1010c-FE1-P3-2: CheckPanel 红/黄项渲染上限', () => {
  function mountWith(reds: number, yellows = 0) {
    const ws = useWorkspaceStore()
    seedBodyTree()
    ws.activeDocId = 'doc_ch1'
    const items: CheckItem[] = [
      ...Array.from({ length: reds }, (_, i) => checkItem(i + 1, 'red')),
      ...Array.from({ length: yellows }, (_, i) => checkItem(i + 1, 'yellow')),
    ]
    const check = useCheckStore()
    check.report = { sections: [{ name: '检查', items }] }
    return mount(CheckPanel, { props: { bookName: '书A' } })
  }

  it('130 红项 → 只渲染前 100 条 + 「已省略 30 项」；分组头计数仍 130（不虚减）', async () => {
    const w = mountWith(130)
    await flushPromises()
    expect(w.findAll('.check-item--red')).toHaveLength(100)
    const hint = w.find('.cap-hint')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('已省略 30 项')
    expect(w.find('.group-label--red').text()).toContain('红项（130）')
    w.unmount()
  })

  it('不超上限（5 红项）→ 全量渲染零提示', async () => {
    const w = mountWith(5)
    await flushPromises()
    expect(w.findAll('.check-item--red')).toHaveLength(5)
    expect(w.find('.cap-hint').exists()).toBe(false)
    w.unmount()
  })
})

function reviewIssue(i: number): ReviewIssueFE {
  return {
    lens: 'reader',
    severity: 'S1',
    category: 'c',
    location: '',
    evidence: [],
    issue: `问题${i}`,
    fix: '',
  }
}

describe('R1010c-FE1-P3-2: ReviewPanel 阻断/警告渲染上限', () => {
  function mountPanel() {
    const ws = useWorkspaceStore()
    seedBodyTree()
    ws.activeDocId = 'doc_ch1'
    return mount(ReviewPanel, { props: { bookName: 'test-book' } })
  }

  function collectedWithBlockers(n: number) {
    return {
      ok: true,
      collected_lenses: [],
      missing_lenses: [],
      raw_issues: [],
      normalized: {
        blockers: Array.from({ length: n }, (_, i) => reviewIssue(i + 1)),
        warnings: [],
        invalid_issues: [],
        passed: false,
      },
      tier: 't',
      chapter: 1,
      lenses_run: [],
    }
  }

  it('130 阻断项 → 只渲染前 100 条 + 「已省略 30 项」；分组头计数仍 130', async () => {
    const w = mountPanel()
    await flushPromises()
    useReviewStore().collected = collectedWithBlockers(130)
    await nextTick()
    expect(w.findAll('.rev-item--red')).toHaveLength(100)
    const hint = w.find('.cap-hint')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('已省略 30 项')
    expect(w.find('.group-label--red').text()).toContain('阻断项（130）')
    w.unmount()
  })

  it('不超上限（3 阻断项）→ 全量渲染零提示', async () => {
    const w = mountPanel()
    await flushPromises()
    useReviewStore().collected = collectedWithBlockers(3)
    await nextTick()
    expect(w.findAll('.rev-item--red')).toHaveLength(3)
    expect(w.find('.cap-hint').exists()).toBe(false)
    w.unmount()
  })
})

describe('R1010c-FE1-P3-2: ForeshadowPanel 未回收/已回收渲染上限', () => {
  function foreshadow(i: number, status: '未回收' | '已回收'): Foreshadow {
    return {
      file: `设定/伏笔/f${i}.md`,
      标题: `伏笔${i}`,
      状态: status,
      埋设章号: i,
      回收章号: status === '已回收' ? i + 1 : null,
      重要性: '低',
      关联词: [],
      摘要: '',
      足迹: null,
    }
  }

  it('130 未回收 → 只渲染前 100 行 + 「已省略 30 项」；统计行仍 130（数据面不动）', async () => {
    mocks.getForeshadows.mockResolvedValue(
      Array.from({ length: 130 }, (_, i) => foreshadow(i + 1, '未回收')),
    )
    const w = mount(ForeshadowPanel, { props: { bookName: '书A' } })
    await flushPromises()
    expect(w.findAll('.fs-item.pending')).toHaveLength(100)
    const hint = w.find('.cap-hint')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('已省略 30 项')
    expect(w.find('.stat-pending').text()).toContain('未回收 130')
    w.unmount()
  })

  it('已回收节同样裁剪：展开后 120 条已回收 → 100 行 + 提示；不超上限零提示', async () => {
    mocks.getForeshadows.mockResolvedValue([
      ...Array.from({ length: 2 }, (_, i) => foreshadow(i + 1, '未回收')),
      ...Array.from({ length: 120 }, (_, i) => foreshadow(i + 10, '已回收')),
    ])
    const w = mount(ForeshadowPanel, { props: { bookName: '书A' } })
    await flushPromises()
    await w.find('.fs-toggle').trigger('click') // 展开已回收节
    expect(w.findAll('.fs-item.resolved')).toHaveLength(100)
    const hints = w.findAll('.cap-hint')
    expect(hints).toHaveLength(1) // 未回收 2 条不裁 → 提示只来自已回收节
    expect(hints[0]!.text()).toContain('已省略 20 项')
    w.unmount()
  })
})

describe('R1010c-FE1-P3-2: TrashPanel 回收站条目渲染上限', () => {
  const entry = (i: number) => ({
    id: `t${i}`,
    path: `.trash/写作/正文/${i}.md`,
    originalPath: `写作/正文/${i}.md`,
  })

  it('130 条目 → 只渲染前 100 行 + 「已省略 30 项」；空态判定不受渲染裁剪影响', async () => {
    mocks.listTrash.mockResolvedValue(Array.from({ length: 130 }, (_, i) => entry(i + 1)))
    const w = mount(TrashPanel, { props: { bookName: '书A' } })
    await flushPromises()
    expect(w.find('.empty-state').exists()).toBe(false) // 仍有条目（数据面看全量）
    expect(w.findAll('.tree-item')).toHaveLength(100)
    const hint = w.find('.cap-hint')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('已省略 30 项')
    w.unmount()
  })

  it('不超上限（5 条目）→ 全量渲染零提示', async () => {
    mocks.listTrash.mockResolvedValue(Array.from({ length: 5 }, (_, i) => entry(i + 1)))
    const w = mount(TrashPanel, { props: { bookName: '书A' } })
    await flushPromises()
    expect(w.findAll('.tree-item')).toHaveLength(5)
    expect(w.find('.cap-hint').exists()).toBe(false)
    w.unmount()
  })
})

// ── R1010c-FE1-P3-1：TrashPanel 行内操作钮键盘焦点显形（CSS 源码锚定，rp3-4 先例：
//    scoped 样式在 happy-dom 不参与计算，行为挂载测不出 opacity 规则） ──────────
describe('R1010c-FE1-P3-1: TrashPanel 操作钮键盘焦点显形（源码锚定）', () => {
  const src = readFileSync(
    resolve(__dirname, '../../../src/studio/web-next/src/components/panels/TrashPanel.vue'),
    'utf-8',
  )

  it('item-actions 补 :focus-visible/:focus-within 显形 + 焦点环（对齐 HistoryPanel R1010-P3）', () => {
    expect(src).toContain('.action-btn:focus-visible')
    expect(src).toContain('.tree-item:focus-within .item-actions')
    // 显形规则与焦点环规则都在（HistoryPanel restore-btn 同款双规则结构）
    expect(src).toContain('outline: 2px solid var(--interactive-accent)')
  })

  it('修复前口径（仅 hover 显形）已被焦点规则补齐——focus 块先于/并列 hover 块存在', () => {
    const hoverOnly = /\.tree-item:hover \.item-actions \{[^}]*\}/.test(src)
    const focusRule = /\.tree-item:focus-within \.item-actions \{[^}]*opacity: 1;/.test(src)
    expect(hoverOnly).toBe(true) // hover 显形保留
    expect(focusRule).toBe(true) // 修复点：键盘焦点同权显形
  })

  it('操作钮是原生 button（键盘可聚焦的前提，渲染面断言）', async () => {
    mocks.listTrash.mockResolvedValue([{ id: 't1', path: '.trash/a.md', originalPath: '写作/a.md' }])
    const w = mount(TrashPanel, { props: { bookName: '书A' } })
    await flushPromises()
    for (const btn of w.findAll('.action-btn')) {
      expect(btn.element.tagName).toBe('BUTTON')
    }
    w.unmount()
  })
})
