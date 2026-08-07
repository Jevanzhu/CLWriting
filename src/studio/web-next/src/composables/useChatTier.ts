/**
 * 对话档位（模型 + 推理等级）composable。
 * ChatPanel 与 ChatDock 输入框共用：读对话档（未配回落创作档），切换即持久化。
 * 后端：PUT /api/tiers/chat 单档端点。
 */
import { ref, computed, reactive } from 'vue'
import { getProviders, setChatTier, fetchModels, type TierSlot, type EffortLevel } from '../api/providers'

export const EFFORT_LEVELS: EffortLevel[] = ['max', 'xhigh', 'high', 'medium', 'low']

// 模块级单例：ChatPanel + ChatDock 共享，避免重复 getProviders/fetchModels（P2-N）
let _instance: { tier: ReturnType<typeof _createChatTier>; loaded: boolean } | null = null
export function useChatTier() {
  if (!_instance) {
    const tier = _createChatTier()
    _instance = { tier, loaded: false }
    // P2-10：模块单例首次创建即加载（不绑 onMounted——那是组件生命周期，单例命令首次调用组件）
    void tier.refresh()
  }
  return _instance.tier
}
function _createChatTier() {
  const models = ref<string[]>([])
  const chatTier = ref<TierSlot | null>(null)
  const creativeTier = ref<TierSlot | null>(null)
  const tierLoading = ref(false)

  /** 当前生效模型（对话档优先，回落创作档） */
  const activeModel = computed(() => chatTier.value?.model || creativeTier.value?.model || '')
  /** 当前生效推理等级 */
  const activeEffort = computed(() => chatTier.value?.effort || creativeTier.value?.effort || 'low')

  async function refresh(): Promise<void> {
    tierLoading.value = true
    try {
      const data = await getProviders()
      chatTier.value = data.tiers.chat ? { ...data.tiers.chat } : null
      creativeTier.value = data.tiers.creative ? { ...data.tiers.creative } : null
      if (data.currentId) {
        try {
          const r = await fetchModels({ id: data.currentId })
          models.value = r.models
        } catch {
          models.value = []
        }
      }
    } catch {
      /* 静默——档位显示不阻断对话 */
    } finally {
      tierLoading.value = false
    }
  }

  /** 切换模型/推理等级 → 立即生效（写对话档；未配则从创作档继承创建） */
  async function applyTier(model: string, effort: EffortLevel): Promise<void> {
    const slot: TierSlot = { model, effort }
    chatTier.value = slot
    try {
      await setChatTier(slot)
    } catch {
      /* 保存失败不影响本地显示 */
    }
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