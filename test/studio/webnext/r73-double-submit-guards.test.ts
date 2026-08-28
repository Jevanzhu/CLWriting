// @vitest-environment happy-dom
/**
 * R73-62/R73-63（二十一轮批 E）回归：同族「双击重复提交」守卫。
 *
 * - R73-62：保存按钮无 :disabled、无在途锁——AiProviderEditor / RagProviderEditor /
 *   StyleEntryPanel 三入口双击重复提交（新增卡双 POST 落两条同名记录；编辑卡第二笔
 *   以陈旧 revision 409 弹误导性「并发冲突」）；AiServicePanel.save/saveRag 加在途
 *   布尔锁（R70-25 建书在途锁同类先例）并经 :saving 下传编辑器禁按钮 + 中文文案反馈。
 * - R73-63：WorkbenchView.onSaveDraft 补同款本地在途锁（同文件 onSpawn/onAuto/onOutline/
 *   onLeadUpdates 均有，此前漏网），WbDraftCard 按钮在途禁用 + 文案。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ProviderConfDto, RagProviderDto, TierConfig } from '../../../src/studio/web-next/src/api/providers'
import AiServicePanel from '../../../src/studio/web-next/src/components/ui/AiServicePanel.vue'
import AiProviderEditor from '../../../src/studio/web-next/src/components/ui/AiProviderEditor.vue'
import StyleEntryPanel from '../../../src/studio/web-next/src/components/style/StyleEntryPanel.vue'
import WorkbenchView from '../../../src/studio/web-next/src/views/WorkbenchView.vue'
import WbDraftCard from '../../../src/studio/web-next/src/components/workbench/WbDraftCard.vue'

// ── mock：providers api 层 + AI 可达性探测（同 settings-service-provider.test 口径） ──
const providerMocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getRagProviders: vi.fn(),
  fetchModels: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  setCurrentProvider: vi.fn(),
  testProvider: vi.fn(),
  setTiers: vi.fn(),
  setChatTier: vi.fn(),
  createRagProvider: vi.fn(),
  updateRagProvider: vi.fn(),
  deleteRagProvider: vi.fn(),
  testRagProvider: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/providers', () => providerMocks)
vi.mock('../../../src/studio/web-next/src/api/ai-status', () => ({
  getAiStatus: vi.fn().mockResolvedValue({ available: true, driver: 'mock' }),
}))

// ── mock：style api 层（StyleEntryPanel 走 style store → api/style） ──
const styleMocks = vi.hoisted(() => ({
  listStyleEntries: vi.fn(),
  addStyleEntry: vi.fn(),
  deleteStyleEntry: vi.fn(),
  listStyleCandidates: vi.fn(),
  confirmStyleCandidate: vi.fn(),
  ignoreStyleCandidate: vi.fn(),
  runStyleHarvest: vi.fn(),
  getStyleConfig: vi.fn(),
  freezeStyleBaseline: vi.fn(),
  getStyleTrend: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/style', () => styleMocks)

// ── mock：stream/books/trace api（WorkbenchView R73-63） ──
const streamMocks = vi.hoisted(() => ({
  getState: vi.fn(async () => ({ nextChapter: 3 })),
  spawnRole: vi.fn(),
  interrupt: vi.fn(),
  saveDraft: vi.fn(),
  autoWrite: vi.fn(),
  getDraftPrompt: vi.fn(),
  generateOutline: vi.fn(),
  generateLeadUpdates: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/stream', () => streamMocks)
vi.mock('../../../src/studio/web-next/src/api/trace-stats', () => ({
  getTraceStats: vi.fn(async () => ({ ruleHits: [] })),
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: vi.fn(async () => ({})),
}))

import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useProviderStore } from '../../../src/studio/web-next/src/stores/provider'
import { useStyleStore } from '../../../src/studio/web-next/src/stores/style'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'

const baseTiers: TierConfig = {
  creative: { model: 'gpt-5', effort: 'xhigh' },
  assistant: null,
  chat: null,
}

function provider(id: string, name: string): ProviderConfDto {
  return {
    id,
    name,
    protocol: 'openai',
    baseUrl: `https://${id}.local/v1`,
    apiKey: '',
    apiKeyMasked: 'sk-1...abcd',
    hasKey: true,
    caps: null,
  }
}

function ragProvider(id: string, name: string): RagProviderDto {
  return { id, name, endpoint: `https://${id}.local/v1/embeddings`, model: 'embed-a', apiKey: '', apiKeyMasked: 'sk-e...abcd', hasKey: true, caps: null }
}

/** 起一个手动放行的 Promise（模拟在途请求） */
function pending<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  providerMocks.getProviders.mockResolvedValue({
    providers: [provider('p1', '甲家')],
    currentId: 'p1',
    currentModel: 'gpt-5',
    tiers: baseTiers,
    revision: 0,
  })
  providerMocks.getRagProviders.mockResolvedValue({ ragProviders: [ragProvider('r1', '嵌入甲')], revision: 0 })
  styleMocks.listStyleEntries.mockResolvedValue({ entries: [], errors: [] })
  styleMocks.listStyleCandidates.mockResolvedValue({ candidates: [], errors: [] })
  styleMocks.getStyleConfig.mockResolvedValue({})
})

// ═══════════ R73-62：AiServicePanel 三个保存入口 ═══════════

describe('R73-62: AiServicePanel 保存入口在途锁（双击只发一次）', () => {
  it('AI 新增卡：双击保存 → createProvider 只发一次（修复前双 POST 落两条同名记录）', async () => {
    const req = pending<{ provider: ProviderConfDto; revision: number }>()
    providerMocks.createProvider.mockReturnValue(req.promise)
    const w = mount(AiServicePanel, { attachTo: document.body })
    await flushPromises()

    await w.find('.group-title .add-btn').trigger('click')
    await flushPromises()
    const card = w.find('.add-provider-card')
    expect(card.exists()).toBe(true)
    // 表单骨架输入序：API Key（主字段）→ 名称 → API 地址
    const inputs = card.findAll('input')
    await inputs[0]!.setValue('sk-test')
    await inputs[1]!.setValue('测试家')
    await inputs[2]!.setValue('https://api.test/v1')

    await card.find('.save-btn').trigger('click') // 第一笔（在途挂起）
    expect(providerMocks.createProvider).toHaveBeenCalledTimes(1)
    // 在途反馈：按钮禁用 + 文案（:saving 下传）
    expect((card.find('.save-btn').element as HTMLButtonElement).disabled).toBe(true)
    expect(card.find('.save-btn').text()).toContain('保存中')
    await card.find('.save-btn').trigger('click') // 双击第二笔
    expect(providerMocks.createProvider).toHaveBeenCalledTimes(1) // 修复点：在途锁挡住

    req.resolve({ provider: provider('p9', '测试家'), revision: 1 })
    await flushPromises()
    expect(w.find('.add-provider-card').exists()).toBe(false) // 成功关卡
    w.unmount()
  })

  it('AI 编辑卡：双击保存 → updateProvider 只发一次（修复前第二笔撞陈旧 revision 409 误报并发冲突）', async () => {
    const req = pending<{ provider: ProviderConfDto; revision: number }>()
    providerMocks.updateProvider.mockReturnValue(req.promise)
    const w = mount(AiServicePanel, { attachTo: document.body })
    await flushPromises()

    await w.findAll('.provider-row')[0]!.find('.mini-btn[data-tip="编辑"]').trigger('click')
    await flushPromises()
    const editor = w.find('.row-inline-editor')
    expect(editor.exists()).toBe(true)
    // 注意：编辑卡内嵌价格小节也有 .save-btn（保存价格）——主保存按钮限定 .form-actions
    const saveBtn = editor.find('.form-actions .save-btn')
    await saveBtn.trigger('click')
    expect(providerMocks.updateProvider).toHaveBeenCalledTimes(1)
    await editor.find('.form-actions .save-btn').trigger('click')
    expect(providerMocks.updateProvider).toHaveBeenCalledTimes(1) // 修复点

    req.resolve({ provider: provider('p1', '甲家改'), revision: 2 })
    await flushPromises()
    expect(w.find('.row-inline-editor').exists()).toBe(false)
    w.unmount()
  })

  it('RAG 新增卡：双击保存 → createRagProvider 只发一次', async () => {
    const req = pending<{ provider: RagProviderDto; revision: number }>()
    providerMocks.createRagProvider.mockReturnValue(req.promise)
    const w = mount(AiServicePanel, { attachTo: document.body })
    await flushPromises()

    // 切到 RAG 分页 → 打开新增卡
    await w.findAll('.panel-tab')[1]!.trigger('click')
    await flushPromises()
    await w.find('.group-title .add-btn').trigger('click')
    await flushPromises()
    const card = w.find('.add-provider-card')
    expect(card.exists()).toBe(true)
    const inputs = card.findAll('input') // 名称/地址/模型/Key
    await inputs[0]!.setValue('嵌入乙')
    await inputs[1]!.setValue('https://emb.test/v1/embeddings')
    await inputs[2]!.setValue('embed-b')
    await inputs[3]!.setValue('sk-emb')

    await card.find('.save-btn').trigger('click')
    expect(providerMocks.createRagProvider).toHaveBeenCalledTimes(1)
    expect((card.find('.save-btn').element as HTMLButtonElement).disabled).toBe(true)
    await card.find('.save-btn').trigger('click')
    expect(providerMocks.createRagProvider).toHaveBeenCalledTimes(1) // 修复点

    req.resolve({ provider: ragProvider('r9', '嵌入乙'), revision: 1 })
    await flushPromises()
    expect(w.find('.add-provider-card').exists()).toBe(false)
    w.unmount()
  })
})

// ═══════════ R73-62：AiProviderEditor saving 契约（视觉面） ═══════════

describe('R73-62: AiProviderEditor saving prop → 按钮禁用 + 文案反馈', () => {
  it('saving=true → 保存按钮禁用、文案「保存中…」；saving 缺省可点', async () => {
    const w = mount(AiProviderEditor, { props: { initial: null, saving: true } })
    const btn = w.find('.form-actions .save-btn')
    expect((btn.element as HTMLButtonElement).disabled).toBe(true)
    expect(btn.text()).toContain('保存中')
    await w.setProps({ saving: false })
    expect((w.find('.form-actions .save-btn').element as HTMLButtonElement).disabled).toBe(false)
    expect(w.find('.form-actions .save-btn').text()).not.toContain('保存中')
    w.unmount()
  })
})

// ═══════════ R73-62：StyleEntryPanel 存入条目库 ═══════════

describe('R73-62: StyleEntryPanel 双击「存入条目库」→ addStyleEntry 只发一次', () => {
  it('双击提交 → style.add 只调一次（修复前落两条同名条目）', async () => {
    const req = pending<unknown>()
    styleMocks.addStyleEntry.mockReturnValue(req.promise)
    const style = useStyleStore()
    style.bookName = '书A'

    const w = mount(StyleEntryPanel)
    await flushPromises()
    await w.find('.head-actions .btn-primary').trigger('click') // 打开新增表单
    await w.find('.af-textarea').setValue('样章正文一段')
    const submitBtn = w.find('.af-actions .btn-primary')
    await submitBtn.trigger('click') // 第一笔（在途挂起）
    expect(styleMocks.addStyleEntry).toHaveBeenCalledTimes(1)
    expect((submitBtn.element as HTMLButtonElement).disabled).toBe(true)
    expect(submitBtn.text()).toContain('存入中')
    await w.find('.af-actions .btn-primary').trigger('click') // 双击第二笔
    expect(styleMocks.addStyleEntry).toHaveBeenCalledTimes(1) // 修复点

    req.resolve({})
    await flushPromises()
    expect(w.find('.add-form').exists()).toBe(false) // 成功后收表单
    w.unmount()
  })
})

// ═══════════ R73-63：WorkbenchView.onSaveDraft 在途锁 ═══════════

describe('R73-63: WorkbenchView 双击「存草稿并编辑」→ saveDraft 只发一次', () => {
  it('双击保存 → saveDraft 只调一次（对齐 onSpawn/onOutline 同款在途锁）', async () => {
    vi.spyOn(useProviderStore(), 'refresh').mockResolvedValue(undefined)
    vi.spyOn(useTreeStore(), 'load').mockResolvedValue(undefined)
    const wb = useWorkbenchStore()
    wb.textOut = '正文若干字'
    const req = pending<{ ok: boolean; path: string; words: number; docId: string; snapshotted: boolean }>()
    streamMocks.saveDraft.mockReturnValue(req.promise)

    const w = mount(WorkbenchView, {
      props: { bookName: '书A' },
      global: { stubs: { ChatPanel: true, WbStateCard: true, WbAdvanced: true, WbHealCard: true, WbUsageCard: true } },
    })
    await flushPromises()

    const draftCard = w.findComponent(WbDraftCard)
    const saveBtn = draftCard.find('button')
    await saveBtn.trigger('click') // 第一笔（在途挂起）
    expect(streamMocks.saveDraft).toHaveBeenCalledTimes(1)
    expect((saveBtn.element as HTMLButtonElement).disabled).toBe(true) // R73-63：在途禁用
    expect(saveBtn.text()).toContain('存草稿中')
    await draftCard.find('button').trigger('click') // 双击第二笔
    expect(streamMocks.saveDraft).toHaveBeenCalledTimes(1) // 修复点

    req.resolve({ ok: true, path: '写作/正文/0003-x.md', words: 5, docId: 'doc_9', snapshotted: false })
    await flushPromises()
    expect(draftCard.find('.draft-actions .muted').exists()).toBe(true) // 徽标照常
    w.unmount()
  })
})
