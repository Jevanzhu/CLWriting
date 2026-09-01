// @vitest-environment happy-dom
/**
 * R36-22（三十六轮）：StyleEntryPanel / StyleBaselineCard await 后 toast/状态更新无
 * 书名复检，切书错位（同域 StyleCandidateBox 已设防，本批补齐漏点）。
 *
 * - StyleEntryPanel.submitAdd：入库在途切书后，成功 toast/表单复位不得落 B 书界面
 *   （catch 的错误 toast 同样）；onRemove await 后补复检（原只在删除前检查）。
 *   复检走共享 style store 活书名（StyleView :key 重建后死实例的 store 引用仍活着，
 *   store.bookName 已是新书——与 FE-3/R26-73 同域口径）。
 * - StyleBaselineCard.toggleRulesEdit：铁律读取在途切书后，旧书内容不得回填表单
 *   （editingRules 不打开）、失败 toast 不得落 B 书界面（armed+bookName 双门，与
 *   同文件 onFreeze/saveRules 的 R28-25 同口径）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import StyleEntryPanel from '../../../src/studio/web-next/src/components/style/StyleEntryPanel.vue'
import StyleBaselineCard from '../../../src/studio/web-next/src/components/style/StyleBaselineCard.vue'
import { useStyleStore } from '../../../src/studio/web-next/src/stores/style'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import type { StyleEntryFE } from '../../../src/studio/web-next/src/api/style'

// 可变路由 mock（双注册，对齐 r28-style-armed-guard.test.ts 惯例）
const mockRoute = vi.hoisted(() => ({ params: { name: '书A' } }))
vi.mock('vue-router', () => ({ useRoute: () => mockRoute }))
vi.mock('../../../src/studio/web-next/node_modules/vue-router', () => ({ useRoute: () => mockRoute }))

// StyleBaselineCard 的铁律读写 mock
const docsMocks = vi.hoisted(() => ({ getContentRevisioned: vi.fn(), putContent: vi.fn() }))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContentRevisioned: docsMocks.getContentRevisioned,
  putContent: docsMocks.putContent,
}))

function pending<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function entry(path: string): StyleEntryFE {
  return { _path: path, 类型: '样章', 场景: '', 说明: '', 正文: '样章正文', 来源: '作者标注' }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mockRoute.params.name = '书A'
})

// ── StyleEntryPanel：入库/删除 await 后书名复检 ─────────────────

describe('R36-22：StyleEntryPanel await 后书名复检', () => {
  it('入库在途切书 → 成功不 toast、表单不复位（旧实现成功 toast 落 B 书界面）', async () => {
    const style = useStyleStore()
    const ui = useUiStore()
    style.bookName = '书A'
    const req = pending<unknown>()
    vi.spyOn(style, 'add').mockReturnValue(req.promise as Promise<void>)

    const wrapper = mount(StyleEntryPanel)
    await flushPromises()
    await wrapper.find('.head-actions .btn-primary').trigger('click') // 打开新增表单
    await wrapper.find('.af-textarea').setValue('样章正文一段')
    await wrapper.find('.af-actions .btn-primary').trigger('click')

    style.bookName = '书B' // 入库在途切书（store 活书名已是新书）
    req.resolve({})
    await flushPromises()

    expect(ui.toasts).toHaveLength(0) // 修复点：成功 toast 不落 B 书界面
    expect(wrapper.find('.add-form').exists()).toBe(true) // 表单不复位（死实例 UI，但不误复位）
    wrapper.unmount()
  })

  it('入库失败 settle 在切书后 → 错误 toast 也不落 B 书界面', async () => {
    const style = useStyleStore()
    const ui = useUiStore()
    style.bookName = '书A'
    const req = pending<unknown>()
    vi.spyOn(style, 'add').mockReturnValue(req.promise as Promise<void>)

    const wrapper = mount(StyleEntryPanel)
    await flushPromises()
    await wrapper.find('.head-actions .btn-primary').trigger('click')
    await wrapper.find('.af-textarea').setValue('样章正文一段')
    await wrapper.find('.af-actions .btn-primary').trigger('click')

    style.bookName = '书B'
    req.reject(new Error('入库失败'))
    await flushPromises()

    expect(ui.toasts).toHaveLength(0)
    wrapper.unmount()
  })

  it('未切书 → 不误伤：入库成功照常 toast + 收表单', async () => {
    const style = useStyleStore()
    const ui = useUiStore()
    style.bookName = '书A'
    vi.spyOn(style, 'add').mockResolvedValue(undefined)

    const wrapper = mount(StyleEntryPanel)
    await flushPromises()
    await wrapper.find('.head-actions .btn-primary').trigger('click')
    await wrapper.find('.af-textarea').setValue('样章正文一段')
    await wrapper.find('.af-actions .btn-primary').trigger('click')
    await flushPromises()

    expect(ui.toasts.some((t) => t.msg.includes('已存入条目库'))).toBe(true)
    expect(wrapper.find('.add-form').exists()).toBe(false)
    wrapper.unmount()
  })

  it('删除在途切书 → 「已删除」提示不落 B 书界面（await 后补复检）', async () => {
    const style = useStyleStore()
    const ui = useUiStore()
    style.bookName = '书A'
    style.entries = [entry('样章/xxx.md')]
    const req = pending<unknown>()
    vi.spyOn(style, 'remove').mockReturnValue(req.promise as Promise<void>)
    vi.spyOn(ui, 'ask').mockResolvedValue(true)

    const wrapper = mount(StyleEntryPanel)
    await flushPromises()
    await wrapper.find('.entry-card .ec-del').trigger('click') // ask 已过、remove 在途
    await flushPromises()

    style.bookName = '书B'
    req.resolve({})
    await flushPromises()

    expect(ui.toasts).toHaveLength(0) // 修复点：删除成功 toast 不落 B 书界面
    wrapper.unmount()
  })

  it('删除未切书 → 不误伤：「已删除」照常 toast', async () => {
    const style = useStyleStore()
    const ui = useUiStore()
    style.bookName = '书A'
    style.entries = [entry('样章/yyy.md')]
    vi.spyOn(style, 'remove').mockResolvedValue(undefined)
    vi.spyOn(ui, 'ask').mockResolvedValue(true)

    const wrapper = mount(StyleEntryPanel)
    await flushPromises()
    await wrapper.find('.entry-card .ec-del').trigger('click')
    await flushPromises()

    expect(ui.toasts.some((t) => t.msg.includes('已删除'))).toBe(true)
    wrapper.unmount()
  })
})

// ── StyleBaselineCard：toggleRulesEdit await 后 armed+bookName 双门 ──

describe('R36-22：StyleBaselineCard toggleRulesEdit 在途切书守卫', () => {
  it('铁律读取失败 settle 在切书后 → 错误 toast 不落 B 书界面、不进入编辑态', async () => {
    const style = useStyleStore()
    const ui = useUiStore()
    style.bookName = '书A'
    const req = pending<{ content: string; revision: string }>()
    docsMocks.getContentRevisioned.mockReturnValue(req.promise)

    const wrapper = mount(StyleBaselineCard, { props: { bookName: '书A' } })
    await wrapper.find('button.rules-toggle').trigger('click')
    // 读取在途切书：路由已是 B 书 + store 活书名已跟进
    mockRoute.params.name = '书B'
    style.bookName = '书B'
    req.reject(new Error('磁盘错误'))
    await flushPromises()

    expect(ui.toasts).toHaveLength(0) // 修复点：错误 toast 不落 B 书界面
    expect(wrapper.find('textarea.rules-textarea').exists()).toBe(false) // 不进入编辑态
    wrapper.unmount()
  })

  it('铁律读取成功 settle 在切书后 → 旧书内容不回填（编辑态不打开）', async () => {
    const style = useStyleStore()
    style.bookName = '书A'
    const req = pending<{ content: string; revision: string }>()
    docsMocks.getContentRevisioned.mockReturnValue(req.promise)

    const wrapper = mount(StyleBaselineCard, { props: { bookName: '书A' } })
    await wrapper.find('button.rules-toggle').trigger('click')

    mockRoute.params.name = '书B'
    style.bookName = '书B'
    req.resolve({ content: 'A 书铁律', revision: 'rA' })
    await flushPromises()

    expect(wrapper.find('textarea.rules-textarea').exists()).toBe(false) // 修复点：不回填
    wrapper.unmount()
  })

  it('未切书 → 不误伤：铁律正常打开编辑态', async () => {
    const style = useStyleStore()
    style.bookName = '书A'
    docsMocks.getContentRevisioned.mockResolvedValue({ content: '铁律原文', revision: 'r1' })

    const wrapper = mount(StyleBaselineCard, { props: { bookName: '书A' } })
    await wrapper.find('button.rules-toggle').trigger('click')
    await flushPromises()

    expect(wrapper.find('textarea.rules-textarea').exists()).toBe(true)
    expect((wrapper.find('textarea.rules-textarea').element as HTMLTextAreaElement).value).toBe('铁律原文')
    wrapper.unmount()
  })
})