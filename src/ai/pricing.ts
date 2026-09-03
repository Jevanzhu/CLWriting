/**
 * D2（批 5）价格表与金额口径——providers.json 加性扩展（P9-①）。
 *
 * 形状（加性，读侧缺省行为全部不变）：
 *   providers[].pricing?  = { inputPerMTok, outputPerMTok, cacheReadPerMTok?, cacheWritePerMTok?, currency? }
 *   providers[].models[].pricing?  覆盖（读侧缺省 = 继承 provider 级）
 * 单位：每百万 token 单价。同 provider 混挂不同价模型（如 cache 支持差异）是
 * 现实场景——models[] 级覆盖就是为此（P9 拍板①）。
 *
 * 预算口径（D3）：cost 累计假设全书价格币种一致（currency 首个命中者为准，
 * 币种不同的价格表混用属配置错误，数值比较仍成立但金额不可加总展示）。
 */
import type { ProviderConf, ModelConf, TokenUsage } from './provider/types.js'
import { loadProviders } from './provider/index.js'

/** 价格表（每百万 token 单价；currency 缺省 USD） */
export interface PricingConf {
  inputPerMTok?: number
  outputPerMTok?: number
  cacheReadPerMTok?: number
  cacheWritePerMTok?: number
  currency?: string
}

/** 合法价格表判定：至少一个单价键为正数 */
export function isPriced(p: PricingConf | undefined | null): p is PricingConf {
  if (!p) return false
  return (
    (typeof p.inputPerMTok === 'number' && p.inputPerMTok > 0) ||
    (typeof p.outputPerMTok === 'number' && p.outputPerMTok > 0) ||
    (typeof p.cacheReadPerMTok === 'number' && p.cacheReadPerMTok > 0) ||
    (typeof p.cacheWritePerMTok === 'number' && p.cacheWritePerMTok > 0)
  )
}

/** R42-23（四十二轮）：行 pricing 是否含任一已知键（单价族或 currency）——参与浅合并的
 *  判定，与 isPriced（是否计价）解耦：仅设 currency 的行参与合并（currency 生效）但
 *  不单独构成计价。 */
function hasAnyPricingKey(p: PricingConf | undefined | null): boolean {
  if (!p) return false
  return (
    p.inputPerMTok !== undefined ||
    p.outputPerMTok !== undefined ||
    p.cacheReadPerMTok !== undefined ||
    p.cacheWritePerMTok !== undefined ||
    p.currency !== undefined
  )
}

/** 模型行 → 价格表合并（models[].pricing 覆盖 provider 级同名键） */
export function pricingForProvider(provider: ProviderConf | undefined, model: string): PricingConf | null {
  if (!provider) return null
  const base = isPriced(provider.pricing) ? provider.pricing : {}
  const row: ModelConf | undefined = provider.models?.find((m) => m.id === model)
  // R42-23（四十二轮）：行 override 判定放宽——行 pricing 含任一已知键（单价族或 currency）
  // 即参与浅合并。此前 isPriced(row.pricing) 才认，「仅设 currency 无单价」的行被整行丢弃，
  // currency 永不生效；最终仍以 isPriced(merged) 决定计价——只有 currency 的行不计费
  const override = hasAnyPricingKey(row?.pricing) ? row!.pricing : undefined
  const merged = { ...base, ...(override ?? {}) }
  return isPriced(merged) ? merged : null
}

/**
 * 全局解析：按模型 id 找所属 provider（models[] 含 id 者）→ 该行价格——归属 provider
 * 未配价即为未配价（宁缺毋滥），不得落到别家价格表（跨 provider 借价会让成本/预算
 * 全按错误单价折算，切当前 provider 还会追溯改写历史折算）。
 * 无归属行 → 当前启用 provider 的 provider 级价格（网关下未知模型按网关价）；
 * currentId 失效或两级皆无 → null（未配价）。
 * 静默容错：providers.json 读失败 → null（价格是增强，不做故障源）。
 */
export function resolveModelPricing(userDataPath: string | null | undefined, model: string): PricingConf | null {
  if (!userDataPath || !model) return null
  try {
    const store = loadProviders(userDataPath)
    // R42-2（四十二轮）：归属查表先在当前启用 provider 的 models[] 内找归属行——双
    // provider 挂同模型 id 不同价时按当前启用的那家计价（此前全局首归属 find 固定命中
    // 数组靠前的 provider，切 currentId 后计价不换）；未命中再回落全局首归属 find
    const current = store.providers.find((p) => p.id === store.currentId)
    const owner = current?.models?.some((m) => m.id === model)
      ? current
      : store.providers.find((p) => p.models?.some((m) => m.id === model))
    if (owner) return pricingForProvider(owner, model)
    return current ? pricingForProvider(current, model) : null
  } catch {
    return null
  }
}

/** 单次调用金额（按价格表四档分计；未配价的档位不计费=0） */
export function computeCallCost(
  pricing: PricingConf | null,
  usage: Pick<TokenUsage, 'inputTokens' | 'outputTokens'> & Partial<Pick<TokenUsage, 'cacheReadTokens' | 'cacheWriteTokens'>>,
): number | null {
  if (!pricing) return null
  const cost =
    (usage.inputTokens / 1e6) * (pricing.inputPerMTok ?? 0) +
    (usage.outputTokens / 1e6) * (pricing.outputPerMTok ?? 0) +
    ((usage.cacheReadTokens ?? 0) / 1e6) * (pricing.cacheReadPerMTok ?? 0) +
    ((usage.cacheWriteTokens ?? 0) / 1e6) * (pricing.cacheWritePerMTok ?? 0)
  // 归一到 1e-10（浮点累加噪声不进记账）
  return Math.round(cost * 1e10) / 1e10
}
