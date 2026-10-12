/**
 * R76-8（二十四轮 F 域）：WorkbenchView 生成类动作直测。
 *
 * 与既有零散用例的分工：workbench-incomplete-watermark 已锚水印兜底拦截、workbench-draft-saved
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
  uiState: { aiAvailable: true, aiReasonText: '原因未知' },
}))

vi.mock('../../../../src/studio/web-next/src/api/workbench', () => ({
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
vi.mock('../../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
}))
vi.mock('../../../../src/studio/web-next/src/api/trace-stats', () => ({
  getTraceStats: mocks.getTraceStats,
}))
vi.mock('../../../../src/studio/web-next/src/api/cost-stats', () => ({
  getCostStats: mocks.getCostStats,
}))
vi.mock('../../../../src/studio/web-next/src/api/providers', () => ({
  getProviders: mocks.getProviders,
}))
vi.mock('../../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: vi.fn(() => ({
    toast: mocks.uiToast,
    aiAvailable: mocks.uiState.aiAvailable,
    aiReasonText: mocks.uiState.aiReasonText,
  })),
}))
vi.mock('lucide-vue-next', () => new Proxy({}, { get: () => ({ template: '<i/>' }) }))

import WorkbenchView from '../../../../src/studio/web-next/src/views/WorkbenchView.vue'
import WbDraftCard from '../../../../src/studio/web-next/src/components/workbench/WbDraftCard.vue'
import WbStateCard from '../../../../src/studio/web-next/src/components/workbench/WbStateCard.vue'
import { useWorkbenchStore } from '../../../../src/studio/web-next/src/stores/workbench'
import { useTreeStore } from '../../../../src/studio/web-next/src/stores/tree'
import { useWorkspaceStore } from '../../../../src/studio/web-next/src/stores/workspace'
import { useProviderStore } from '../../../../src/studio/web-next/src/stores/provider'

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
  // 各动作的主 API 成功缺省（在途/失败用例用 mockImplementationOnce 单笔覆盖）
  mocks.getConfig.mockResolvedValue({})
  mocks.spawnRole.mockResolvedValue({ ok: true })
  mocks.interrupt.mockResolvedValue({ ok: true, interrupted: true })
  mocks.saveDraft.mockResolvedValue({
    ok: true,
    path: '写作/正文/0002-x.md',
    words: 5,
    docId: 'doc_2',
    snapshotted: false,
  })
  mocks.autoWrite.mockResolvedValue({ ok: true, chapter: 2, batchSize: 1 })
  mocks.generateOutline.mockResolvedValue(undefined)
  mocks.generateLeadUpdates.mockResolvedValue({ ok: true, count: 0 })
  mocks.acknowledgeJournalPending.mockResolvedValue({ ok: true, acknowledged: true })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.uiState.aiAvailable = true
  mocks.uiState.aiReasonText = '原因未知'
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
    mocks.getDraftPrompt.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolvePrompt = r
        }),
    )
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
    mocks.getDraftPrompt.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolvePrompt = r
        }),
    )
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

  it('aiAvailable=false → 警告条带上后端给的精确原因（不止泛化文案）', async () => {
    mocks.uiState.aiAvailable = false
    mocks.uiState.aiReasonText = '未配置 AI 服务供应商（请在设置页添加）'
    const w = await mountView()
    expect(w.find('.ai-warn').text()).toContain('未配置 AI 服务供应商（请在设置页添加）')
    w.unmount()
  })
})

// ── 生成族动作经执行器接线（表驱动）：7 个动作的在途锁、成功提示与失败落点 ──
//
// 7 个动作原先是逐行同构的样板（入口捕获书名 → await → 复检 → 失败尾款 → 放锁），现由
// composables/useScopedAction 的 useBookActionRunner 单点承担。本组按同一流程逐动作核对
// 差异项仍逐个在位：本动作自己的在途可见态、成功提示文案与类型、失败出口（行内错误条 /
// 错误 toast）、错误条可被读屏播报、锁进出（在途期重复触发只发一笔、收尾后可再发第二笔）。

type Wrapper = ReturnType<typeof mount>

/** 挂起一个 Promise 供在途期断言（落定由用例驱动） */
function hanging<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 失败消息取 friendlyError 不改写的形态（无技术词，透出原文） */
const BOOM = '动作炸了甲'

interface ActionCase {
  label: string
  /** 动作入口：按钮点击 / 子卡上抛事件，走到首个挂起 await */
  act: (w: Wrapper) => void | Promise<void>
  /** 本动作实际发出的主 API（在途/失败由用例驱动其 mock） */
  api: () => ReturnType<typeof vi.fn>
  /** 该主 API 成功落定值（形状按各自端点） */
  resolved: unknown
  /** 挂载前状态种子（崩溃待确认项 / 生成中 / 有正文可存） */
  prime?: () => void
  /** 在途期可观察面（取锁后成立） */
  inflight?: (w: Wrapper) => void
  /** 收尾后可观察面（放锁后复原） */
  settled?: (w: Wrapper) => void
  /** 在途期重复触发入口（缺省 = 本动作无第二入口，锁面由 inflight 与 API 计数核对） */
  duplicate?: (w: Wrapper) => void | Promise<void>
  /** 成功提示：[文案, 类型]；null = 本动作成功不 toast */
  success: [string, string] | null
  /** 失败出口（行内错误条 / 错误 toast；按动作既有面） */
  errorSurface: Array<'bar' | 'toast'>
}

const ACTION_CASES: ActionCase[] = [
  {
    label: '生成',
    act: (w) => w.find('.btn.primary').trigger('click'),
    api: () => mocks.getDraftPrompt,
    resolved: { prompt: '细纲语境', files: [] },
    // 在途期「生成」钮整体换成「中断」（genBusy 含 spawnPending）
    inflight: (w) => expect(findBtn(w, '中断'), '在途期生成钮换中断钮').toBeDefined(),
    settled: (w) => {
      expect(findBtn(w, '生成')).toBeDefined()
      expect(findBtn(w, '中断')).toBeUndefined()
    },
    // 第二入口是键盘（按钮已换中断钮，同一入口不可再点）
    duplicate: (w) => w.find('.prompt-input').trigger('keydown', { key: 'Enter' }),
    success: ['已开始生成', 'info'],
    errorSurface: ['bar', 'toast'],
  },
  {
    label: '忽略崩溃待确认',
    act: (w) => {
      w.findComponent(WbStateCard).vm.$emit('acknowledge')
    },
    api: () => mocks.acknowledgeJournalPending,
    resolved: { ok: true, acknowledged: true },
    prime: () => {
      mocks.getState.mockResolvedValue({ nextChapter: 2, crashedPendingOpIds: ['op-1'] })
    },
    // 本动作无模板级 pending 面：在途期再点确认不得发出第二笔（锁面靠 API 计数核对）
    duplicate: (w) => {
      w.findComponent(WbStateCard).vm.$emit('acknowledge')
    },
    success: ['已忽略崩溃恢复提醒，进门体检不再报该条', 'success'],
    errorSurface: ['toast'],
  },
  {
    label: '中断',
    act: (w) => w.find('.btn.danger').trigger('click'),
    duplicate: (w) => w.find('.btn.danger').trigger('click'),
    api: () => mocks.interrupt,
    resolved: { ok: true, interrupted: true },
    prime: () => {
      useWorkbenchStore().running = true // genBusy 分支才渲染「中断」钮
    },
    inflight: (w) => expect(w.find('.btn.danger').attributes('disabled')).toBeDefined(),
    settled: (w) => expect(w.find('.btn.danger').attributes('disabled')).toBeUndefined(),
    success: ['已中断', 'info'],
    errorSurface: ['bar'], // 失败只落错误条（不 toast）
  },
  {
    label: '全自动写章',
    act: (w) => w.find('.btn.auto').trigger('click'),
    duplicate: (w) => w.find('.btn.auto').trigger('click'),
    api: () => mocks.autoWrite,
    resolved: { ok: true, chapter: 2, batchSize: 1 },
    inflight: (w) => expect(findBtn(w, '写章启动中…')!.attributes('disabled')).toBeDefined(),
    settled: (w) => expect(findBtn(w, '全自动写章')).toBeDefined(),
    success: ['第 2 章已开始全自动写稿', 'info'],
    errorSurface: ['bar', 'toast'],
  },
  {
    label: '生成细纲',
    act: (w) => w.find('button[title*="细纲"]').trigger('click'),
    duplicate: (w) => w.find('button[title*="细纲"]').trigger('click'),
    api: () => mocks.generateOutline,
    resolved: undefined,
    inflight: (w) => expect(findBtn(w, '细纲生成中…')!.attributes('disabled')).toBeDefined(),
    settled: (w) => expect(findBtn(w, '生成细纲')).toBeDefined(),
    success: ['第 2 章细纲已生成', 'success'],
    errorSurface: ['bar', 'toast'],
  },
  {
    label: '生成账本推进',
    act: (w) => w.find('button[title*="账本推进"]').trigger('click'),
    duplicate: (w) => w.find('button[title*="账本推进"]').trigger('click'),
    api: () => mocks.generateLeadUpdates,
    resolved: { ok: true, count: 0 },
    inflight: (w) => expect(findBtn(w, '推进草拟中…')!.attributes('disabled')).toBeDefined(),
    settled: (w) => expect(findBtn(w, '生成账本推进')).toBeDefined(),
    success: ['本章无账本推进', 'success'],
    errorSurface: ['bar', 'toast'],
  },
  {
    label: '存草稿',
    act: (w) => {
      w.findComponent(WbDraftCard).vm.$emit('save')
    },
    api: () => mocks.saveDraft,
    resolved: { ok: true, path: '写作/正文/0002-x.md', words: 5, docId: 'doc_2', snapshotted: false },
    prime: () => {
      useWorkbenchStore().textOut = '正文若干字'
    },
    inflight: (w) => expect(w.findComponent(WbDraftCard).find('button').attributes('disabled')).toBeDefined(),
    settled: (w) => expect(w.findComponent(WbDraftCard).find('button').attributes('disabled')).toBeUndefined(),
    duplicate: (w) => {
      w.findComponent(WbDraftCard).vm.$emit('save')
    },
    success: ['第 2 章草稿已存，转到编辑', 'success'],
    errorSurface: ['bar', 'toast'],
  },
]

describe('WorkbenchView: 生成族动作的在途锁与成功提示（表驱动）', () => {
  beforeEach(() => {
    // tree.load / openTab / 档位刷新是动作体里的副作用，非本组断言面——stub 掉
    vi.spyOn(useProviderStore(), 'refresh').mockResolvedValue(undefined)
    vi.spyOn(useTreeStore(), 'load').mockResolvedValue(undefined)
    vi.spyOn(useWorkspaceStore(), 'openTab').mockImplementation(() => {})
  })

  it.each(ACTION_CASES)('$label：在途期取锁（重复触发只发一笔）→ 收尾放锁 + 成功提示', async (c) => {
    c.prime?.()
    const req = hanging<unknown>()
    c.api().mockImplementationOnce(() => req.promise)
    const w = await mountView()

    await c.act(w)
    await flushPromises()
    c.inflight?.(w)
    await c.duplicate?.(w)
    await flushPromises()
    // 重复触发不再发第二笔：模板禁用是第一道，函数级在途锁是渲染前/旁路触发的兜底
    // （锁自身的判定直测见 use-scoped-action.test.ts）
    expect(c.api()).toHaveBeenCalledTimes(1)

    req.resolve(c.resolved)
    await flushPromises()
    c.settled?.(w)
    if (c.success) expect(mocks.uiToast).toHaveBeenCalledWith(c.success[0], c.success[1])

    await c.act(w) // 锁已释放：同一入口再触发，第二笔真的发出
    await flushPromises()
    expect(c.api()).toHaveBeenCalledTimes(2)
    w.unmount()
  })
})

describe('WorkbenchView: 生成族动作的失败落点（表驱动）', () => {
  beforeEach(() => {
    vi.spyOn(useProviderStore(), 'refresh').mockResolvedValue(undefined)
    vi.spyOn(useTreeStore(), 'load').mockResolvedValue(undefined)
    vi.spyOn(useWorkspaceStore(), 'openTab').mockImplementation(() => {})
  })

  it.each(ACTION_CASES)('$label：失败仍属本书 → 按本动作既有出口落错、锁照样释放', async (c) => {
    c.prime?.()
    c.api().mockRejectedValueOnce(new Error(BOOM))
    const w = await mountView()

    await c.act(w)
    await flushPromises()
    if (c.errorSurface.includes('bar')) {
      expect(w.find('.err-msg').text()).toContain(BOOM)
      // 错误条即刻播报（读屏用户未必盯着这一处）
      expect(w.find('.err-msg').attributes('role')).toBe('alert')
    } else {
      expect(w.find('.err-msg').exists()).toBe(false)
    }
    if (c.errorSurface.includes('toast')) expect(mocks.uiToast).toHaveBeenCalledWith(BOOM, 'error')
    else expect(mocks.uiToast).not.toHaveBeenCalled()

    await c.act(w) // 失败路径同样放锁（错误面落地后第二笔照发）
    await flushPromises()
    expect(c.api()).toHaveBeenCalledTimes(2)
    w.unmount()
  })

  it.each(ACTION_CASES)('$label：在途切书 → 失败不落切换后的书（toast 与错误条皆无）', async (c) => {
    c.prime?.()
    const req = hanging<unknown>()
    c.api().mockImplementationOnce(() => req.promise)
    const w = await mountView()

    await c.act(w)
    await flushPromises()
    await w.setProps({ bookName: '书B' }) // 动作在途期间切书
    req.reject(new Error(BOOM))
    await flushPromises()

    expect(w.find('.err-msg').exists()).toBe(false) // 旧书错误条不得带进新书界面
    expect(mocks.uiToast).not.toHaveBeenCalled() // 旧书失败提示同样不落新书
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
    mocks.acknowledgeJournalPending.mockImplementationOnce(() => new Promise((r) => (resolveAck = r)))
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
    // 排空微任务而不是只转一拍：动作先经守卫步读书级配置，再发出 autoWrite——
    // 断言面是「在途期的按钮文案」，不是到达该 await 的拍数
    await flushPromises()
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
