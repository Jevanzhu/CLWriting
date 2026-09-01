// @vitest-environment happy-dom
/**
 * R34D-27~30（三十四轮批 E2：前端组件层）回归。
 *
 * - R34D-27 WritingInfoPanel：getConfig 成功路径不清 err——A 书失败粘滞到 B 书
 *   （面板常驻不随切书重建）；修复 = 切书先清 err，新错误只由本次 catch 落位。
 * - R34D-28 FocusStatsBar：切章误置 firstChangeAt（起算提前摊薄速度）+ 空章首笔
 *   锁进 baseline（首字 +0 且钟不起）；修复 = 会话重开盯 entry 身份 + reset 快照
 *   吞置位跳变 + 空章基线按旧值 0 锁。
 * - R34D-29 TrashPanel.purge：无在途锁无 404 静默（restore 三者全有 R71-32 同型）；
 *   修复 = purge 在途锁（含确认弹窗滞留期）+ 404 按已删收敛（静默 + load 对齐）。
 * - R34D-30 SidebarRight：CollapseSection 随外层 v-if 卸载重建归位 defaultOpen，
 *   手动折叠丢失；修复 = 折叠态上提到 SidebarRight 经 v-model:open 受控保持
 *   （CollapseSection 增可选受控模式，未传 open 的旧用法行为不变）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getTree: vi.fn(),
  listTrash: vi.fn(),
  restoreTrash: vi.fn(),
  purgeTrash: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
  getTree: mocks.getTree,
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  // doc store 同 import 此模块（getContent/saveContent/finalizeDoc），mock 需齐名导出
  listTrash: mocks.listTrash,
  restoreTrash: mocks.restoreTrash,
  purgeTrash: mocks.purgeTrash,
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  createDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getBookPrefs: vi.fn(async () => ({})),
  putBookPrefs: vi.fn(async () => ({})),
  getGlobalPrefs: vi.fn(async () => ({})),
  putGlobalPrefs: vi.fn(async () => ({})),
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
  return {
    ApiError,
    getToken: vi.fn(() => 'test-token'),
    apiJson: vi.fn(async () => ({})),
  }
})

// SidebarRight 子面板打桩（R34D-30 只测折叠区容器行为；WritingInfoPanel 保持真实
// ——同时作 R34D-27 的被测件，不与此处打桩冲突）
const stubComp = vi.hoisted(() => ({ name: 'PanelStub', render: () => null }))
vi.mock('../../../src/studio/web-next/src/components/panels/MetaFormPanel.vue', () => ({ default: stubComp }))
vi.mock('../../../src/studio/web-next/src/components/panels/CheckPanel.vue', () => ({ default: stubComp }))
vi.mock('../../../src/studio/web-next/src/components/panels/ReviewPanel.vue', () => ({ default: stubComp }))
vi.mock('../../../src/studio/web-next/src/components/panels/RewritePanel.vue', () => ({ default: stubComp }))
vi.mock('../../../src/studio/web-next/src/components/panels/AnalysisPanel.vue', () => ({ default: stubComp }))
vi.mock('../../../src/studio/web-next/src/components/panels/HistoryPanel.vue', () => ({ default: stubComp }))
vi.mock('../../../src/studio/web-next/src/components/panels/ForeshadowPanel.vue', () => ({ default: stubComp }))
vi.mock('../../../src/studio/web-next/src/components/panels/ContextQuickPanel.vue', () => ({ default: stubComp }))

import { ApiError } from '../../../src/studio/web-next/src/api/client'
import WritingInfoPanel from '../../../src/studio/web-next/src/components/panels/WritingInfoPanel.vue'
import TrashPanel from '../../../src/studio/web-next/src/components/panels/TrashPanel.vue'
import FocusStatsBar from '../../../src/studio/web-next/src/components/shell/FocusStatsBar.vue'
import SidebarRight from '../../../src/studio/web-next/src/components/shell/SidebarRight.vue'
import CollapseSection from '../../../src/studio/web-next/src/components/ui/CollapseSection.vue'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import type { DocEntry } from '../../../src/studio/web-next/src/stores/doc'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.useRealTimers()
  mocks.getConfig.mockResolvedValue({})
})

afterEach(() => {
  vi.useRealTimers()
})

// ── 公共夹具 ─────────────────────────────────────────────

/** 造一个已加载的文档 entry（FocusStatsBar/WritingInfoPanel 消费 doc store 缓存） */
function docEntry(docId: string, content: string): DocEntry {
  return {
    docId,
    path: `写作/正文/${docId}.md`,
    name: `${docId}.md`,
    role: 'chapter',
    mode: 'text',
    content,
    baselineRevision: 'sha256:test',
    dirty: false,
    saving: false,
    savedAt: null,
    error: null,
    conflict: false,
  }
}

/** 造一颗含正文叶子（doc_ch1）的树（SidebarRight 表单分区/可审性判定用） */
function seedBodyTree(): void {
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
              role: 'chapter',
              children: [],
              docId: 'doc_ch1',
              status: 'draft',
            },
          ],
        },
      ],
    },
  ]
}

const TRASH_ENTRIES = [
  { id: 't1', path: '.trash/写作/正文/a.md', originalPath: '写作/正文/a.md' },
  { id: 't2', path: '.trash/写作/正文/b.md', originalPath: '写作/正文/b.md' },
]

function mountTrashPanel() {
  mocks.listTrash.mockResolvedValue(TRASH_ENTRIES)
  return mount(TrashPanel, { props: { bookName: '书A' } })
}

/** v-show 折叠断言辅助：本环境 happy-dom 的 getComputedStyle 不回填行内样式，
 *  test-utils 的 isVisible() 恒真失真——直接读 v-show 写入的行内 display 判定 */
function isHidden(body: DOMWrapper<Element>): boolean {
  return (body.element as HTMLElement).style.display === 'none'
}

/** 点 purge 按钮并确认弹窗（驱动真实 ui store 的命令式 ask） */
async function purgeAndConfirm(w: ReturnType<typeof mount>, row: number): Promise<void> {
  await w.findAll('.action-btn.danger')[row]!.trigger('click')
  useUiStore().resolveConfirm(true)
  await flushPromises()
}

// ── R34D-27：WritingInfoPanel 切书清 err ─────────────────

describe('R34D-27: WritingInfoPanel 成功路径清 err（A 书错误不粘滞 B 书）', () => {
  it('A 书 getConfig 失败 → 切 B 书成功 → err 清除', async () => {
    mocks.getConfig.mockRejectedValueOnce(new Error('HTTP 502')).mockResolvedValueOnce({})
    const w = mount(WritingInfoPanel, { props: { bookName: '书A' } })
    await flushPromises()
    expect(w.find('.side-hint.err').exists()).toBe(true) // A 书失败如实显示

    await w.setProps({ bookName: '书B' })
    await flushPromises()
    // 修复点：成功路径清 err——修复前 err 粘滞（面板常驻不随切书重建）
    expect(w.find('.side-hint.err').exists()).toBe(false)
    w.unmount()
  })

  it('守恒：B 书自身失败仍如实显示错误', async () => {
    mocks.getConfig.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('HTTP 502'))
    const w = mount(WritingInfoPanel, { props: { bookName: '书A' } })
    await flushPromises()
    expect(w.find('.side-hint.err').exists()).toBe(false)
    await w.setProps({ bookName: '书B' })
    await flushPromises()
    expect(w.find('.side-hint.err').exists()).toBe(true)
    w.unmount()
  })
})

// ── R34D-28：FocusStatsBar 会话口径 ──────────────────────

describe('R34D-28: FocusStatsBar 切章不起钟 + 空章首笔计入 delta', () => {
  it('切章后 60s 才动笔——速度按动笔时刻起算（修复前从切章时刻起算被摊薄）', async () => {
    vi.useFakeTimers()
    const ws = useWorkspaceStore()
    const doc = useDocStore()
    ws.bookName = '书A'
    doc.docs.set('d1', docEntry('d1', '一二三四五')) // 5 字
    doc.docs.set('d2', docEntry('d2', '一二三四五六七八')) // 8 字
    ws.activeDocId = 'd1'
    const w = mount(FocusStatsBar)
    await flushPromises()
    expect(w.text()).toContain('+0 字') // d1 基线 5

    // 切到已缓存的 d2（entry 立即换对象；旧实现此时误置 firstChangeAt）
    ws.activeDocId = 'd2'
    await nextTick()
    await nextTick()

    // 切章后 60s 才动笔 +10 字：修复后钟自动笔时刻起算（0 分钟 → 速度 —），
    // 修复前钟自切章时刻起算（10 字/1 分 = 10 字/分）
    vi.advanceTimersByTime(60_000)
    doc.patch('d2', '一二三四五六七八九十一二三四五六十七') // 8+10=18 字
    await nextTick()
    expect(w.text()).toContain('+10 字')
    expect(w.text()).not.toContain('字/分') // 修复点：切章不起钟
    w.unmount()
  })

  it('空章首笔计入 delta（修复前首字被锁进基线显示 +0）', async () => {
    const ws = useWorkspaceStore()
    const doc = useDocStore()
    ws.bookName = '书A'
    doc.docs.set('e1', docEntry('e1', '')) // 空章
    ws.activeDocId = 'e1'
    const w = mount(FocusStatsBar)
    await flushPromises()
    expect(w.text()).toContain('+0 字')

    doc.patch('e1', '好') // 首笔 1 字
    await nextTick()
    expect(w.text()).toContain('+1 字') // 修复点：基线按旧值 0 锁，首字计入
    w.unmount()
  })

  it('守恒：文档迟到加载不算动笔（不误起钟、不误锁基线）', async () => {
    const ws = useWorkspaceStore()
    const doc = useDocStore()
    ws.bookName = '书A'
    ws.activeDocId = 'd9' // 尚未加载（无 entry）
    const w = mount(FocusStatsBar)
    await flushPromises()
    expect(w.text()).toContain('+0 字')

    doc.docs.set('d9', docEntry('d9', '一二三')) // 加载到位：0→3 是置位非动笔
    await nextTick()
    await nextTick()
    expect(w.text()).toContain('+0 字')
    expect(w.text()).not.toContain('字/分')
    w.unmount()
  })
})

// ── R34D-29：TrashPanel.purge 在途锁 + 404 静默 ──────────

describe('R34D-29: TrashPanel purge 在途锁 + 404 收敛静默', () => {
  it('确认弹窗滞留期双击 → 第二笔被在途锁挡，purgeTrash 只发一次', async () => {
    mocks.purgeTrash.mockResolvedValue({ ok: true })
    const w = mountTrashPanel()
    await flushPromises()
    const btn = w.findAll('.action-btn.danger')[0]!

    await btn.trigger('click') // 第一笔：弹确认（锁已置）
    const ui = useUiStore()
    expect(ui.confirmState).not.toBeNull()
    await btn.trigger('click') // 双击第二笔（弹窗滞留期）→ 在途锁挡
    expect(mocks.purgeTrash).not.toHaveBeenCalled()

    ui.resolveConfirm(true)
    await flushPromises()
    // 修复点：仅一笔请求（修复前第二笔在第一笔完成后必 404）
    expect(mocks.purgeTrash).toHaveBeenCalledTimes(1)
    expect(mocks.purgeTrash).toHaveBeenCalledWith('书A', 't1')
    w.unmount()
  })

  it('请求在途时点另一条 purge → 被在途锁挡（不弹第二个确认框）', async () => {
    let resolvePurge!: (v: unknown) => void
    mocks.purgeTrash.mockReturnValue(new Promise((r) => (resolvePurge = r)))
    const w = mountTrashPanel()
    await flushPromises()

    await purgeAndConfirm(w, 0) // t1 请求在途（purging 持锁）
    expect(mocks.purgeTrash).toHaveBeenCalledTimes(1)
    await w.findAll('.action-btn.danger')[1]!.trigger('click') // t2 第二笔
    expect(useUiStore().confirmState).toBeNull() // 修复点：锁挡，未弹第二个确认框

    resolvePurge({ ok: true })
    await flushPromises()
    expect(mocks.purgeTrash).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('确认取消 → 锁释放，后续 purge 正常可发（锁不泄漏）', async () => {
    mocks.purgeTrash.mockResolvedValue({ ok: true })
    const w = mountTrashPanel()
    await flushPromises()
    await w.findAll('.action-btn.danger')[0]!.trigger('click')
    useUiStore().resolveConfirm(false)
    await flushPromises()
    expect(mocks.purgeTrash).not.toHaveBeenCalled()

    await purgeAndConfirm(w, 0) // 取消后重发：锁已释放，正常走通
    expect(mocks.purgeTrash).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('迟到 404（条目已被清）→ 静默 + load 对齐列表，不覆盖成假错误态', async () => {
    mocks.purgeTrash.mockRejectedValue(new ApiError('回收站无此条目', 404, 'NOT_FOUND'))
    mocks.listTrash
      .mockResolvedValueOnce(TRASH_ENTRIES)
      .mockResolvedValueOnce([TRASH_ENTRIES[1]!]) // 404 收敛 load：t1 已不在
    const w = mountTrashPanel()
    await flushPromises()

    await purgeAndConfirm(w, 0)
    // 修复点：404 按已删收敛——面板不被错误态覆盖、无 toast
    expect(w.find('.empty-state.err').exists()).toBe(false)
    expect(useUiStore().toasts).toHaveLength(0)
    expect(mocks.listTrash).toHaveBeenCalledTimes(2) // 初载 + 404 收敛刷新
    expect(w.findAll('.tree-item')).toHaveLength(1) // 列表对齐（t1 已删）
    w.unmount()
  })

  it('守恒：非 404 失败仍置 err 提示（R76-32 口径保留）', async () => {
    mocks.purgeTrash.mockRejectedValue(new ApiError('服务异常', 500, 'INTERNAL'))
    const w = mountTrashPanel()
    await flushPromises()
    await purgeAndConfirm(w, 0)
    expect(w.find('.empty-state.err').exists()).toBe(true)
    w.unmount()
  })
})

// ── R34D-30：SidebarRight 折叠态跨卸载保持 ───────────────

describe('R34D-30: SidebarRight 折叠区状态跨 v-if 卸载保持', () => {
  it('切右栏 tab 往返——手动折叠保持（修复前随 v-if 卸载归位展开）', async () => {
    seedBodyTree()
    const ws = useWorkspaceStore()
    ws.bookName = '书A'
    ws.activeDocId = 'doc_ch1'
    const w = mount(SidebarRight, { props: { bookName: '书A' } })
    await flushPromises()
    expect(w.findAll('.collapse-body')).toHaveLength(4) // 写作信息/伏笔/AI 分析/本章历史

    // 手动折叠「伏笔追踪」（第 2 区）
    await w.findAll('.collapse-head')[1]!.trigger('click')
    expect(isHidden(w.findAll('.collapse-body')[1]!)).toBe(true)

    // 切到审阅 tab（info 模板整体 v-if 卸载）再切回
    ws.setRightTab('review')
    await nextTick()
    expect(w.findAll('.collapse-body')).toHaveLength(0)
    ws.setRightTab('info')
    await nextTick()
    // 修复点：重建后折叠态保持（修复前归位 defaultOpen=true → 重新可见）
    expect(w.findAll('.collapse-body')).toHaveLength(4)
    expect(isHidden(w.findAll('.collapse-body')[1]!)).toBe(true)
    w.unmount()
  })

  it('activeDocId 短暂置空往返——「写作信息」折叠保持', async () => {
    seedBodyTree()
    const ws = useWorkspaceStore()
    ws.bookName = '书A'
    ws.activeDocId = 'doc_ch1'
    const w = mount(SidebarRight, { props: { bookName: '书A' } })
    await flushPromises()

    await w.findAll('.collapse-head')[0]!.trigger('click') // 折叠「写作信息」
    expect(isHidden(w.findAll('.collapse-body')[0]!)).toBe(true)

    ws.activeDocId = null // 分区随 v-if 卸载（仅剩伏笔追踪）
    await nextTick()
    expect(w.findAll('.collapse-body')).toHaveLength(1)
    ws.activeDocId = 'doc_ch1' // 重建
    await nextTick()
    expect(w.findAll('.collapse-body')).toHaveLength(4)
    expect(isHidden(w.findAll('.collapse-body')[0]!)).toBe(true) // 修复点：保持折叠
    w.unmount()
  })
})

describe('R34D-30: CollapseSection 受控/非受控双模式', () => {
  it('守恒：未传 open 仍内部态自持（WbAdvanced 等旧用法行为不变）', async () => {
    const w = mount(CollapseSection, { props: { title: '高级', defaultOpen: false } })
    expect(isHidden(w.find('.collapse-body'))).toBe(true)
    await w.find('.collapse-head').trigger('click')
    expect(isHidden(w.find('.collapse-body'))).toBe(false)
    w.unmount()
  })

  it('受控：open 由宿主持有——点击 emit update:open 但不私变显示', async () => {
    const w = mount(CollapseSection, { props: { title: 'x', open: false } })
    expect(isHidden(w.find('.collapse-body'))).toBe(true)
    await w.find('.collapse-head').trigger('click')
    expect(w.emitted('update:open')?.[0]).toEqual([true])
    expect(isHidden(w.find('.collapse-body'))).toBe(true) // 宿主未回写前不变（受控语义）
    w.unmount()
  })
})
