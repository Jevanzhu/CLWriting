// @vitest-environment happy-dom
/**
 * 文风组件切书守卫行为族——按行为合并两散落文件
 * （原 r28-style-armed-guard + r36-22-style-await-guard，装置同构：可变 route mock
 * 双注册 + 真 style/ui store + spy 动作 + 手动 pending）。
 *
 * - R28-25（二十八轮）：style 组件 armed 守卫——书名复检读 style.bookName 依赖
 *   store.load 入口同步置位，而路由变更 → StyleView :key 重建 → 子组件 setup →
 *   onMounted 才 load 之间存在一个渲染 tick 窗口：窗口内 store.bookName 仍滞留旧书，
 *   死实例在途动作恰在该窗口 settle 时「bookName 匹配」放行，A 书 toast 落 B 书界面。
 *   修法：armed 以路由活书名为代次源即时判定（等价代次比对），守卫改「armed && bookName
 *   匹配」。覆盖 StyleCandidateBox（收割/确认收录）与 StyleBaselineCard（onFreeze/
 *   saveRules）。
 * - R36-22（三十六轮）：StyleEntryPanel / StyleBaselineCard await 后 toast/状态更新无
 *   书名复检，切书错位（同域 StyleCandidateBox 已设防，本批补齐漏点）。
 *   StyleEntryPanel.submitAdd：入库在途切书后，成功 toast/表单复位不得落 B 书界面
 *   （catch 的错误 toast 同样）；onRemove await 后补复检。复检走共享 style store 活书名
 *   （StyleView :key 重建后死实例的 store 引用仍活着，store.bookName 已是新书——与
 *   FE-3/R26-73 同域口径）。StyleBaselineCard.toggleRulesEdit：铁律读取在途切书后，
 *   旧书内容不得回填表单、失败 toast 不落 B 书界面（armed+bookName 双门）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import StyleCandidateBox from '../../../src/studio/web-next/src/components/style/StyleCandidateBox.vue'
import StyleBaselineCard from '../../../src/studio/web-next/src/components/style/StyleBaselineCard.vue'
import StyleEntryPanel from '../../../src/studio/web-next/src/components/style/StyleEntryPanel.vue'
import { useStyleStore } from '../../../src/studio/web-next/src/stores/style'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import type { StyleCandidateFE, StyleConfigFE, StyleEntryFE } from '../../../src/studio/web-next/src/api/style'

// 可变路由 mock（双注册：web-next 组件解析自己的 node_modules/vue-router，对齐
// dead-instance-guard.test.ts 惯例）。mockRoute.params.name = 当前书；测试中途改值 = 切书
const mockRoute = vi.hoisted(() => ({ params: { name: '书A' } }))
vi.mock('vue-router', () => ({ useRoute: () => mockRoute }))
vi.mock('../../../src/studio/web-next/node_modules/vue-router', () => ({ useRoute: () => mockRoute }))

// StyleBaselineCard 的铁律读写 mock（store 动作走 spy，无需 mock api/style 本体）
const docsMocks = vi.hoisted(() => ({ getContentPayload: vi.fn(), putContent: vi.fn() }))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContentPayload: docsMocks.getContentPayload,
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

function entry(path: string): StyleEntryFE {
  return { _path: path, 类型: '样章', 场景: '', 说明: '', 正文: '样章正文', 来源: '作者标注' }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mockRoute.params.name = '书A'
})

// ── R28-25：StyleCandidateBox 窗口期动作吞掉（armed 门） ────────────────────────

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

// ── R28-25：StyleBaselineCard onFreeze / saveRules ───────────────────────

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
    docsMocks.getContentPayload.mockResolvedValue({ content: '铁律原文', revision: 'r1' })
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
    docsMocks.getContentPayload.mockResolvedValue({ content: '铁律原文', revision: 'r1' })
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
    docsMocks.getContentPayload.mockResolvedValue({ content: '铁律原文', revision: 'r1' })
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

// ── R36-22：StyleEntryPanel 入库/删除 await 后书名复检 ─────────────────

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

  it('七轮重评-5: 删除确认预览按码位截断——增补平面字符在第 24 码元边界不劈半', async () => {
    const style = useStyleStore()
    const ui = useUiStore()
    style.bookName = '书A'
    // 23 个 BMP 字符 + 𠮷（两码元）+ 尾字：旧 slice(0,24) 劈出孤立高代理且「…」判据差一
    const text = '甲'.repeat(23) + '𠮷' + '乙'
    style.entries = [{ _path: '样章/zzz.md', 类型: '样章', 场景: '', 说明: '', 正文: text, 来源: '作者标注' }]
    let askedMessage = ''
    vi.spyOn(ui, 'ask').mockImplementation(async (q) => {
      askedMessage = (q as { message: string }).message
      return false // 取消删除，聚焦弹窗文案断言
    })

    const wrapper = mount(StyleEntryPanel)
    await flushPromises()
    await wrapper.find('.entry-card .ec-del').trigger('click')
    await flushPromises()

    expect(askedMessage).toContain('𠮷')
    for (let i = 0; i < askedMessage.length; i++) {
      const c = askedMessage.charCodeAt(i)
      if (c >= 0xd800 && c <= 0xdbff) {
        const d = i + 1 < askedMessage.length ? askedMessage.charCodeAt(i + 1) : 0
        expect(d >= 0xdc00 && d <= 0xdfff).toBe(true)
      }
    }
    wrapper.unmount()
  })
})

// ── R36-22：StyleBaselineCard toggleRulesEdit await 后 armed+bookName 双门 ──

describe('R36-22：StyleBaselineCard toggleRulesEdit 在途切书守卫', () => {
  it('铁律读取失败 settle 在切书后 → 错误 toast 不落 B 书界面、不进入编辑态', async () => {
    const style = useStyleStore()
    const ui = useUiStore()
    style.bookName = '书A'
    const req = pending<{ content: string; revision: string }>()
    docsMocks.getContentPayload.mockReturnValue(req.promise)

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
    docsMocks.getContentPayload.mockReturnValue(req.promise)

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
    docsMocks.getContentPayload.mockResolvedValue({ content: '铁律原文', revision: 'r1' })

    const wrapper = mount(StyleBaselineCard, { props: { bookName: '书A' } })
    await wrapper.find('button.rules-toggle').trigger('click')
    await flushPromises()

    expect(wrapper.find('textarea.rules-textarea').exists()).toBe(true)
    expect((wrapper.find('textarea.rules-textarea').element as HTMLTextAreaElement).value).toBe('铁律原文')
    wrapper.unmount()
  })
})
