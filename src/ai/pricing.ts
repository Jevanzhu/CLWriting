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
import { statSync } from 'node:fs'
import { join } from 'node:path'
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
  // R48-28（四十八轮）：provider 级 base 判定与行侧 R42-23 对齐（hasAnyPricingKey）——
  // 原 isPriced 把「仅声明 currency」的 provider 级价格表整块丢弃，provider 声明
  // currency + 模型行只配单价时币种静默回落 USD（CostStats.currency 标错币种）；
  // 最终计价仍由 isPriced(merged) 把关，仅 currency 不会单独构成计价
  const base = hasAnyPricingKey(provider.pricing) ? provider.pricing : {}
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
// PM-11（性能与内存专项·2026-09-05）：解析结果 memo（providers.json mtime 指纹键控）。
// loadProviders 自带 mtime 缓存已免重复读盘+解密，但每次仍整克隆 store（P2-SEC-4 副本
// 纪律，不可共享引用）+ 线性归属查找；每次 token 记账都经此解析，memo 后命中路径仅一次
// stat。失效：文件 mtime 变（saveProviders 落盘即 bump）；mtime 粒度内连续改写的陈旧窗
// 与 loadProviders 缓存同级（既有口径）。文件名单源在 provider/store.ts FILE 常量（未
// 导出，此处镜像维护——改文件名须两处联动）。FIFO 上限防多书库/多模型无界。
const PRICING_MEMO_MAX = 32
const pricingMemo = new Map<string, { sig: string; value: PricingConf | null }>()
function providersPricingSig(userDataPath: string): string {
  try {
    return String(statSync(join(userDataPath, 'providers.json')).mtimeMs)
  } catch {
    return 'missing'
  }
}

export function resolveModelPricing(userDataPath: string | null | undefined, model: string): PricingConf | null {
  if (!userDataPath || !model) return null
  const memoKey = `${userDataPath}\u0000${model}`
  const sig = providersPricingSig(userDataPath)
  const memoHit = pricingMemo.get(memoKey)
  if (memoHit && memoHit.sig === sig) return memoHit.value
  try {
    const store = loadProviders(userDataPath)
    // R42-2（四十二轮）：归属查表先在当前启用 provider 的 models[] 内找归属行——双
    // provider 挂同模型 id 不同价时按当前启用的那家计价（此前全局首归属 find 固定命中
    // 数组靠前的 provider，切 currentId 后计价不换）；未命中再回落全局首归属 find
    const current = store.providers.find((p) => p.id === store.currentId)
    const owner = current?.models?.some((m) => m.id === model)
      ? current
      : store.providers.find((p) => p.models?.some((m) => m.id === model))
    const resolved = owner
      ? pricingForProvider(owner, model)
      : current
        ? pricingForProvider(current, model)
        : null
    if (pricingMemo.size >= PRICING_MEMO_MAX) {
      const oldest = pricingMemo.keys().next().value
      if (oldest !== undefined) pricingMemo.delete(oldest)
    }
    pricingMemo.set(memoKey, { sig, value: resolved })
    return resolved
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
