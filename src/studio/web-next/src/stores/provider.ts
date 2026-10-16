/**
 * 提供方统一 store（阶段 14 §6.3 承接）——AI 提供方 + RAG 提供方 + 任务档位 + 对话档合一。
 *
 * 收敛前：AiServicePanel（本地 ref）、useChatTier（模块单例）、WorkbenchView 各自独立
 * getProviders/fetchModels，三份 state 三份网络请求，切书/改供应商后可能各不一致。
 * 收敛后：全部读写走此单例 store，一处刷新处处更新；revision也只在 store 里维护，
 * 写端点统一带 expectedRevision（409 冲突提示刷新）。
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  getProviders,
  getRagProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  setCurrentProvider,
  testProvider,
  setTiers,
  setChatTier,
  createRagProvider,
  updateRagProvider,
  deleteRagProvider,
  testRagProvider,
  updateProviderPricing,
  type ProviderConfDto,
  type RagProviderDto,
  type TierSlot,
  type TierConfig,
  type TestResult,
  type EffortLevel,
  type ModelConfDto,
  type PricingConfDto,
} from '../api/providers'
import { useUiStore } from './ui'
import { friendlyError } from '../shared/error'
import { useStaleGuard } from '../composables/useStaleGuard'
import { ApiError } from '../api/client'

/** 档位下拉选项：value = 模型 id（写回档位），label = 显示名（已配置行 name ?? id；拉取行 = id） */
export interface ModelOption {
  value: string
  label: string
}

export const useProviderStore = defineStore('provider', () => {
  const ui = useUiStore()

  // ── AI 提供方 ──
  const providers = ref<ProviderConfDto[]>([])
  const currentId = ref<string | null>(null)
  const currentModel = ref<string | null>(null)
  const tiers = ref<TierConfig>({ creative: { model: '', effort: 'xhigh' }, assistant: null, chat: null })
  /** 并发修订号：写端点 expectedRevision 依据；响应/409 回来时更新 */
  const revision = ref(0)

  /** 修订号写入口（一切响应回传）——**只许前进**。
   *  服务端 AI/RAG 两族共用一份 providers.json、共用一个 revision 计数
   *  （src/ai/provider/store.ts：FILE='providers.json' 单文件、DiskFormat 单 revision 字段、
   *  saveProvidersLocked 落盘后 +1；api/providers.ts 与 api/rag-providers.ts 各端点
   *  同回 s.revision），故不能按域分 ref——分域号会让另一域带上错号吃真 409。
   *  真正的缺口是「后到的旧读数回退共享号」：refresh/refreshRag 并发（refreshAll）或
   *  刷新与写交错时，先发出、后返回的那笔读到的是更旧的号，直接赋值即把 revision 拉回，
   *  此后任意域的写都携陈旧 expectedRevision → 伪 409 +「已在其他窗口被修改」误导提示。
   *  取大即：旧读数不再回退，写响应自带后发号照常前进（写响应亦经此处，避免同域两笔
   *  写在途的迟到响应回退）。
   *  传非数（响应缺 revision 字段的退化态，类型面 d.revision 为 number 不可达；测试桩
   *  常缺字段）照旧赋值——与逐点赋值的原口径逐位等价，不引入新的传播差异。 */
  function advanceRevision(next: number): void {
    if (typeof next === 'number' && next <= revision.value) return
    revision.value = next
  }
  /** 409 恢复链的权威重读：冲突已证明本地号陈旧，无条件采纳远端号。
   *  取大闸查不出的退化只有「服务端号变小」（providers.json 被外部重置/换库）——本地号
   *  领先时每次写都 409，恢复链在此复位，不会卡死；故刷新/恢复两条路分工明确。 */
  function adoptRevision(next: number): void {
    revision.value = next
  }
  const loading = ref(false)
  const testing = ref<string | null>(null)
  const testResults = ref<Map<string, TestResult>>(new Map())
  /** 测试连接用模型（按提供方分卡独立） */
  const probeModels = ref<Map<string, string>>(new Map())

  // ── RAG 提供方 ──
  const ragProviders = ref<RagProviderDto[]>([])
  const ragLoading = ref(false)
  const ragTesting = ref<string | null>(null)
  const ragTestResults = ref<Map<string, { ok: boolean; caps?: { connected: boolean }; error?: string }>>(new Map())

  const currentProvider = computed<ProviderConfDto | null>(
    () => providers.value.find((p) => p.id === currentId.value) ?? null,
  )
  /** 当前供应商已配置模型行*/
  const configModels = computed<ModelConfDto[]>(() => currentProvider.value?.models ?? [])

  /**
   * 档位/对话模型选项 = 当前供应商「已配置模型行」——本地声明，不打上游网关
   * （上游清单只在提供方编辑器「获取模型」勾选导入时拉取）。显示 name ?? id；无当前供应商 → 空。
   */
  const currentModels = computed<ModelOption[]>(() =>
    configModels.value.map((m) => ({
      value: m.id,
      label: typeof m.name === 'string' && m.name ? m.name : m.id,
    })),
  )

  /** 对话档有效模型（对话档优先，回落创作档） */
  const chatActiveModel = computed(() => tiers.value.chat?.model || tiers.value.creative.model || '')
  /** 对话档有效推理等级 */
  const chatActiveEffort = computed<EffortLevel>(
    () => (tiers.value.chat?.effort as EffortLevel) || (tiers.value.creative.effort as EffortLevel) || 'low',
  )

  /** refresh 操作代（与 check store 同款）：并发 refresh 慢响应迟到不回填旧数据。
   * 裸计数器换装 useStaleGuard（begin/stale/fresh 语义映射见工具注）。 */
  const refreshGen = useStaleGuard()
  /** refreshRag 操作代（与 refresh 同款但独立计数——refreshAll 并发跑两者，
   *  共用一个计数会互相作废，先返回的那次响应必被后发者顶掉） */
  const refreshRagGen = useStaleGuard()

  /** 刷新 AI 提供方 + 档位 + revision（RAG 单独 refreshRag）。
   *  authoritative：409 恢复链的权威重读（无条件采纳远端号）；缺省 = 常规刷新，
   *  revision 只前进（见 advanceRevision 头注）。 */
  async function refresh(authoritative = false): Promise<void> {
    const gen = refreshGen.begin()
    loading.value = true
    try {
      const d = await getProviders()
      if (refreshGen.stale(gen)) return // 后发 refresh 已生效：旧响应不回填（refreshRag 走独立代，不作废本代）
      providers.value = d.providers
      currentId.value = d.currentId
      currentModel.value = d.currentModel
      tiers.value = {
        creative: { ...d.tiers.creative },
        assistant: d.tiers.assistant ? { ...d.tiers.assistant } : null,
        chat: d.tiers.chat ? { ...d.tiers.chat } : null,
      }
      if (authoritative) adoptRevision(d.revision)
      else advanceRevision(d.revision)
      // 列表收敛——另一窗口删除的提供方，本窗缓存键随
      // 刷新修剪（本地删除路径已随删清；跨窗删除此前残留到重启，KB 级卫生）。
      const alive = new Set(d.providers.map((p) => p.id))
      for (const id of [...testResults.value.keys()]) if (!alive.has(id)) testResults.value.delete(id)
      for (const id of [...probeModels.value.keys()]) if (!alive.has(id)) probeModels.value.delete(id)
    } catch (e) {
      // 降级留痕——面板空态可重试，不打扰 UI
      console.warn('[provider] AI 提供方/档位刷新失败（面板显示空态，可重试）', e)
    } finally {
      if (refreshGen.fresh(gen)) loading.value = false
    }
  }

  /** 刷新 RAG 提供方（独立端点）。authoritative 语义同 refresh。 */
  async function refreshRag(authoritative = false): Promise<void> {
    const gen = refreshRagGen.begin()
    ragLoading.value = true
    try {
      const d = await getRagProviders()
      if (refreshRagGen.stale(gen)) return // 后发 refreshRag 已生效：旧响应不回填
      ragProviders.value = d.ragProviders
      if (authoritative) adoptRevision(d.revision)
      else advanceRevision(d.revision)
      // RAG 侧同款收敛（跨窗删除的 ragTestResults 键随列表修剪）
      const aliveRag = new Set(d.ragProviders.map((p) => p.id))
      for (const id of [...ragTestResults.value.keys()]) if (!aliveRag.has(id)) ragTestResults.value.delete(id)
    } catch (e) {
      // 降级留痕——面板空态可重试，不打扰 UI
      console.warn('[provider] RAG 提供方刷新失败（面板显示空态，可重试）', e)
    } finally {
      if (refreshRagGen.fresh(gen)) ragLoading.value = false
    }
  }

  /**
   * 写端点 409（多窗 expectedRevision 冲突）恢复链——轻量：重新 GET
   * 刷新 providers/ragProviders/revision（后续写不再吃陈旧 409）+ 明确提示（对齐 prefs
   * 的 recoverFromConflict 思路但不自动合并/重放：provider 配置整体以远端为准，本窗
   * 表单未提交内容仍在编辑器里，由作者确认后重试）。返回 true = 已按 409 收口（调用
   * 方不再叠通用错误 toast）。
   * 刷新取权威口径（refreshAll(true)）：冲突已证明本地号陈旧，无条件对齐远端号——含
   * 服务端 providers.json 被外部重置（号变小）的形态，否则本地号领先会让每次写都 409。
   */
  async function recover409(e: unknown): Promise<boolean> {
    if (!(e instanceof ApiError) || e.status !== 409) return false
    // GET 两族端点：revision 对齐远端（内部静默，网络不可达不叠加噪声）
    await refreshAll(true)
    ui.toast('AI 配置已在其他窗口被修改，已刷新为最新配置，请重试本次操作', 'warning')
    return true
  }

  /** 写端点骨架单源——「try { 写 → revision 同步 → 成功
   *  toast } catch { 409 走 recover409 恢复链（返回 null 不叠错误 toast）；否则错误
   *  toast }」九写函数（add/update/remove/activate/saveTiers/applyChatTier/addRag/
   *  updateRag/removeRag）收敛于此，函数体只剩业务行。逐位等价锚：
   *  - okMsg 缺省不弹成功 toast（activate/saveTiers/applyChatTier 既有口径）；
   *  - failMsg 缺省 friendlyError 直出；applyChatTier 的「回落旧档」前缀经此注入；
   *  - revision 更新时机在 fn 内原位（await 后即时，先于任何 toast/return）；
   *  - 成功返回 fn 的返回值，任何失败路径返回 null（调用方按需转 false / id | null）。
   * （同批）：errText 纯转发别名删除，直用 friendlyError。 */
  async function guardedWrite<T>(
    fn: () => Promise<T>,
    okMsg?: string,
    failMsg: (e: unknown) => string = friendlyError,
  ): Promise<T | null> {
    try {
      const r = await fn()
      if (okMsg !== undefined) ui.toast(okMsg, 'success')
      return r
    } catch (e) {
      if (await recover409(e)) return null // 409 多窗冲突走刷新恢复链
      ui.toast(failMsg(e), 'error')
      return null
    }
  }

  /** 新增提供方（带 expectedRevision）；成功返回新提供方 id，失败返回 null。 */
  async function add(input: {
    name: string
    protocol: ProviderConfDto['protocol']
    auth: ProviderConfDto['auth']
    baseUrl: string
    apiKey: string
    models?: ModelConfDto[]
  }): Promise<string | null> {
    return guardedWrite(async () => {
      const r = await createProvider({ ...input, auth: input.auth, expectedRevision: revision.value })
      providers.value.push(r.provider)
      advanceRevision(r.revision)
      if (!currentId.value) {
        // 首个提供方自动设为当前
        currentId.value = r.provider.id
      }
      return r.provider.id
    }, '已保存')
  }

  /** 编辑提供方（models 未变可不传 → 服务端保留原行）。 */
  async function update(
    id: string,
    input: {
      name: string
      protocol: ProviderConfDto['protocol']
      auth: ProviderConfDto['auth']
      baseUrl: string
      apiKey: string
      models?: ModelConfDto[]
    },
  ): Promise<boolean> {
    return (
      (await guardedWrite(async () => {
        const r = await updateProvider(id, { ...input, auth: input.auth, expectedRevision: revision.value })
        const i = providers.value.findIndex((p) => p.id === id)
        if (i >= 0) providers.value[i] = r.provider
        advanceRevision(r.revision)
        return true
      }, '已保存')) === true
    )
  }

  /** 写提供方价格表（独立端点，与主表单同吃一份 revision）。
   *  必须带 expectedRevision 并回写响应 revision——价格保存会 bump 服务端计数，本地号若不动，
   *  紧随的表单保存/启用携陈旧号吃伪 409「已在其他窗口被修改」，该笔操作被丢弃。 */
  async function savePricing(id: string, pricing: PricingConfDto | null): Promise<boolean> {
    return (
      (await guardedWrite(async () => {
        const r = await updateProviderPricing(id, pricing, revision.value)
        advanceRevision(r.revision)
        const i = providers.value.findIndex((p) => p.id === id)
        if (i >= 0) providers.value[i] = { ...providers.value[i]!, pricing: r.pricing ?? undefined }
        return true
      })) === true
    )
  }

  /** 删除提供方；返回成功与否（成功后 currentId 已由响应更新）。 */
  async function remove(id: string): Promise<boolean> {
    return (
      (await guardedWrite(async () => {
        const r = await deleteProvider(id, revision.value)
        providers.value = providers.value.filter((p) => p.id !== id)
        currentId.value = r.currentId
        probeModels.value.delete(id)
        // （专项）：测试结果缓存随删清——防删提供方后 Map 残留（读侧按 id 键取不再命中，纯卫生）
        testResults.value.delete(id)
        advanceRevision(r.revision)
        return true
      }, '已删除')) === true
    )
  }

  /** 设为当前启用（caps 守卫 +）。返回是否成功——
   *  调用方（AiServicePanel）此前无条件 toast「已启用」，409/网络失败时同时收到
   *  错误与成功两条矛盾 toast、徽章仍指旧提供方。 */
  async function activate(id: string): Promise<boolean> {
    return (
      (await guardedWrite(async () => {
        const r = await setCurrentProvider(id, revision.value)
        currentId.value = id
        // PUT /current saveProviders bump revision——同步前端，避免后续写因陈旧 expectedRevision 409
        if (typeof r.revision === 'number') advanceRevision(r.revision)
        return true
      })) === true
    )
  }

  /** 测试连接（探测依赖测试选择模型；失败不清除旧结果）。 */
  async function test(id: string, model: string | undefined): Promise<void> {
    testing.value = id
    try {
      const r = await testProvider(id, model || undefined)
      const s = new Map(testResults.value)
      s.set(id, r)
      testResults.value = s
      // 探测写回 bump 了服务端 revision——同步前端，避免测试后任意写因陈旧 expectedRevision 409
      if (typeof r.revision === 'number') advanceRevision(r.revision)
      // caps 就地写回 provides[i]，让行卡 caps 徽章（绿/红/未测试）即时回显——
      // 等价旧 refresh 的「caps 落库」语义，免整表重拉（此前徽章不刷新，回归被 e2e 命中）
      const i = providers.value.findIndex((p) => p.id === id)
      if (i >= 0) {
        providers.value[i] = { ...providers.value[i]!, caps: r.caps ?? null, capsProbedAt: Date.now() }
      }
    } catch (e) {
      // testProvider 出错即非 ok 结果（errText 壳删除，直用 friendlyError）
      const s = new Map(testResults.value)
      s.set(id, { ok: false, error: friendlyError(e) })
      testResults.value = s
    } finally {
      // 按 id 归属清空——A/B 连点时先完成者不得提前清掉
      // 后跑者的行内 spinner/按钮态
      if (testing.value === id) testing.value = null
    }
  }

  /** 保存任务档位（创作/助手）+。 */
  async function saveTiers(input: { creative: TierSlot; assistant: TierSlot | null }): Promise<boolean> {
    return (
      (await guardedWrite(async () => {
        const r = await setTiers({ ...input, expectedRevision: revision.value })
        tiers.value = {
          creative: { ...r.tiers.creative },
          assistant: r.tiers.assistant ? { ...r.tiers.assistant } : null,
          chat: r.tiers.chat ? { ...r.tiers.chat } : null,
        }
        currentModel.value = r.tiers.creative.model || null
        advanceRevision(r.revision)
        return true
      })) === true
    )
  }

  /** 对话档切换（写档即生效，不引 full refresh；带 expectedRevision）。 */
  async function applyChatTier(slot: TierSlot | null): Promise<void> {
    await guardedWrite(
      async () => {
        const r = await setChatTier(slot, revision.value)
        tiers.value = { ...tiers.value, chat: r.tiers.chat ? { ...r.tiers.chat } : null }
        advanceRevision(r.revision)
      },
      undefined,
      // 文案逐位不变：回落提示前缀 + friendlyError（原 errText 同体）
      (e) => `档位保存失败，重开后将回落旧档：${friendlyError(e)}`,
    )
  }

  // ── RAG ──
  async function addRag(input: { name: string; endpoint: string; model: string; apiKey: string }): Promise<boolean> {
    return (
      (await guardedWrite(async () => {
        const r = await createRagProvider({ ...input, expectedRevision: revision.value })
        ragProviders.value.push(r.provider)
        advanceRevision(r.revision)
        return true
      }, '已保存')) === true
    )
  }

  async function updateRag(
    id: string,
    input: { name: string; endpoint: string; model: string; apiKey: string },
  ): Promise<boolean> {
    return (
      (await guardedWrite(async () => {
        const r = await updateRagProvider(id, { ...input, expectedRevision: revision.value })
        const i = ragProviders.value.findIndex((p) => p.id === id)
        if (i >= 0) ragProviders.value[i] = r.provider
        advanceRevision(r.revision)
        return true
      }, '已保存')) === true
    )
  }

  async function removeRag(id: string): Promise<boolean> {
    return (
      (await guardedWrite(async () => {
        const r = await deleteRagProvider(id, revision.value)
        ragProviders.value = ragProviders.value.filter((p) => p.id !== id)
        // （专项）：同 remove——删 RAG 配置清测试结果缓存，防 Map 残留
        ragTestResults.value.delete(id)
        advanceRevision(r.revision)
        return true
      }, '已删除')) === true
    )
  }

  async function testRag(id: string): Promise<void> {
    ragTesting.value = id
    try {
      const r = await testRagProvider(id)
      // 探测写回 bump 服务端 revision——同步本地防后续 RAG 写
      // 以滞后 revision 必收 409（误导 toast）
      if (typeof r.revision === 'number') advanceRevision(r.revision)
      const m = new Map(ragTestResults.value)
      m.set(id, r)
      ragTestResults.value = m
    } catch (e) {
      const m = new Map(ragTestResults.value)
      m.set(id, { ok: false, error: friendlyError(e) })
      ragTestResults.value = m
    } finally {
      // 同 test——按 id 归属清空
      if (ragTesting.value === id) ragTesting.value = null
    }
  }

  /** 面板整页加载（设置页打开：AI + RAG 一并拉）。
   *  两域并发各回同一份服务端计数（providers.json 单 revision），故由 advanceRevision
   *  取大收口——先发出、后返回的旧读数不回退共享号（后到者不得覆盖他域结果）。 */
  async function refreshAll(authoritative = false): Promise<void> {
    await Promise.all([refresh(authoritative), refreshRag(authoritative)])
  }

  return {
    // state
    providers,
    currentId,
    currentModel,
    tiers,
    revision,
    loading,
    testing,
    testResults,
    probeModels,
    ragProviders,
    ragLoading,
    ragTesting,
    ragTestResults,
    // getters
    currentProvider,
    configModels,
    currentModels,
    chatActiveModel,
    chatActiveEffort,
    // actions
    refresh,
    refreshRag,
    refreshAll,
    add,
    update,
    savePricing,
    remove,
    activate,
    test,
    saveTiers,
    applyChatTier,
    addRag,
    updateRag,
    removeRag,
    testRag,
  }
})
