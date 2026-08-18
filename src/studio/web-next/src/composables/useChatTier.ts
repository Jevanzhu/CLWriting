/**
 * 对话档位（模型 + 推理等级）composable。
 * ChatPanel 与 ChatDock 输入框共用：读对话档（未配回落创作档），切换即持久化。
 * 阶段 14 §6.3 统一 store 后此层降为 store 的薄视图——单例仍保留，兼容既有调用面。
 */
import { computed, reactive } from 'vue'
import type { TierSlot, EffortLevel } from '../api/providers'
import { useProviderStore } from '../stores/provider'

export const EFFORT_LEVELS: EffortLevel[] = ['max', 'xhigh', 'high', 'medium', 'low']

// 模块级单例：ChatPanel + ChatDock 共享（P2-N）；首建触发一次 store 装载
let _instance: { tier: ReturnType<typeof _createChatTier> } | null = null
export function useChatTier() {
  if (!_instance) {
    const tier = _createChatTier()
    _instance = { tier }
    // P2-10：单例首次创建即加载（不绑 onMounted——组件生命周期与单例无关）
    void tier.refresh()
  }
  return _instance.tier
}
function _createChatTier() {
  const store = useProviderStore()

  /** 模型清单（裸 id 数组；显示名请用 modelsOptions） */
  const models = computed<string[]>(() => store.currentModels.map((m) => m.value))
  /** 带显示名的选项（= 当前提供方已配置模型行 name ?? id，本地声明不打上游） */
  const modelsOptions = computed(() => store.currentModels)
  const chatTier = computed<TierSlot | null>(() => store.tiers.chat)
  const tierLoading = computed(() => store.loading)

  /** 当前生效模型（对话档优先，回落创作档） */
  const activeModel = computed(() => store.chatActiveModel)
  /** 当前生效推理等级 */
  const activeEffort = computed<EffortLevel>(() => store.chatActiveEffort)

  async function refresh(): Promise<void> {
    await store.refresh()
  }

  /** 切换模型/推理等级 → 立即生效（写对话档；未配则从创作档继承创建） */
  async function applyTier(model: string, effort: EffortLevel): Promise<void> {
    const slot: TierSlot = { model, effort }
    await store.applyChatTier(slot)
  }

  function onModelChange(e: Event): void {
    const m = (e.target as HTMLSelectElement).value
    if (m && m !== activeModel.value) void applyTier(m, activeEffort.value)
  }

  function onEffortChange(e: Event): void {
    const el = (e.target as HTMLSelectElement).value as EffortLevel
    if (activeModel.value) void applyTier(activeModel.value, el)
  }

  // reactive 包裹：模板里 tier.models / tier.activeModel 等嵌套 ref 自动解包
  return reactive({
    models,
    modelsOptions,
    chatTier,
    tierLoading,
    activeModel,
    activeEffort,
    applyTier,
    onModelChange,
    onEffortChange,
    refresh,
  })
}