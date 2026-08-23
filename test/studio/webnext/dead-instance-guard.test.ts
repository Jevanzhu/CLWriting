// @vitest-environment happy-dom
/**
 * M-4（第十轮）：keyed 视图死实例书名守卫——StyleAcceptancePanel.onAnalyze 与
 * OnboardView.save / onMounted 三处。
 *
 * 场景：StyleView / OnboardView 在 Book.vue 挂 :key=bookName，切书整树重建，死实例
 * 的 props 冻结在旧书（比 props 恒等、守卫失效），须比路由活书名。此处用可变 route
 * mock 模拟「await 在途时切书」，断言死续体不再写共享 store（style.load / tree.load）
 * 且不落结果、不 toast；顺带覆盖未切书的正常路径（守卫不误伤）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import StyleAcceptancePanel from '../../../src/studio/web-next/src/components/style/StyleAcceptancePanel.vue'
import OnboardView from '../../../src/studio/web-next/src/views/OnboardView.vue'
import OnboardStepPanel from '../../../src/studio/web-next/src/components/onboard/OnboardStepPanel.vue'
import { useStyleStore } from '../../../src/studio/web-next/src/stores/style'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

// 可变路由 mock：route.params.name 即「当前书」，测试中途改值 = 切书。
// 双注册：web-next 组件解析的是自己的 node_modules/vue-router，测试文件解析根路径那份
const mockRoute = vi.hoisted(() => ({ params: { name: '书A' } }))
vi.mock('vue-router', () => ({ useRoute: () => mockRoute }))
vi.mock('../../../src/studio/web-next/node_modules/vue-router', () => ({ useRoute: () => mockRoute }))

const analysisMocks = vi.hoisted(() => ({ runStyleAnalysis: vi.fn() }))
vi.mock('../../../src/studio/web-next/src/api/analysis', () => ({
  runStyleAnalysis: analysisMocks.runStyleAnalysis,
}))

const onboardMocks = vi.hoisted(() => ({ onboardAi: vi.fn(), onboardSave: vi.fn() }))
vi.mock('../../../src/studio/web-next/src/api/onboard', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/studio/web-next/src/api/onboard')>()
  return { ...orig, onboardAi: onboardMocks.onboardAi, onboardSave: onboardMocks.onboardSave }
})

const booksMocks = vi.hoisted(() => ({ getConfig: vi.fn() }))
vi.mock('../../../src/studio/web-next/src/api/books', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/studio/web-next/src/api/books')>()
  return { ...orig, getConfig: booksMocks.getConfig }
})

/** 起一个手动放行的 Promise（模拟在途 AI/IO 请求） */
function pending<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function stylePayload(drift: string): { envelope: { payload: unknown }; styleCandidates: number } {
  return {
    envelope: { payload: { drift, 口癖: [], 重复度评价: '', 建议: [] } },
    styleCandidates: 2,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mockRoute.params.name = '书A'
})

// ── StyleAcceptancePanel.onAnalyze ────────────────────────────────

describe('M-4（第十轮）：StyleAcceptancePanel 分析完成回调死实例守卫', () => {
  it('分析在途切书 → 死实例不落结果、不 style.load(旧书)、不 toast', async () => {
    const style = useStyleStore()
    const loadSpy = vi.spyOn(style, 'load').mockResolvedValue(null)
    const ui = useUiStore()
    const req = pending<{ envelope: { payload: unknown }; styleCandidates: number }>()
    analysisMocks.runStyleAnalysis.mockReturnValue(req.promise)

    const wrapper = mount(StyleAcceptancePanel, { props: { bookName: '书A' } })
    const btn = wrapper.findAll('button').find((b) => b.text().includes('分析'))!
    await btn.trigger('click')
    expect(analysisMocks.runStyleAnalysis).toHaveBeenCalledWith('书A')

    mockRoute.params.name = '书B' // 切书：StyleView :key 重建，本实例成死实例
    req.resolve(stylePayload('A 书的结论'))
    await flushPromises()

    expect(loadSpy).not.toHaveBeenCalled() // 不再把 A 书数据写进共享 store
    expect(wrapper.find('.ai-drift').exists()).toBe(false) // 结果不落死实例 UI
    expect(ui.toasts.length).toBe(0)
  })

  it('未切书 → 守卫不误伤：落结果 + style.load(书A) + toast', async () => {
    const style = useStyleStore()
    const loadSpy = vi.spyOn(style, 'load').mockResolvedValue(null)
    const ui = useUiStore()
    analysisMocks.runStyleAnalysis.mockResolvedValue(stylePayload('A 书的结论'))

    const wrapper = mount(StyleAcceptancePanel, { props: { bookName: '书A' } })
    const btn = wrapper.findAll('button').find((b) => b.text().includes('分析'))!
    await btn.trigger('click')
    await flushPromises()

    expect(loadSpy).toHaveBeenCalledWith('书A')
    expect(wrapper.find('.ai-drift').text()).toContain('A 书的结论')
    expect(ui.toasts.some((t) => t.msg.includes('分析完成'))).toBe(true)
  })

  it('零候选 → 不 style.load（本就无新数据）', async () => {
    const style = useStyleStore()
    const loadSpy = vi.spyOn(style, 'load').mockResolvedValue(null)
    analysisMocks.runStyleAnalysis.mockResolvedValue({ ...stylePayload('x'), styleCandidates: 0 })

    const wrapper = mount(StyleAcceptancePanel, { props: { bookName: '书A' } })
    const btn = wrapper.findAll('button').find((b) => b.text().includes('分析'))!
    await btn.trigger('click')
    await flushPromises()

    expect(loadSpy).not.toHaveBeenCalled()
    expect(wrapper.find('.ai-drift').exists()).toBe(true)
  })
})

// ── OnboardView.save / onMounted ──────────────────────────────────

describe('M-4（第十轮）：OnboardView 死实例守卫', () => {
  it('onMounted：config 在途切书 → 死实例不 tree.load(旧书)', async () => {
    const tree = useTreeStore()
    const loadSpy = vi.spyOn(tree, 'load').mockResolvedValue(undefined)
    const req = pending<{ kind?: string }>()
    booksMocks.getConfig.mockReturnValue(req.promise)

    mount(OnboardView, { props: { bookName: '书A' } })
    mockRoute.params.name = '书B' // config 在途切书
    req.resolve({ kind: 'short' })
    await flushPromises()

    expect(loadSpy).not.toHaveBeenCalled()
  })

  it('save：落盘在途切书 → 死实例不再 tree.load(旧书)、不 toast', async () => {
    const tree = useTreeStore()
    const loadSpy = vi.spyOn(tree, 'load').mockResolvedValue(undefined)
    const ui = useUiStore()
    booksMocks.getConfig.mockResolvedValue({ kind: 'long', leads: { enabled: ['成长线'] } })

    const wrapper = mount(OnboardView, { props: { bookName: '书A' } })
    await flushPromises()
    expect(loadSpy).toHaveBeenCalledWith('书A') // onMounted 正常路径不受守卫影响

    const req = pending<void>()
    onboardMocks.onboardSave.mockReturnValue(req.promise)
    wrapper.findComponent(OnboardStepPanel).vm.$emit('save')
    expect(onboardMocks.onboardSave).toHaveBeenCalledWith('书A', { step: 'synopsis', content: '' })

    mockRoute.params.name = '书B' // 落盘在途切书
    req.resolve()
    await flushPromises()

    expect(loadSpy).toHaveBeenCalledTimes(1) // 不新增 tree.load(书A)
    expect(ui.toasts.some((t) => t.msg === '已保存')).toBe(false)
  })

  it('save：未切书 → 守卫不误伤：tree.load(书A) + 已保存 toast', async () => {
    const tree = useTreeStore()
    const loadSpy = vi.spyOn(tree, 'load').mockResolvedValue(undefined)
    const ui = useUiStore()
    booksMocks.getConfig.mockResolvedValue({ kind: 'long' })

    const wrapper = mount(OnboardView, { props: { bookName: '书A' } })
    await flushPromises()

    onboardMocks.onboardSave.mockResolvedValue(undefined)
    wrapper.findComponent(OnboardStepPanel).vm.$emit('save')
    await flushPromises()

    expect(loadSpy).toHaveBeenCalledTimes(2) // onMounted 1 次 + save 后 1 次
    expect(loadSpy).toHaveBeenLastCalledWith('书A')
    expect(ui.toasts.some((t) => t.msg === '已保存')).toBe(true)
  })

  // ── X-27：gen() 对齐 stillOn 模式 ──

  it('gen：生成在途切书 → 死实例不 toast（成功/失败路径均守卫）', async () => {
    const ui = useUiStore()
    booksMocks.getConfig.mockResolvedValue({ kind: 'long' })
    const tree = useTreeStore()
    vi.spyOn(tree, 'load').mockResolvedValue(undefined)

    const wrapper = mount(OnboardView, { props: { bookName: '书A' } })
    await flushPromises()

    // 成功路径：切书后迟到结果不 toast
    const req = pending<{ content: string; words: number }>()
    onboardMocks.onboardAi.mockReturnValue(req.promise)
    wrapper.findComponent(OnboardStepPanel).vm.$emit('gen')
    expect(onboardMocks.onboardAi).toHaveBeenCalledWith('书A', { step: 'synopsis', premise: '' })

    mockRoute.params.name = '书B' // 生成在途切书
    req.resolve({ content: 'A 书的梗概', words: 100 })
    await flushPromises()
    expect(ui.toasts.some((t) => t.msg.includes('生成'))).toBe(false)

    // 失败路径：切书后迟到错误同样不 toast（pending 助手只有 resolve，这里需 reject）
    let rejectErr!: (e: Error) => void
    onboardMocks.onboardAi.mockReturnValueOnce(
      new Promise<never>((_, rej) => {
        rejectErr = rej
      }),
    )
    wrapper.findComponent(OnboardStepPanel).vm.$emit('gen')
    mockRoute.params.name = '书C'
    rejectErr(new Error('AI 超时'))
    await flushPromises()
    expect(ui.toasts.length).toBe(0)
  })

  it('gen：未切书 → 守卫不误伤：结果落面板 + 生成 toast', async () => {
    const ui = useUiStore()
    booksMocks.getConfig.mockResolvedValue({ kind: 'long' })
    const tree = useTreeStore()
    vi.spyOn(tree, 'load').mockResolvedValue(undefined)

    const wrapper = mount(OnboardView, { props: { bookName: '书A' } })
    await flushPromises()

    onboardMocks.onboardAi.mockResolvedValue({ content: '梗概内容', words: 88 })
    wrapper.findComponent(OnboardStepPanel).vm.$emit('gen')
    await flushPromises()

    expect(ui.toasts.some((t) => t.msg.includes('生成（88 字）'))).toBe(true)
  })
})
