// @vitest-environment happy-dom
/**
 * ReviewPanel 组件交互测试（Z-P2-11，评审测试缺口）。
 *
 * 覆盖面板行为（store 内部逻辑是 review-store.test.ts 的职责，此处只测渲染分派）：
 * - 可审性判定（非正文 → 提示 + 置灰）
 * - AI 不可达 → 三审置灰但作者裁决不置灰（作者决策非 AI）
 * - blockers/warnings 分组渲染（计数/severity 人话/镜头人话/证据拼接/建议）
 * - passed / stale / error 三态提示
 * - verdict 徽章三态 + 裁决点击（落 API + 刷新树红点 + 失败 toast）
 * - 打开正文文档 → 读存量信封；切走 → 清空
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import ReviewPanel from '../../../src/studio/web-next/src/components/panels/ReviewPanel.vue'
import { useReviewStore } from '../../../src/studio/web-next/src/stores/review'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import type { CollectedReviewFE, ReviewEnvelope, ReviewIssueFE } from '../../../src/studio/web-next/src/api/review'

// ── mock API 层（拦截真实网络请求） ────────────────────

const mocks = vi.hoisted(() => ({
  runReview: vi.fn(),
  getReviewEnvelope: vi.fn(),
  runVerdictDoc: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/review', () => ({
  runReview: mocks.runReview,
  getReviewEnvelope: mocks.getReviewEnvelope,
  runVerdictDoc: mocks.runVerdictDoc,
}))

/** 造一颗正文树：doc_ch1（可审）+ doc_syn（总纲，不可审）。 */
function seedTree(): void {
  const tree = useTreeStore()
  tree.raw = [
    {
      path: '写作',
      name: '写作',
      isDirectory: true,
      role: '',
      children: [
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
      ],
    },
    {
      path: '大纲',
      name: '大纲',
      isDirectory: true,
      role: '',
      children: [
        {
          path: '大纲/总纲.md',
          name: '总纲.md',
          isDirectory: false,
          role: '',
          children: [],
          docId: 'doc_syn',
          status: 'draft',
        },
      ],
    },
  ]
}

function issue(over: Partial<ReviewIssueFE>): ReviewIssueFE {
  return { lens: 'reader', severity: 'S1', category: 'c', location: '', evidence: [], issue: '', fix: '', ...over }
}

function collected(over: Partial<CollectedReviewFE> = {}): CollectedReviewFE {
  return {
    ok: true,
    collected_lenses: [],
    missing_lenses: [],
    raw_issues: [],
    normalized: { blockers: [], warnings: [], invalid_issues: [], passed: true },
    tier: 't',
    chapter: 1,
    lenses_run: [],
    ...over,
  }
}

function envelope(payloadOver: Partial<ReviewEnvelope['payload']> = {}): ReviewEnvelope {
  return {
    generatedAt: '2026-08-16T00:00:00Z',
    model: 'm',
    sourceHash: 'sha256:x',
    payload: { collected: collected(), lenses: [], ...payloadOver },
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.runReview.mockReset().mockResolvedValue({ ok: true, lenses: [], collected: collected() })
  mocks.getReviewEnvelope.mockReset().mockResolvedValue(undefined)
  mocks.runVerdictDoc.mockReset().mockResolvedValue(undefined)
  seedTree()
})

/** 默认打开 doc_ch1（正文，可审）。 */
function mountPanel(opts: { docId?: string | null } = {}) {
  const ws = useWorkspaceStore()
  ws.activeDocId = opts.docId === undefined ? 'doc_ch1' : opts.docId
  return mount(ReviewPanel, { props: { bookName: 'test-book' } })
}

// ── 可审性 / 置灰 ─────────────────────────────────────

describe('ReviewPanel: 可审性', () => {
  it('非正文文档（总纲）→ 提示 + 三审置灰 + 无裁决块', async () => {
    const w = mountPanel({ docId: 'doc_syn' })
    await flushPromises()
    expect(w.find('.rev-hint').text()).toContain('三审仅适用于正文')
    expect(w.find('.rev-run-btn').attributes('disabled')).toBeDefined()
    expect(w.find('.rev-verdict').exists()).toBe(false)
  })

  it('无激活文档 → 同样提示', async () => {
    const w = mountPanel({ docId: null })
    await flushPromises()
    expect(w.find('.rev-hint').text()).toContain('三审仅适用于正文')
  })

  it('正文文档 → 三审按钮可用 + 提示生成语 + 待审徽章', async () => {
    const w = mountPanel()
    await flushPromises()
    expect(w.find('.rev-run-btn').attributes('disabled')).toBeUndefined()
    expect(w.find('.rev-hint').text()).toContain('点击「三审」')
    expect(w.find('.rev-verdict-badge').text()).toBe('待审')
    expect(w.find('.rev-verdict-badge').classes()).toContain('verdict-pending')
  })
})

describe('ReviewPanel: AI 不可达', () => {
  it('aiOff → 三审置灰 + 提示条；裁决按钮不置灰（作者决策非 AI）', async () => {
    const ui = useUiStore()
    ui.aiAvailable = false
    const w = mountPanel()
    await flushPromises()
    expect(w.find('.rev-run-btn').attributes('disabled')).toBeDefined()
    expect(w.find('.rev-run-btn').attributes('data-tip')).toContain('AI 不可达')
    expect(w.find('.rev-ai-off').exists()).toBe(true)
    const btns = w.findAll('.rev-verdict-btn')
    expect(btns).toHaveLength(2)
    for (const b of btns) expect(b.attributes('disabled')).toBeUndefined()
  })
})

// ── 意见分组渲染 ──────────────────────────────────────

describe('ReviewPanel: 意见分组', () => {
  it('blockers/warnings 分组：计数 + severity/镜头人话 + 证据「；」拼接 + 建议', async () => {
    const review = useReviewStore()
    const w = mountPanel()
    await flushPromises()
    review.collected = collected({
      normalized: {
        blockers: [issue({ lens: 'hook', severity: 'S2', location: '第 3 段', evidence: ['甲', '乙'], issue: '钩子断裂', fix: '补一句悬念' })],
        warnings: [issue({ lens: 'reader', severity: 'S3', issue: '节奏偏慢', fix: '' })],
        invalid_issues: [],
        passed: false,
      },
    })
    await nextTick()
    expect(w.find('.group-label--red').text()).toContain('阻断项（1）')
    expect(w.find('.group-label--yellow').text()).toContain('警告项（1）')
    const red = w.find('.rev-item--red')
    expect(red.find('.item-sev').classes()).toContain('sev-high')
    expect(red.find('.item-sev').text()).toBe('重点')
    expect(red.find('.item-lens').text()).toBe('钩子审')
    expect(red.find('.item-loc').text()).toBe('第 3 段')
    expect(red.find('.item-evidence').text()).toBe('「甲；乙」')
    expect(red.find('.item-fix').text()).toBe('建议：补一句悬念')
    const yellow = w.find('.rev-item--yellow')
    expect(yellow.find('.item-sev').classes()).toContain('sev-low')
    expect(yellow.find('.item-sev').text()).toBe('参考')
    expect(yellow.find('.item-evidence').exists()).toBe(false) // 空证据不渲染
    expect(yellow.find('.item-fix').exists()).toBe(false) // 空 fix 不渲染
  })

  it('passed 且无意见 → 干净提示', async () => {
    const review = useReviewStore()
    const w = mountPanel()
    await flushPromises()
    review.collected = collected()
    await nextTick()
    expect(w.find('.rev-clean').text()).toContain('三审通过，无阻断/警告')
    expect(w.find('.group-label--red').exists()).toBe(false)
  })

  it('stale → 过期提示条', async () => {
    const review = useReviewStore()
    const w = mountPanel()
    await flushPromises()
    review.collected = collected()
    review.stale = true // mount 后置（immediate watch 的 loadEnvelope 会把 stale 复位）
    await nextTick()
    expect(w.find('.rev-stale').text()).toContain('正文已变更')
  })

  it('error → 错误条展示', async () => {
    const review = useReviewStore()
    review.error = '三审失败：网络错误'
    const w = mountPanel()
    await nextTick()
    expect(w.find('.rev-error').text()).toContain('三审失败：网络错误')
  })
})

// ── 发起三审 / 信封读取 ───────────────────────────────

describe('ReviewPanel: 三审与信封', () => {
  it('点击三审 → runReview(bookName, docId)', async () => {
    const w = mountPanel()
    await flushPromises()
    await w.find('.rev-run-btn').trigger('click')
    expect(mocks.runReview).toHaveBeenCalledWith('test-book', 'doc_ch1')
  })

  it('打开正文文档 → loadEnvelope 读存量；切走 → 清空', async () => {
    const w = mountPanel()
    await flushPromises()
    expect(mocks.getReviewEnvelope).toHaveBeenCalledWith('test-book', 'doc_ch1')
    const review = useReviewStore()
    review.collected = collected()
    const ws = useWorkspaceStore()
    ws.activeDocId = null
    await flushPromises()
    expect(review.collected).toBeNull()
  })
})

// ── 作者裁决（verdict） ───────────────────────────────

describe('ReviewPanel: 作者裁决', () => {
  it('驳回信封 → 徽章「驳回」reject 态；点击通过 → runVerdictDoc + 刷新树红点', async () => {
    mocks.getReviewEnvelope.mockResolvedValue({ ok: true, envelope: envelope({ verdict: { approved: false, at: 't' } }), stale: false })
    const tree = useTreeStore()
    const loadIssues = vi.spyOn(tree, 'loadIssues').mockResolvedValue(undefined)
    const w = mountPanel()
    await flushPromises()
    const badge = w.find('.rev-verdict-badge')
    expect(badge.text()).toBe('驳回')
    expect(badge.classes()).toContain('verdict-reject')
    await w.findAll('.rev-verdict-btn')[0]!.trigger('click') // 通过
    await flushPromises()
    expect(mocks.runVerdictDoc).toHaveBeenCalledWith('test-book', 'doc_ch1', true)
    expect(loadIssues).toHaveBeenCalledWith('test-book') // T9b 树红点联动
  })

  it('通过信封 → 徽章「通过」pass 态 + active 类', async () => {
    mocks.getReviewEnvelope.mockResolvedValue({ ok: true, envelope: envelope({ verdict: { approved: true, at: 't' } }), stale: false })
    const w = mountPanel()
    await flushPromises()
    const badge = w.find('.rev-verdict-badge')
    expect(badge.text()).toBe('通过')
    expect(badge.classes()).toContain('verdict-pass')
    expect(w.findAll('.rev-verdict-btn')[0]!.classes()).toContain('active')
  })

  it('裁决失败 → toast 报错（RB-FE-P2-3），不再静默', async () => {
    mocks.runVerdictDoc.mockRejectedValue(new Error('后端不可达'))
    const w = mountPanel()
    await flushPromises()
    await w.findAll('.rev-verdict-btn')[1]!.trigger('click') // 驳回
    await flushPromises()
    const ui = useUiStore()
    expect(ui.toasts).toHaveLength(1)
    expect(ui.toasts[0]!.kind).toBe('error')
  })
})
