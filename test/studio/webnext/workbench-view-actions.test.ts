// @vitest-environment happy-dom
/**
 * R76-8（二十四轮 F 域）：WorkbenchView 生成类动作直测。
 *
 * 与既有零散用例的分工：f4-textout-incomplete 已锚水印兜底拦截、workbench-draft-saved
 * 已锚存草稿成功链、usage-card 已锚用量卡——本文件补齐其余主交互面：生成语境拼接
 * （P0-3）、本地在途锁（R69-29）、书名入口捕获（FE-9/R70-10）、无正文守卫、
 * 收工状态卡刷新、AI 不可达置灰。卡片子组件按 f4 先例 stub（内部行为各有直测）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  spawnRole: vi.fn(),
  interrupt: vi.fn(),
  saveDraft: vi.fn(),
  autoWrite: vi.fn(),
  getDraftPrompt: vi.fn(),
  generateOutline: vi.fn(),
  generateLeadUpdates: vi.fn(),
  acknowledgeJournalPending: vi.fn(),
  getConfig: vi.fn(),
  getTraceStats: vi.fn(),
  getCostStats: vi.fn(),
  getProviders: vi.fn(),
  uiToast: vi.fn(),
  // aiAvailable 可变槽位：AI 不可达用例置 false 后再挂载（mock 工厂每次调用取现值）
  uiState: { aiAvailable: true },
}))

vi.mock('../../../src/studio/web-next/src/api/stream', () => ({
  getState: mocks.getState,
  spawnRole: mocks.spawnRole,
  interrupt: mocks.interrupt,
  saveDraft: mocks.saveDraft,
  autoWrite: mocks.autoWrite,
  getDraftPrompt: mocks.getDraftPrompt,
  generateOutline: mocks.generateOutline,
  generateLeadUpdates: mocks.generateLeadUpdates,
  // R0912-FE-P2-3：崩溃 pending 忽略通道封装（WorkbenchView 父层接线直测）
  acknowledgeJournalPending: mocks.acknowledgeJournalPending,
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
}))
vi.mock('../../../src/studio/web-next/src/api/trace-stats', () => ({
  getTraceStats: mocks.getTraceStats,
}))
vi.mock('../../../src/studio/web-next/src/api/cost-stats', () => ({
  getCostStats: mocks.getCostStats,
}))
vi.mock('../../../src/studio/web-next/src/api/providers', () => ({
  getProviders: mocks.getProviders,
}))
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: vi.fn(() => ({ toast: mocks.uiToast, aiAvailable: mocks.uiState.aiAvailable })),
}))
vi.mock('lucide-vue-next', () => new Proxy({}, { get: () => ({ template: '<i/>' }) }))

import WorkbenchView from '../../../src/studio/web-next/src/views/WorkbenchView.vue'
import WbDraftCard from '../../../src/studio/web-next/src/components/workbench/WbDraftCard.vue'
import WbStateCard from '../../../src/studio/web-next/src/components/workbench/WbStateCard.vue'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'

function primeLoadApis(): void {
  mocks.getState.mockResolvedValue({
    identity: { kind: 'long', name: '书A', title: '', genre: '', created_at: '', wordsTarget: null },
    progress: { chapters: 1, words: 100, percent: 1, targetWords: null },
    nextChapter: 2,
    timeline: [],
    streak: 1,
  })
  mocks.getTraceStats.mockResolvedValue({ ruleHits: [], byTask: [] })
  mocks.getCostStats.mockResolvedValue({ today: { calls: 0, cost: 0 }, recent: [] })
  mocks.getProviders.mockResolvedValue({ providers: [], tiers: null, currentModel: null })
  mocks.getDraftPrompt.mockResolvedValue({ prompt: '细纲语境', files: ['工作区/细纲.md'] })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.uiState.aiAvailable = true
  primeLoadApis()
})

async function mountView(bookName = '书A'): Promise<ReturnType<typeof mount>> {
  const w = mount(WorkbenchView, {
    props: { bookName },
    global: {
      // f4 先例：卡片子组件 stub（各自有直测），只留 WorkbenchView 自身动作面
      stubs: { ChatPanel: true, WbStateCard: true, WbAdvanced: true, WbHealCard: true, WbUsageCard: true },
    },
  })
  await flushPromises()
  return w
}

function findBtn(w: ReturnType<typeof mount>, text: string) {
  return w.findAll('button').find((b) => b.text().includes(text))
}

describe('WorkbenchView: 生成动作（R76-8）', () => {
  it('点击生成 → 先拉写稿上下文再拼作者补充要求（P0-3 语境拼接面）', async () => {
    const w = await mountView()
    await w.find('.prompt-input').setValue('写得更燃')
    await findBtn(w, '生成')!.trigger('click')
    await flushPromises()
    expect(mocks.getDraftPrompt).toHaveBeenCalledWith('书A', 2)
    expect(mocks.spawnRole).toHaveBeenCalledTimes(1)
    const call = mocks.spawnRole.mock.calls[0]!
    expect(call[0]).toBe('书A')
    expect(call[1].prompt).toContain('细纲语境')
    expect(call[1].prompt).toContain('## 作者补充要求')
    expect(call[1].prompt).toContain('写得更燃')
    // Q-5：注入源清单随 prompt 回传（可见⟺已记录）
    expect(call[1].files).toEqual(['工作区/细纲.md'])
    expect(mocks.uiToast).toHaveBeenCalledWith('已开始生成', 'info')
    w.unmount()
  })

  it('生成在途（getDraftPrompt 慢回流）→ Enter 通道同被在途锁挡（R69-29）', async () => {
    let resolvePrompt!: (v: { prompt: string }) => void
    mocks.getDraftPrompt.mockImplementationOnce(() => new Promise((r) => { resolvePrompt = r }))
    const w = await mountView()
    await w.find('.prompt-input').setValue('x')
    const click = findBtn(w, '生成')!.trigger('click')
    await nextTick()
    // 在途窗口：按钮已换「中断」，Enter 不得重复发起
    await w.find('.prompt-input').trigger('keydown', { key: 'Enter' })
    resolvePrompt({ prompt: 'ctx' })
    await click
    await flushPromises()
    expect(mocks.getDraftPrompt).toHaveBeenCalledTimes(1)
    expect(mocks.spawnRole).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('拉上下文期间切书 → spawnRole 不发、toast 不落 B 书界面（FE-9/R70-10）', async () => {
    let resolvePrompt!: (v: { prompt: string }) => void
    mocks.getDraftPrompt.mockImplementationOnce(() => new Promise((r) => { resolvePrompt = r }))
    const w = await mountView()
    await w.find('.prompt-input').setValue('x')
    const click = findBtn(w, '生成')!.trigger('click')
    await nextTick()
    await w.setProps({ bookName: '书B' }) // await 期间切书
    resolvePrompt({ prompt: 'ctx' })
    await click
    await flushPromises()
    expect(mocks.spawnRole).not.toHaveBeenCalled()
    expect(mocks.uiToast).not.toHaveBeenCalled()
    w.unmount()
  })
})

describe('WorkbenchView: 存草稿守卫（R76-8）', () => {
  it('无正文 → 「无正文可存」toast，saveDraft API 不发（按钮禁用外的兜底面）', async () => {
    const w = await mountView()
    // 按钮已禁（!textOut.trim()），直发 save 事件模拟键盘/未来入口（f4 同款手法）
    w.findComponent(WbDraftCard).vm.$emit('save')
    await flushPromises()
    expect(mocks.uiToast).toHaveBeenCalledWith('无正文可存', 'error')
    expect(mocks.saveDraft).not.toHaveBeenCalled()
    w.unmount()
  })
})

describe('WorkbenchView: 生成收工状态卡刷新（R76-8）', () => {
  it('wb.running true→false 跳变 → getState 重拉（收工后 nextChapter 前进可见）', async () => {
    const wb = useWorkbenchStore()
    const w = await mountView()
    const callsBefore = mocks.getState.mock.calls.length
    wb.running = true
    await nextTick()
    wb.running = false
    await flushPromises()
    expect(mocks.getState.mock.calls.length).toBeGreaterThan(callsBefore)
    w.unmount()
  })
})

describe('WorkbenchView: AI 不可达置灰（R76-8）', () => {
  it('aiAvailable=false → 置灰提示渲染且生成按钮禁用', async () => {
    mocks.uiState.aiAvailable = false
    const w = await mountView()
    expect(w.text()).toContain('AI 服务暂不可用')
    expect(findBtn(w, '生成')!.attributes('disabled')).toBeDefined()
    w.unmount()
  })
})

// ── R0912-FE-P2-3（2026-09-11 重评-0911b 修复批）：崩溃 pending「忽略此提醒」父层接线 ──
describe('WorkbenchView: 崩溃 pending 忽略通道（R0912-FE-P2-3）', () => {
  const crashedState = {
    state: 1,
    stateName: '体检异常',
    humanMsg: '进门体检发现问题，先处理再开写：\n· 上次写作时「正文/第1章.md」的保存没完成，可能丢字。（…）',
    action: '',
    crashedPendingOpIds: ['op-1', 'op-2'],
  }

  it('WbStateCard ack 事件 → 逐个 acknowledge + 成功 toast + 刷新状态卡', async () => {
    mocks.getState.mockResolvedValue(crashedState)
    mocks.acknowledgeJournalPending.mockResolvedValue({ ok: true, acknowledged: true })
    const w = await mountView()
    const stateCallsBefore = mocks.getState.mock.calls.length
    w.findComponent(WbStateCard).vm.$emit('acknowledge')
    await flushPromises()
    expect(mocks.acknowledgeJournalPending).toHaveBeenCalledTimes(2)
    expect(mocks.acknowledgeJournalPending).toHaveBeenNthCalledWith(1, '书A', 'op-1')
    expect(mocks.acknowledgeJournalPending).toHaveBeenNthCalledWith(2, '书A', 'op-2')
    expect(mocks.uiToast).toHaveBeenCalledWith('已忽略崩溃恢复提醒，进门体检不再报该条', 'success')
    expect(mocks.getState.mock.calls.length).toBeGreaterThan(stateCallsBefore) // 成功后刷新
    w.unmount()
  })

  it('幂等 acknowledged:false（提醒已失效）→ toast 失效口径', async () => {
    mocks.getState.mockResolvedValue(crashedState)
    mocks.acknowledgeJournalPending.mockResolvedValue({ ok: true, acknowledged: false })
    const w = await mountView()
    w.findComponent(WbStateCard).vm.$emit('acknowledge')
    await flushPromises()
    expect(mocks.uiToast).toHaveBeenCalledWith('该提醒已失效或已确认', 'success')
    w.unmount()
  })

  it('acknowledge 失败 → error toast（friendlyError 面）', async () => {
    mocks.getState.mockResolvedValue(crashedState)
    mocks.acknowledgeJournalPending.mockRejectedValue(new Error('网络不可达'))
    const w = await mountView()
    w.findComponent(WbStateCard).vm.$emit('acknowledge')
    await flushPromises()
    expect(mocks.uiToast).toHaveBeenCalledWith('网络不可达', 'error')
    w.unmount()
  })

  it('无 opId（服务端未透出/已清账）→ ack 事件空转，不发请求', async () => {
    const w = await mountView() // primeLoadApis 的 getState 无 crashedPendingOpIds
    w.findComponent(WbStateCard).vm.$emit('acknowledge')
    await flushPromises()
    expect(mocks.acknowledgeJournalPending).not.toHaveBeenCalled()
    w.unmount()
  })

  it('acknowledge 在途切书 → 迟到结果不落 B 书（R70-10 家族守卫）', async () => {
    mocks.getState.mockResolvedValue(crashedState)
    let resolveAck!: (v: { ok: true; acknowledged: boolean }) => void
    mocks.acknowledgeJournalPending.mockImplementationOnce(
      () => new Promise((r) => (resolveAck = r)),
    )
    const w = await mountView()
    w.findComponent(WbStateCard).vm.$emit('acknowledge')
    await nextTick()
    await w.setProps({ bookName: '书B' }) // 在途切书
    resolveAck({ ok: true, acknowledged: true })
    await flushPromises()
    expect(mocks.acknowledgeJournalPending).toHaveBeenCalledTimes(1) // 不再打第二个 opId
    expect(mocks.uiToast).not.toHaveBeenCalled()
    w.unmount()
  })
})

// ── R0912-FE-P3-7（2026-09-11 重评-0911b 修复批）：pending 文案死代码复活 ──
describe('WorkbenchView: pending 文案可达（R0912-FE-P3-7）', () => {
  it('autoWrite 在途 → 「写章启动中…」可达且按钮禁用（原 v-if="!genBusy" 期整体消失）', async () => {
    // onAutoWrite 先 await getConfig 读批量档位——本文件未全局打桩，此处补（缺桩会
    // 在读 cfg.auto 时抛错进 catch，autoPending 复位、按钮文案回到常態）
    mocks.getConfig.mockResolvedValue({ auto: { batch_size: 1 } })
    let resolveAuto!: (v: unknown) => void
    mocks.autoWrite.mockImplementationOnce(() => new Promise((r) => (resolveAuto = r)))
    const w = await mountView()
    await findBtn(w, '全自动写章')!.trigger('click')
    await nextTick()
    const pendingBtn = findBtn(w, '写章启动中…')
    expect(pendingBtn).toBeDefined() // 文案可达（原死代码）
    expect(pendingBtn!.attributes('disabled')).toBeDefined()
    resolveAuto({ ok: true, chapter: 2, batchSize: 1 })
    await flushPromises()
    expect(findBtn(w, '全自动写章')).toBeDefined() // 收尾复原
    w.unmount()
  })

  it('wb.running 生成中 → 账本推进/全自动写章钮保持渲染且禁用（不再整体消失）', async () => {
    const wb = useWorkbenchStore()
    const w = await mountView()
    wb.running = true
    await nextTick()
    expect(findBtn(w, '生成账本推进')!.attributes('disabled')).toBeDefined()
    expect(findBtn(w, '全自动写章')!.attributes('disabled')).toBeDefined()
    w.unmount()
  })

  it('leadUpdates 在途 → 「推进草拟中…」可达且按钮禁用', async () => {
    let resolveLead!: (v: unknown) => void
    mocks.generateLeadUpdates.mockImplementationOnce(() => new Promise((r) => (resolveLead = r)))
    const w = await mountView()
    await findBtn(w, '生成账本推进')!.trigger('click')
    await nextTick()
    const pendingBtn = findBtn(w, '推进草拟中…')
    expect(pendingBtn).toBeDefined()
    expect(pendingBtn!.attributes('disabled')).toBeDefined()
    resolveLead({ ok: true, count: 0 })
    await flushPromises()
    expect(findBtn(w, '生成账本推进')).toBeDefined()
    w.unmount()
  })
})
