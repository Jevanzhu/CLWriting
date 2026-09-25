// @vitest-environment happy-dom
/**
 * SidebarRight 折叠态跨卸载保持 + CollapseSection 受控/非受控双模式行为族（happy-dom）。
 * （原 r34d-e2-panels 的 R34D-30 节，按行为单拆——容器保持与其依赖的受控模式同文件。）
 *
 * R34D-30（三十四轮批 E2）：CollapseSection 随外层 v-if 卸载重建归位 defaultOpen，
 * 手动折叠丢失；修复 = 折叠态上提到 SidebarRight 经 v-model:open 受控保持（CollapseSection
 * 增可选受控模式，未传 open 的旧用法行为不变）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises, type DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getTree: vi.fn(),
  getConfig: vi.fn(async () => ({})),
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  createDoc: vi.fn(),
  listTrash: vi.fn(),
  restoreTrash: vi.fn(),
  purgeTrash: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getBookPrefs: vi.fn(async () => ({})),
  putBookPrefs: vi.fn(async () => ({})),
  getGlobalPrefs: vi.fn(async () => ({})),
  putGlobalPrefs: vi.fn(async () => ({})),
}))
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return {
    ...actual,
    getToken: vi.fn(() => 'test-token'),
  }
})

// SidebarRight 子面板打桩（R34D-30 只测折叠区容器行为）
const stubComp = vi.hoisted(() => ({ name: 'PanelStub', render: () => null }))
vi.mock('../../../src/studio/web-next/src/components/panels/MetaFormPanel.vue', () => ({ default: stubComp }))
vi.mock('../../../src/studio/web-next/src/components/panels/CheckPanel.vue', () => ({ default: stubComp }))
vi.mock('../../../src/studio/web-next/src/components/panels/ReviewPanel.vue', () => ({ default: stubComp }))
vi.mock('../../../src/studio/web-next/src/components/panels/RewritePanel.vue', () => ({ default: stubComp }))
vi.mock('../../../src/studio/web-next/src/components/panels/AnalysisPanel.vue', () => ({ default: stubComp }))
vi.mock('../../../src/studio/web-next/src/components/panels/HistoryPanel.vue', () => ({ default: stubComp }))
vi.mock('../../../src/studio/web-next/src/components/panels/ForeshadowPanel.vue', () => ({ default: stubComp }))
vi.mock('../../../src/studio/web-next/src/components/panels/ContextQuickPanel.vue', () => ({ default: stubComp }))

import SidebarRight from '../../../src/studio/web-next/src/components/shell/SidebarRight.vue'
import CollapseSection from '../../../src/studio/web-next/src/components/ui/CollapseSection.vue'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'

/** v-show 折叠断言辅助：本环境 happy-dom 的 getComputedStyle 不回填行内样式，
 *  test-utils 的 isVisible() 恒真失真——直接读 v-show 写入的行内 display 判定 */
function isHidden(body: DOMWrapper<Element>): boolean {
  return (body.element as HTMLElement).style.display === 'none'
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

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

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
