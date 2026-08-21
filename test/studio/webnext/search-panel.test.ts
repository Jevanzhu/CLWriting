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
    await w.find('input').trigger('keyup.enter') // 搜索由回车触发
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
    await w.find('input').trigger('keyup.enter')
    await w.setProps({ bookName: '书B' })
    release!({ results: [{ path: 'x', matches: [] }], truncated: false })
    await flushPromises()
    const vm = w.vm as unknown as { results: unknown[] }
    expect(vm.results).toEqual([])
  })
})
