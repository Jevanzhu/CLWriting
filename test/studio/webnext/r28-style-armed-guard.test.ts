// @vitest-environment happy-dom
/**
 * R28-25（二十八轮）：style 组件 armed 守卫——书名复检读 style.bookName 依赖 store.load
 * 入口同步置位，而路由变更 → StyleView :key 重建 → 子组件 setup → onMounted 才 load
 * 之间存在一个渲染 tick 窗口：窗口内 store.bookName 仍滞留旧书，死实例在途动作恰在该
 * 窗口 settle 时「bookName 匹配」放行，A 书 toast 落 B 书界面。
 *
 * 修法：armed 以路由活书名为代次源即时判定（等价代次比对），守卫改「armed && bookName
 * 匹配」。测试用可变 route mock 复现窗口：settle 时路由已是 B 书、store.bookName 仍是
 * A 书（load 尚未跑）——修复前该场景 toast 泄漏，修复后直接吞掉；未切书路径不误伤。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import StyleCandidateBox from '../../../src/studio/web-next/src/components/style/StyleCandidateBox.vue'
import StyleBaselineCard from '../../../src/studio/web-next/src/components/style/StyleBaselineCard.vue'
import { useStyleStore } from '../../../src/studio/web-next/src/stores/style'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import type { StyleCandidateFE, StyleConfigFE } from '../../../src/studio/web-next/src/api/style'

// 可变路由 mock（双注册：web-next 组件解析自己的 node_modules/vue-router，对齐
// dead-instance-guard.test.ts 惯例）。mockRoute.params.name = 当前书；测试中途改值 = 切书
const mockRoute = vi.hoisted(() => ({ params: { name: '书A' } }))
vi.mock('vue-router', () => ({ useRoute: () => mockRoute }))
vi.mock('../../../src/studio/web-next/node_modules/vue-router', () => ({ useRoute: () => mockRoute }))

// StyleBaselineCard 的铁律读写 mock（store 动作走 spy，无需 mock api/style 本体）
const docsMocks = vi.hoisted(() => ({ getContentRevisioned: vi.fn(), putContent: vi.fn() }))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContentRevisioned: docsMocks.getContentRevisioned,
  putContent: docsMocks.putContent,
}))

/** 手动放行 / 拒绝的 Promise（模拟在途请求） */
function pending<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function candidate(path: string): StyleCandidateFE {
  return {
    _path: path,
    状态: '待确认',
    类型: '禁词',
    场景: '测试场景',
    来源: '收割',
    说明: '测试说明',
    正文: '测试正文',
    创建: '2026-08-30T00:00:00Z',
  }
}

function configWithBaseline(): StyleConfigFE {
  return {
    rules: {},
    baseline: { frozenAt: '2026-08-01T00:00:00Z', scenes: [] },
    injection: 'light',
  } as unknown as StyleConfigFE
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mockRoute.params.name = '书A'
})

// ── StyleCandidateBox：收割 / 确认收录 ────────────────────────────

describe('R28-25：StyleCandidateBox 窗口期动作吞掉（armed 门）', () => {
  it('收割 settle 恰在窗口（路由已切 B、store.bookName 滞留 A）→ 结果不 toast', async () => {
    const style = useStyleStore()
    const ui = useUiStore()
    style.bookName = '书A'
    const req = pending<{ created: number; skipped: number }>()
    vi.spyOn(style, 'harvest').mockReturnValue(req.promise)

    const wrapper = mount(StyleCandidateBox)
    await wrapper.findAll('button').find((b) => b.text().includes('收割'))!.trigger('click')

    // 复现窗口：路由切书瞬间 store.bookName 尚未跟进（StyleView 重建 → onMounted 才 load）
    mockRoute.params.name = '书B'
    req.resolve({ created: 3, skipped: 0 })
    await flushPromises()

    expect(ui.toasts).toHaveLength(0) // 修复点：armed 门拦下窗口期放行
    wrapper.unmount()
  })

  it('收割失败 settle 在窗口 → 错误同样不 toast', async () => {
    const style = useStyleStore()
    const ui = useUiStore()
    style.bookName = '书A'
    const req = pending<{ created: number; skipped: number }>()
    vi.spyOn(style, 'harvest').mockReturnValue(req.promise)

    const wrapper = mount(StyleCandidateBox)
    await wrapper.findAll('button').find((b) => b.text().includes('收割'))!.trigger('click')
    mockRoute.params.name = '书B'
    req.reject(new Error('收割失败'))
    await flushPromises()

    expect(ui.toasts).toHaveLength(0)
    wrapper.unmount()
  })

  it('确认收录 settle 在窗口 → 成功不 toast；窗口后 store 跟进（load 完成）同样拦下', async () => {
    const style = useStyleStore()
    const ui = useUiStore()
    style.bookName = '书A'
    style.candidates = [candidate('禁词/xxx.md')]
    const req = pending<void>()
    vi.spyOn(style, 'confirm').mockReturnValue(req.promise)

    const wrapper = mount(StyleCandidateBox)
    const btn = wrapper.findAll('button').find((b) => b.text().includes('确认收录'))!
    await btn.trigger('click')

    mockRoute.params.name = '书B' // 窗口：store 滞留
    req.resolve()
    await flushPromises()
    expect(ui.toasts).toHaveLength(0)
    wrapper.unmount()
  })

  it('未切书 → 守卫不误伤：收割 / 确认结果照常 toast', async () => {
    const style = useStyleStore()
    const ui = useUiStore()
    style.bookName = '书A'
    vi.spyOn(style, 'harvest').mockResolvedValue({ created: 2, skipped: 1 })
    style.candidates = [candidate('禁词/yyy.md')]
    vi.spyOn(style, 'confirm').mockResolvedValue(undefined)

    const wrapper = mount(StyleCandidateBox)
    await wrapper.findAll('button').find((b) => b.text().includes('收割'))!.trigger('click')
    await flushPromises()
    expect(ui.toasts.some((t) => t.msg.includes('收割完成'))).toBe(true)

    await wrapper.findAll('button').find((b) => b.text().includes('确认收录'))!.trigger('click')
    await flushPromises()
    expect(ui.toasts.some((t) => t.msg.includes('已收录'))).toBe(true)
    wrapper.unmount()
  })
})

// ── StyleBaselineCard：onFreeze / saveRules ───────────────────────

describe('R28-25：StyleBaselineCard 窗口期动作吞掉（armed 门）', () => {
  it('基准确认弹窗滞留期间切书（窗口）→ 确认后 armed 门拦下，freeze 不发起', async () => {
    const style = useStyleStore()
    const ui = useUiStore()
    style.bookName = '书A'
    style.config = configWithBaseline()
    const freezeSpy = vi.spyOn(style, 'freeze').mockResolvedValue(undefined)
    const askReq = pending<boolean>()
    vi.spyOn(ui, 'ask').mockReturnValue(askReq.promise)

    const wrapper = mount(StyleBaselineCard, { props: { bookName: '书A' } })
    await wrapper.findAll('button').find((b) => b.text().includes('重新建立'))!.trigger('click')

    mockRoute.params.name = '书B' // 弹窗滞留期间切书（store 滞留 A）
    askReq.resolve(true)
    await flushPromises()

    expect(freezeSpy).not.toHaveBeenCalled() // 修复点：弹窗确认后的 armed 门拦下
    expect(ui.toasts).toHaveLength(0)
    wrapper.unmount()
  })

  it('freeze 在途 settle 在窗口 → 成功不 toast', async () => {
    const style = useStyleStore()
    const ui = useUiStore()
    style.bookName = '书A'
    style.config = configWithBaseline()
    const req = pending<void>()
    vi.spyOn(style, 'freeze').mockReturnValue(req.promise)
    vi.spyOn(ui, 'ask').mockResolvedValue(true)

    const wrapper = mount(StyleBaselineCard, { props: { bookName: '书A' } })
    await wrapper.findAll('button').find((b) => b.text().includes('重新建立'))!.trigger('click')
    await flushPromises() // ask 已过、freeze 在途

    mockRoute.params.name = '书B'
    req.resolve(undefined)
    await flushPromises()

    expect(ui.toasts).toHaveLength(0)
    wrapper.unmount()
  })

  it('saveRules settle 在窗口 → 成功 toast 被吞、不 style.load(旧书)', async () => {
    const style = useStyleStore()
    const ui = useUiStore()
    style.bookName = '书A'
    const loadSpy = vi.spyOn(style, 'load').mockResolvedValue(null)
    docsMocks.getContentRevisioned.mockResolvedValue({ content: '铁律原文', revision: 'r1' })
    const putReq = pending<{ revision: string }>()
    docsMocks.putContent.mockReturnValue(putReq.promise)

    const wrapper = mount(StyleBaselineCard, { props: { bookName: '书A' } })
    await wrapper.find('button.rules-toggle').trigger('click') // 展开铁律编辑
    await flushPromises()
    await wrapper.find('textarea.rules-textarea').setValue('新的铁律') // 置脏
    await wrapper.findAll('button').find((b) => b.text().includes('保存'))!.trigger('click')
    expect(docsMocks.putContent).toHaveBeenCalledWith('书A', '文风/文风铁律.md', '新的铁律', 'r1')

    mockRoute.params.name = '书B' // 保存 settle 恰在窗口
    putReq.resolve({ revision: 'r2' })
    await flushPromises()

    expect(ui.toasts).toHaveLength(0) // 修复点：成功提示不落 B 书界面
    expect(loadSpy).not.toHaveBeenCalled() // 不把 A 书定标数据重拉进共享 store
    wrapper.unmount()
  })

  it('saveRules 失败 settle 在窗口 → 错误不 toast', async () => {
    const style = useStyleStore()
    const ui = useUiStore()
    style.bookName = '书A'
    docsMocks.getContentRevisioned.mockResolvedValue({ content: '铁律原文', revision: 'r1' })
    const putReq = pending<{ revision: string }>()
    docsMocks.putContent.mockReturnValue(putReq.promise)

    const wrapper = mount(StyleBaselineCard, { props: { bookName: '书A' } })
    await wrapper.find('button.rules-toggle').trigger('click')
    await flushPromises()
    await wrapper.find('textarea.rules-textarea').setValue('新的铁律')
    await wrapper.findAll('button').find((b) => b.text().includes('保存'))!.trigger('click')

    mockRoute.params.name = '书B'
    putReq.reject(new Error('磁盘满'))
    await flushPromises()

    expect(ui.toasts).toHaveLength(0)
    wrapper.unmount()
  })

  it('未切书 → 不误伤：铁律保存 toast + style.load(书A)；建基准 toast', async () => {
    const style = useStyleStore()
    const ui = useUiStore()
    style.bookName = '书A'
    const loadSpy = vi.spyOn(style, 'load').mockResolvedValue(null)
    docsMocks.getContentRevisioned.mockResolvedValue({ content: '铁律原文', revision: 'r1' })
    docsMocks.putContent.mockResolvedValue({ revision: 'r2' })
    vi.spyOn(ui, 'ask').mockResolvedValue(true)

    const wrapper = mount(StyleBaselineCard, { props: { bookName: '书A' } })
    await wrapper.find('button.rules-toggle').trigger('click')
    await flushPromises()
    await wrapper.find('textarea.rules-textarea').setValue('新的铁律')
    await wrapper.findAll('button').find((b) => b.text().includes('保存'))!.trigger('click')
    await flushPromises()
    expect(ui.toasts.some((t) => t.msg.includes('文风铁律已保存'))).toBe(true)
    expect(loadSpy).toHaveBeenCalledWith('书A')

    // 建基准正常路径（窗口外）
    style.config = configWithBaseline()
    await flushPromises() // 等 baseline 出现（重新建立按钮可用）
    vi.spyOn(style, 'freeze').mockResolvedValue(undefined)
    await wrapper.findAll('button').find((b) => b.text().includes('重新建立'))!.trigger('click')
    await flushPromises()
    expect(ui.toasts.some((t) => t.msg.includes('文风基准已建立'))).toBe(true)
    wrapper.unmount()
  })
})
