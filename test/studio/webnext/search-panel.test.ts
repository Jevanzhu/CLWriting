// @vitest-environment happy-dom
/**
 * M-7（第八轮）回归：SearchPanel 切书清面板。
 *
 * 修复背景：SidebarLeft 常驻渲染不随切书重建，SearchPanel 是左栏三面板中唯一没有
 * bookName watch 的——A 书命中残留到 B 书界面，点击在 B 树找同路径（找到开 B 书文档、
 * 找不到静默无响应）。TrashPanel / ChapterTreePanel / ForeshadowPanel 均已有 watch。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SearchPanel from '../../../src/studio/web-next/src/components/panels/SearchPanel.vue'

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/search', () => ({
  search: mocks.search,
}))

const storeMocks = vi.hoisted(() => ({
  open: vi.fn(),
  openTab: vi.fn(),
  bookName: '书A' as string,
}))
vi.mock('../../../src/studio/web-next/src/stores/tree', () => ({
  useTreeStore: () => ({
    byPath: new Map([
      ['写作/正文/1-一.md', { path: '写作/正文/1-一.md', name: '1-一', isDirectory: false, role: 'piece-body', children: [], docId: 'doc-1' }],
    ]),
  }),
}))
vi.mock('../../../src/studio/web-next/src/stores/doc', () => ({
  useDocStore: () => ({ open: storeMocks.open }),
}))
vi.mock('../../../src/studio/web-next/src/stores/workspace', () => ({
  useWorkspaceStore: () => ({ bookName: storeMocks.bookName, openTab: storeMocks.openTab }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.search.mockReset()
})

describe('M-7: SearchPanel 切书清残留', () => {
  it('A 书命中后切 B 书 → results/truncated 清空', async () => {
    mocks.search.mockResolvedValue({
      results: [{ path: '写作/正文/1-一.md', matches: [{ line: 3, text: '焦痕在烛火下' }] }],
      truncated: false,
    })
    const w = mount(SearchPanel, { props: { bookName: '书A' } })
    await w.find('input').setValue('焦痕')
    await w.find('input').trigger('keydown.enter') // 搜索由回车触发（R61-17：keyup → keydown + IME 守卫）
    await flushPromises()
    expect(mocks.search).toHaveBeenCalledWith('书A', '焦痕', 'all')
    expect((w.vm as unknown as { results: unknown[] }).results.length).toBe(1)

    await w.setProps({ bookName: '书B' })
    await flushPromises()
    const vm = w.vm as unknown as { results: unknown[]; truncated: boolean }
    expect(vm.results).toEqual([])
    expect(vm.truncated).toBe(false)
  })

  it('在途搜索响应在切书后到达 → 不渲染（gen 作废）', async () => {
    let release: ((v: unknown) => void) | null = null
    mocks.search.mockImplementation(() => new Promise((res) => { release = res }))
    const w = mount(SearchPanel, { props: { bookName: '书A' } })
    await w.find('input').setValue('关键词')
    await w.find('input').trigger('keydown.enter')
    await w.setProps({ bookName: '书B' })
    release!({ results: [{ path: 'x', matches: [] }], truncated: false })
    await flushPromises()
    const vm = w.vm as unknown as { results: unknown[] }
    expect(vm.results).toEqual([])
  })

  // R-1/R-24（第十六轮）：切书推代 + finally 查代把 loading 永久卡 true——搜索框「搜索中…」不消失
  it('在途搜索切书 → loading 立即复位（迟到响应 settle 后仍为 false）', async () => {
    let release: ((v: unknown) => void) | null = null
    mocks.search.mockImplementation(() => new Promise((res) => { release = res }))
    const w = mount(SearchPanel, { props: { bookName: '书A' } })
    await w.find('input').setValue('关键词')
    await w.find('input').trigger('keydown.enter')
    expect(w.find('.hint').text()).toContain('搜索中')

    await w.setProps({ bookName: '书B' })
    const vm = w.vm as unknown as { loading: boolean }
    expect(vm.loading).toBe(false) // 修复前：仍 true，「搜索中…」永久残留
    expect(w.find('.hint').exists() ? w.find('.hint').text() : '').not.toContain('搜索中')

    release!({ results: [], truncated: false }) // 迟到响应 settle
    await flushPromises()
    expect(vm.loading).toBe(false)
  })
})

// R1010c-FE1-P3-3（2026-09-10 全量独立复审修复批）：命中行余量提示——原 slice(0,3)
// 截断静默；>3 条时点名余量，hasMore（服务端单文件 20 条封顶 R72-9）以「20+」区分
// 服务端截断（真实总数未知，不虚报精确余量）。
describe('R1010c-FE1-P3-3: 命中行余量提示', () => {
  async function searchHits(matches: { line: number; text: string }[], hasMore?: boolean) {
    const w = mount(SearchPanel, { props: { bookName: '书A' } })
    mocks.search.mockResolvedValue({
      results: [{ path: '写作/正文/1-一.md', matches, ...(hasMore ? { hasMore: true } : {}) }],
      truncated: false,
    })
    await w.find('input').setValue('关键词')
    await w.find('input').trigger('keydown.enter')
    await flushPromises()
    return w
  }

  it('5 条命中 → 只渲染前 3 行 + 「还有 2 条」（精确余量）', async () => {
    const w = await searchHits(Array.from({ length: 5 }, (_, i) => ({ line: i + 1, text: `行${i}` })))
    expect(w.findAll('.result-line')).toHaveLength(3)
    expect(w.find('.result-more').text()).toContain('还有 2 条')
    expect(w.find('.result-more').text()).not.toContain('20+')
    w.unmount()
  })

  it('服务端截断（20 条 + hasMore）→ 「还有 20+ 条」区分服务端封顶', async () => {
    const w = await searchHits(
      Array.from({ length: 20 }, (_, i) => ({ line: i + 1, text: `行${i}` })),
      true,
    )
    expect(w.findAll('.result-line')).toHaveLength(3)
    expect(w.find('.result-more').text()).toContain('还有 20+ 条')
    w.unmount()
  })

  it('≤3 条命中 → 全量渲染零提示', async () => {
    const w = await searchHits([
      { line: 1, text: '甲' },
      { line: 4, text: '乙' },
      { line: 9, text: '丙' },
    ])
    expect(w.findAll('.result-line')).toHaveLength(3)
    expect(w.find('.result-more').exists()).toBe(false)
    w.unmount()
  })
})

// ── 重评-0912-4 P2-4（2026-09-12 全量重评修复批）：open 失败错误独立作用域 ──
describe('重评-0912-4 P2-4: open 失败不顶替结果列表', () => {
  beforeEach(() => {
    storeMocks.open.mockReset()
    storeMocks.openTab.mockReset()
    storeMocks.bookName = '书A'
  })

  async function mountedWithResults() {
    mocks.search.mockResolvedValue({
      results: [
        { path: '写作/正文/1-一.md', matches: [{ line: 1, text: '甲' }] },
        { path: '写作/正文/2-二.md', matches: [{ line: 2, text: '乙' }] },
      ],
      truncated: false,
    })
    const w = mount(SearchPanel, { props: { bookName: '书A' } })
    await w.find('input').setValue('词')
    await w.find('input').trigger('keydown.enter')
    await flushPromises()
    return w
  }

  it('open 失败 → 错误在列表上方追加，其余结果维持可见（修复前整列表被 err 顶替）', async () => {
    const w = await mountedWithResults()
    storeMocks.open.mockRejectedValueOnce(new Error('文件被外部占用'))
    await w.findAll('.result')[0]!.trigger('click')
    await flushPromises()
    expect(w.findAll('.result')).toHaveLength(2)
    expect(w.find('.hint.err').text()).toContain('占用')
    w.unmount()
  })

  it('open 成功 → 无错误提示，openTab 照常', async () => {
    const w = await mountedWithResults()
    storeMocks.open.mockResolvedValueOnce(undefined)
    await w.findAll('.result')[0]!.trigger('click')
    await flushPromises()
    expect(storeMocks.openTab).toHaveBeenCalledWith('doc-1')
    expect(w.find('.hint.err').exists()).toBe(false)
    w.unmount()
  })

  it('open 失败提示不残留：下一次搜索开始即清空', async () => {
    const w = await mountedWithResults()
    storeMocks.open.mockRejectedValueOnce(new Error('x'))
    await w.findAll('.result')[0]!.trigger('click')
    await flushPromises()
    expect(w.find('.hint.err').exists()).toBe(true)
    mocks.search.mockResolvedValue({ results: [], truncated: false })
    await w.find('input').setValue('新词')
    await w.find('input').trigger('keydown.enter')
    await flushPromises()
    expect(w.find('.hint.err').exists()).toBe(false)
    w.unmount()
  })

  it('切书清查询词 q（重评-0912-4 随批 P3：残留旧书词回车即对新书重搜）', async () => {
    const w = await mountedWithResults()
    await w.setProps({ bookName: '书B' })
    await flushPromises()
    expect((w.find('input').element as HTMLInputElement).value).toBe('')
    w.unmount()
  })
})
