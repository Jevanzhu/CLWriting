// @vitest-environment happy-dom
/**
 * R76-8（二十四轮 F 域）：RewritePanel 交互面直测补齐。
 *
 * 此前 rewrite-panel.test.ts 只锚 R-21 一景（accept() 返回 false 不清指令），面板的
 * 可审性门 / AI 不可达置灰 / 空指令禁用 / 选区透传 / diff 渲染与统计 / 残留结果阻断
 * 再生成 / 切文档清结果（R63-9）全靠 e2e 间接触达。本文件按 AnalysisPanel 直测范式
 * （mock store/api 层，mount 真组件）补齐主交互面。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive, nextTick } from 'vue'

const mocks = vi.hoisted(() => ({
  rewriteState: null as unknown as {
    loading: boolean
    error: string | null
    result: unknown
    run: ReturnType<typeof vi.fn>
    accept: ReturnType<typeof vi.fn>
    reject: ReturnType<typeof vi.fn>
    clear: ReturnType<typeof vi.fn>
  },
}))

vi.mock('../../../src/studio/web-next/src/stores/rewrite', () => ({
  useRewriteStore: vi.fn(() => mocks.rewriteState),
}))
const wsMock = vi.hoisted(() => ({
  state: null as unknown as { activeDocId: string | null; editorGetSelection: (() => string) | undefined },
}))
vi.mock('../../../src/studio/web-next/src/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => wsMock.state),
}))
vi.mock('../../../src/studio/web-next/src/stores/tree', () => ({
  useTreeStore: vi.fn(() => ({ byDocId: new Map([['doc_1', { path: '写作/正文/0001-a.md' }]]) }) ),
}))
const uiMock = vi.hoisted(() => ({ state: null as unknown as { aiAvailable: boolean; toast: ReturnType<typeof vi.fn> } }))
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: vi.fn(() => uiMock.state),
}))
vi.mock('lucide-vue-next', () => new Proxy({}, { get: () => ({ template: '<i/>' }) }))

import RewritePanel from '../../../src/studio/web-next/src/components/panels/RewritePanel.vue'

/** 正文档在树里、activeDocId 指向它（可审）；store 槽位为常规模板 */
function baseStores(): void {
  mocks.rewriteState = reactive({
    loading: false,
    error: null,
    result: null as unknown,
    run: vi.fn(async () => {}),
    accept: vi.fn((): boolean => true),
    reject: vi.fn(),
    clear: vi.fn(),
  })
  wsMock.state = reactive({ activeDocId: 'doc_1', editorGetSelection: undefined })
  uiMock.state = reactive({ aiAvailable: true, toast: vi.fn() })
}

beforeEach(() => {
  setActivePinia(createPinia())
  baseStores()
})

function findBtn(w: ReturnType<typeof mount>, text: string) {
  return w.findAll('button').find((b) => b.text().includes(text))
}

describe('RewritePanel: 可审性门（R76-8）', () => {
  it('无激活文档 → 「改写仅适用于正文 / 草稿文档」提示，不出指令框', async () => {
    wsMock.state.activeDocId = null
    const w = mount(RewritePanel, { props: { bookName: '书A' } })
    await nextTick()
    expect(w.text()).toContain('改写仅适用于正文 / 草稿文档')
    expect(w.find('textarea').exists()).toBe(false)
    w.unmount()
  })

  it('正文文档 → 指令框 + 改写按钮可用面', async () => {
    const w = mount(RewritePanel, { props: { bookName: '书A' } })
    await nextTick()
    expect(w.find('textarea').exists()).toBe(true)
    // 空指令：改写按钮置灰（trim 守卫）
    const btn = findBtn(w, '改写')!
    expect(btn).toBeDefined()
    expect(btn.attributes('disabled')).toBeDefined()
    w.unmount()
  })
})

describe('RewritePanel: AI 不可达置灰（R76-8）', () => {
  it('aiAvailable=false → 指令框置灰 + 提示文案', async () => {
    uiMock.state.aiAvailable = false
    const w = mount(RewritePanel, { props: { bookName: '书A' } })
    await nextTick()
    expect(w.text()).toContain('AI 不可达，改写置灰')
    expect(w.find('textarea').attributes('disabled')).toBeDefined()
    w.unmount()
  })
})

describe('RewritePanel: 改写发起（R76-8）', () => {
  it('有指令点击 → run(bookName, docId, 指令, 选区)——无选区传空串（后端判 whole 模式）', async () => {
    wsMock.state.editorGetSelection = () => ''
    const w = mount(RewritePanel, { props: { bookName: '书A' } })
    await nextTick()
    await w.find('textarea').setValue('让开头更紧张')
    await findBtn(w, '改写')!.trigger('click')
    await flushPromises()
    expect(mocks.rewriteState.run).toHaveBeenCalledWith('书A', 'doc_1', '让开头更紧张', '')
    w.unmount()
  })

  it('编辑器有选区 → 选区文本透传 run 第 4 参（local 模式判定在后端）', async () => {
    wsMock.state.editorGetSelection = () => '选中段落文本'
    const w = mount(RewritePanel, { props: { bookName: '书A' } })
    await nextTick()
    await w.find('textarea').setValue('压缩对话')
    await findBtn(w, '改写')!.trigger('click')
    await flushPromises()
    expect(mocks.rewriteState.run).toHaveBeenCalledWith('书A', 'doc_1', '压缩对话', '选中段落文本')
    w.unmount()
  })

  it('指令纯空白 → 按钮保持置灰（trim 守卫，不发起）', async () => {
    const w = mount(RewritePanel, { props: { bookName: '书A' } })
    await nextTick()
    await w.find('textarea').setValue('   ')
    expect(findBtn(w, '改写')!.attributes('disabled')).toBeDefined()
    w.unmount()
  })
})

describe('RewritePanel: 结果渲染与再生成阻断（R76-8）', () => {
  function withResult(): void {
    mocks.rewriteState.result = {
      mode: 'whole',
      diff: [
        { type: 'same', text: '一行未变' },
        { type: 'del', text: '旧句' },
        { type: 'add', text: '新句' },
        { type: 'add', text: '又一句' },
      ],
    }
  }

  it('result 存在 → 整章标签 + +2/-1 统计 + add/del 行渲染；改写按钮因残留结果置灰', async () => {
    withResult()
    const w = mount(RewritePanel, { props: { bookName: '书A' } })
    await nextTick()
    expect(w.text()).toContain('整章改写')
    expect(w.find('.stat-add').text()).toBe('+2')
    expect(w.find('.stat-del').text()).toBe('-1')
    expect(w.findAll('.diff-add')).toHaveLength(2)
    expect(w.findAll('.diff-del')).toHaveLength(1)
    // 残留 diff 阻断再生成（防旧结果被误接受——R63-9 同族契约的按钮面）
    expect(findBtn(w, '改写')!.attributes('disabled')).toBeDefined()
    w.unmount()
  })

  it('error 态 → 错误文案渲染（不渲染结果区）', async () => {
    mocks.rewriteState.error = '改写失败：AI 网关超时'
    const w = mount(RewritePanel, { props: { bookName: '书A' } })
    await nextTick()
    expect(w.text()).toContain('改写失败：AI 网关超时')
    expect(w.find('.rw-diff').exists()).toBe(false)
    w.unmount()
  })
})

describe('RewritePanel: 接受 / 放弃 / 切文档（R76-8）', () => {
  /** 接受/放弃按钮只在结果区渲染——前置最小 result */
  function withMinimalResult(): void {
    mocks.rewriteState.result = { mode: 'whole', diff: [{ type: 'add', text: '新句' }] }
  }

  it('接受成功（accept→true）→ 指令清空', async () => {
    withMinimalResult()
    mocks.rewriteState.accept = vi.fn((): boolean => true)
    const w = mount(RewritePanel, { props: { bookName: '书A' } })
    await nextTick()
    await w.find('textarea').setValue('让开头更紧张')
    await findBtn(w, '接受')!.trigger('click')
    expect(mocks.rewriteState.accept).toHaveBeenCalledWith('书A', 'doc_1')
    expect((w.find('textarea').element as HTMLTextAreaElement).value).toBe('')
    w.unmount()
  })

  it('放弃 → rewrite.reject 调用（指令保留，重试不重输由 R-21 用例另行锚定）', async () => {
    withMinimalResult()
    const w = mount(RewritePanel, { props: { bookName: '书A' } })
    await nextTick()
    await w.find('textarea').setValue('让开头更紧张')
    await findBtn(w, '放弃')!.trigger('click')
    expect(mocks.rewriteState.reject).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('切文档 → rewrite.clear()（R63-9：残留 diff 不跨文档）', async () => {
    const w = mount(RewritePanel, { props: { bookName: '书A' } })
    await nextTick()
    wsMock.state.activeDocId = 'doc_2'
    await nextTick()
    expect(mocks.rewriteState.clear).toHaveBeenCalledTimes(1)
    w.unmount()
  })
})
