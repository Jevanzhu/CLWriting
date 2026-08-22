/**
 * 提供方统一 store（阶段 14 §6.3 承接 P2-17）——AI 提供方 + RAG 提供方 + 任务档位 + 对话档合一。
 *
 * 收敛前：AiServicePanel（本地 ref）、useChatTier（模块单例）、WorkbenchView 各自独立
 * getProviders/fetchModels，三份 state 三份网络请求，切书/改供应商后可能各不一致。
 * 收敛后：全部读写走此单例 store，一处刷新处处更新；revision（P4）也只在 store 里维护，
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
  fetchModels,
  setTiers,
  setChatTier,
  createRagProvider,
  updateRagProvider,
  deleteRagProvider,
  testRagProvider,
  type ProviderConfDto,
  type RagProviderDto,
  type TierSlot,
  type TierConfig,
  type TestResult,
  type EffortLevel,
  type ModelConfDto,
} from '../api/providers'
import { useUiStore } from './ui'
import { friendlyError } from '../shared/error'

/** 档位下拉选项：value = 模型 id（写回档位），label = 显示名（已配置行 name ?? id；拉取行 = id） */
export interface ModelOption {
  value: string
  label: string
}

/** 读取错误文案提取（409 = 并发冲突，提示刷新）。 */
function errText(e: unknown): string {
  return friendlyError(e)
}

export const useProviderStore = defineStore('provider', () => {
  const ui = useUiStore()

  // ── AI 提供方 ──
  const providers = ref<ProviderConfDto[]>([])
  const currentId = ref<string | null>(null)
  const currentModel = ref<string | null>(null)
  const tiers = ref<TierConfig>({ creative: { model: '', effort: 'xhigh' }, assistant: null, chat: null })
  /** 并发修订号（P4）：写端点 expectedRevision 依据；响应/409 回来时更新 */
  const revision = ref(0)
  const loading = ref(false)
  const testing = ref<string | null>(null)
  const testResults = ref<Map<string, TestResult>>(new Map())
  /** 测试连接用模型（按提供方分卡独立，V-P2-26） */
  const probeModels = ref<Map<string, string>>(new Map())
  /** 拉取到的模型清单（按提供方分存，V-P2-26） */
  const modelsByProvider = ref<Map<string, string[]>>(new Map())
  /** 入模重入锁：同一提供方正在拉取则不重复发请求。
   *  P-10（第十四轮）：删除 fetchingModels 单布尔死状态——并发拉取时先完成者会把
   *  共享布尔置 false（语义失真），且全前端零消费方；「任一在拉」如需可由
   *  fetchingModelIds.size>0 派生。 */
  const fetchingModelIds = new Set<string>()

  // ── RAG 提供方 ──
  const ragProviders = ref<RagProviderDto[]>([])
  const ragLoading = ref(false)
  const ragTesting = ref<string | null>(null)
  const ragTestResults = ref<Map<string, { ok: boolean; caps?: { connected: boolean }; error?: string }>>(new Map())

  const currentProvider = computed<ProviderConfDto | null>(() => providers.value.find((p) => p.id === currentId.value) ?? null)
  /** 当前供应商已配置模型行（P9） */
  const configModels = computed<ModelConfDto[]>(() => currentProvider.value?.models ?? [])

  /**
   * 档位/对话模型选项 = 当前供应商「已配置模型行」——本地声明，不打上游网关
   * （上游清单只在提供方编辑器「获取模型」勾选导入时拉取）。显示 name ?? id；无当前供应商 → 空。
   */
  const currentModels = computed<ModelOption[]>(() =>
    configModels.value.map((m) => ({
      value: m.id,
      label: (typeof m.name === 'string' && m.name) ? m.name : m.id,
    })),
  )

  /** 对话档有效模型（对话档优先，回落创作档） */
  const chatActiveModel = computed(() => tiers.value.chat?.model || tiers.value.creative.model || '')
  /** 对话档有效推理等级 */
  const chatActiveEffort = computed<EffortLevel>(() => (tiers.value.chat?.effort as EffortLevel) || (tiers.value.creative.effort as EffortLevel) || 'low')

  /** 刷新 AI 提供方 + 档位 + revision（RAG 单独 refreshRag）。 */
  async function refresh(): Promise<void> {
    loading.value = true
    try {
      const d = await getProviders()
      providers.value = d.providers
      currentId.value = d.currentId
      currentModel.value = d.currentModel
      tiers.value = {
        creative: { ...d.tiers.creative },
        assistant: d.tiers.assistant ? { ...d.tiers.assistant } : null,
        chat: d.tiers.chat ? { ...d.tiers.chat } : null,
      }
      revision.value = d.revision
    } catch {
      /* 设置页加载失败静默（面板显示空 + 可重试） */
    } finally {
      loading.value = false
    }
  }

  /** 刷新 RAG 提供方（独立端点）。 */
  async function refreshRag(): Promise<void> {
    ragLoading.value = true
    try {
      const d = await getRagProviders()
      ragProviders.value = d.ragProviders
      revision.value = d.revision
    } catch {
      /* 静默 */
    } finally {
      ragLoading.value = false
    }
  }

  /**
   * 拉取提供方模型清单（幂等去重 + 探测模型回落 + 手动重试）。
   * @param opts.fallbackModel 全局当前模型在清单内时优先作探测默认
   * @param opts.force 已有缓存也重拉（「获取模型列表」手动重试）
   */
  async function ensureModels(
    p: { id: string },
    opts: { fallbackModel?: string; force?: boolean; silent?: boolean } = {},
  ): Promise<void> {
    if (fetchingModelIds.has(p.id)) return
    if (!opts.force && modelsByProvider.value.has(p.id)) return
    fetchingModelIds.add(p.id)
    try {
      const r = await fetchModels({ id: p.id })
      modelsByProvider.value.set(p.id, r.models)
      const cur = probeModels.value.get(p.id) ?? ''
      if (!cur || !r.models.includes(cur)) {
        const fallback = opts.fallbackModel && r.models.includes(opts.fallbackModel) ? opts.fallbackModel : (r.models[0] ?? '')
        probeModels.value.set(p.id, fallback)
      }
      if (!opts.silent) ui.toast(`已获取 ${r.models.length} 个模型`, 'success')
    } catch (e) {
      if (!opts.silent) ui.toast(errText(e), 'error')
      // dd-P2：失败保留旧缓存——force 重拉失败不清空已成功清单
    } finally {
      fetchingModelIds.delete(p.id)
    }
  }

  /** 新增提供方（P4：带 expectedRevision）；成功返回新提供方 id，失败返回 null。 */
  async function add(input: { name: string; protocol: ProviderConfDto['protocol']; auth: ProviderConfDto['auth']; baseUrl: string; apiKey: string; models?: ModelConfDto[] }): Promise<string | null> {
    try {
      const r = await createProvider({ ...input, auth: input.auth, expectedRevision: revision.value })
      providers.value.push(r.provider)
      revision.value = r.revision
      if (!currentId.value) {
        // 首个提供方自动设为当前
        currentId.value = r.provider.id
      }
      ui.toast('已保存', 'success')
      return r.provider.id
    } catch (e) {
      ui.toast(errText(e), 'error')
      return null
    }
  }

  /** 编辑提供方（P4；models 未变可不传 → 服务端保留原行）。 */
  async function update(id: string, input: { name: string; protocol: ProviderConfDto['protocol']; auth: ProviderConfDto['auth']; baseUrl: string; apiKey: string; models?: ModelConfDto[] }): Promise<boolean> {
    try {
      const r = await updateProvider(id, { ...input, auth: input.auth, expectedRevision: revision.value })
      const i = providers.value.findIndex((p) => p.id === id)
      if (i >= 0) providers.value[i] = r.provider
      revision.value = r.revision
      ui.toast('已保存', 'success')
      return true
    } catch (e) {
      ui.toast(errText(e), 'error')
      return false
    }
  }

  /** 删除提供方（P4）；返回成功与否（成功后 currentId 已由响应更新）。 */
  async function remove(id: string): Promise<boolean> {
    try {
      const r = await deleteProvider(id, revision.value)
      providers.value = providers.value.filter((p) => p.id !== id)
      currentId.value = r.currentId
      modelsByProvider.value.delete(id)
      probeModels.value.delete(id)
      revision.value = r.revision
      ui.toast('已删除', 'success')
      return true
    } catch (e) {
      ui.toast(errText(e), 'error')
      return false
    }
  }

  /** 设为当前启用（P2 caps 守卫 + P4）。 */
  async function activate(id: string): Promise<void> {
    try {
      const r = await setCurrentProvider(id, revision.value)
      currentId.value = id
      // PUT /current saveProviders bump revision——同步前端，避免后续写因陈旧 expectedRevision 409（P4）
      if (typeof r.revision === 'number') revision.value = r.revision
    } catch (e) {
      ui.toast(errText(e), 'error')
    }
  }

  /** 测试连接（探测依赖测试选择模型；失败不清除旧结果）。 */
  async function test(id: string, model: string | undefined): Promise<void> {
    testing.value = id
    try {
      const r = await testProvider(id, model || undefined)
      const s = new Map(testResults.value)
      s.set(id, r)
      testResults.value = s
      // 探测写回 bump 了服务端 revision——同步前端，避免测试后任意写因陈旧 expectedRevision 409（P4）
      if (typeof r.revision === 'number') revision.value = r.revision
      // caps 就地写回 provides[i]，让行卡 caps 徽章（绿/红/未测试）即时回显——
      // 等价旧 refresh() 的「caps 落库」语义，免整表重拉（此前徽章不刷新，回归被 e2e 命中）
      const i = providers.value.findIndex((p) => p.id === id)
      if (i >= 0) {
        providers.value[i] = { ...providers.value[i]!, caps: r.caps ?? null, capsProbedAt: Date.now() }
      }
    } catch (e) {
      // testProvider 出错即非 ok 结果
      const s = new Map(testResults.value)
      s.set(id, { ok: false, error: errText(e) })
      testResults.value = s
    } finally {
      testing.value = null
    }
  }

  /** 保存任务档位（创作/助手）+ P4。 */
  async function saveTiers(input: { creative: TierSlot; assistant: TierSlot | null }): Promise<boolean> {
    try {
      const r = await setTiers({ ...input, expectedRevision: revision.value })
      tiers.value = {
        creative: { ...r.tiers.creative },
        assistant: r.tiers.assistant ? { ...r.tiers.assistant } : null,
        chat: r.tiers.chat ? { ...r.tiers.chat } : null,
      }
      currentModel.value = r.tiers.creative.model || null
      revision.value = r.revision
      return true
    } catch (e) {
      ui.toast(errText(e), 'error')
      return false
    }
  }

  /** 对话档切换（写档即生效，不引 full refresh；P4 带 expectedRevision）。 */
  async function applyChatTier(slot: TierSlot | null): Promise<void> {
    try {
      const r = await setChatTier(slot, revision.value)
      tiers.value = { ...tiers.value, chat: r.tiers.chat ? { ...r.tiers.chat } : null }
      revision.value = r.revision
    } catch (e) {
      ui.toast(`档位保存失败，重开后将回落旧档：${errText(e)}`, 'error')
    }
  }

  // ── RAG ──
  async function addRag(input: { name: string; endpoint: string; model: string; apiKey: string }): Promise<boolean> {
    try {
      const r = await createRagProvider({ ...input, expectedRevision: revision.value })
      ragProviders.value.push(r.provider)
      revision.value = r.revision
      ui.toast('已保存', 'success')
      return true
    } catch (e) {
      ui.toast(errText(e), 'error')
      return false
    }
  }

  async function updateRag(id: string, input: { name: string; endpoint: string; model: string; apiKey: string }): Promise<boolean> {
    try {
      const r = await updateRagProvider(id, { ...input, expectedRevision: revision.value })
      const i = ragProviders.value.findIndex((p) => p.id === id)
      if (i >= 0) ragProviders.value[i] = r.provider
      revision.value = r.revision
      ui.toast('已保存', 'success')
      return true
    } catch (e) {
      ui.toast(errText(e), 'error')
      return false
    }
  }

  async function removeRag(id: string): Promise<boolean> {
    try {
      const r = await deleteRagProvider(id, revision.value)
      ragProviders.value = ragProviders.value.filter((p) => p.id !== id)
      revision.value = r.revision
      ui.toast('已删除', 'success')
      return true
    } catch (e) {
      ui.toast(errText(e), 'error')
      return false
    }
  }

  async function testRag(id: string): Promise<void> {
    ragTesting.value = id
    try {
      const r = await testRagProvider(id)
      const m = new Map(ragTestResults.value)
      m.set(id, r)
      ragTestResults.value = m
    } catch (e) {
      const m = new Map(ragTestResults.value)
      m.set(id, { ok: false, error: errText(e) })
      ragTestResults.value = m
    } finally {
      ragTesting.value = null
    }
  }

  /** 面板整页加载（设置页打开：AI + RAG 一并拉）。 */
  async function refreshAll(): Promise<void> {
    await Promise.all([refresh(), refreshRag()])
  }

  return {
    // state
    providers, currentId, currentModel, tiers, revision, loading, testing, testResults, probeModels, modelsByProvider,
    ragProviders, ragLoading, ragTesting, ragTestResults,
    // getters
    currentProvider, configModels, currentModels, chatActiveModel, chatActiveEffort,
    // actions
    refresh, refreshRag, refreshAll, ensureModels, add, update, remove, activate, test, saveTiers, applyChatTier,
    addRag, updateRag, removeRag, testRag,
  }
})