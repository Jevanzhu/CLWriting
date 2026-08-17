/**
 * RAG 配置解析——把「书级引用 + 应用级服务商」收敛成一次嵌入调用所需的实参。
 *
 * 两条来源链（优先级从高到低）：
 * 1. rag.provider（新）：查应用级 providers.json 的 ragProviders，endpoint/model/key 全来自服务商
 * 2. rag.endpoint + rag.model（旧版内联）：存量书兼容回落，key 走 env > .clwriting/rag.secret
 *
 * 两条链 env CLWRITING_RAG_API_KEY 都最高优先（运维覆盖一切落盘 key）。
 *
 * 服务商列表走参数注入（rag 域不 import ai 域，依赖方向干净；调用方从
 * loadProviders().ragProviders 取后传入），因此本函数是纯函数、可直接单测。
 */
import { readApiKey, envRagApiKey, type RagConfig } from './config.js'

/** 服务商引用——RagProviderConf 的结构子集（调用方注入，测试可直构） */
export interface RagProviderRef {
  id: string
  name?: string
  endpoint: string
  model: string
  apiKey: string
}

/** 解析结果（一次 buildIndex / recall 调用的全部实参） */
export interface ResolvedRag {
  endpoint: string
  model: string
  /** 可为空串——调用方按场景自行报错（未选服务商 / 服务商缺 Key 语义不同） */
  apiKey: string
  providerId?: string
  providerName?: string
  /** true = 旧版内联配置（endpoint/model 直存 book.yaml，UI 显示「沿用」） */
  legacy?: boolean
}

/**
 * 解析书的 RAG 配置为可调用实参。
 *
 * @returns null = 未启用 / 未选服务商且服务商已被删 / 新旧两条链都不完整（视为未配置）
 */
export function resolveRag(cfg: RagConfig, ragProviders: RagProviderRef[], workDir?: string): ResolvedRag | null {
  if (!cfg.enabled) return null

  if (cfg.provider) {
    const p = ragProviders.find((x) => x.id === cfg.provider)
    if (!p) return null // 服务商不存在（被删）→ 视为未配置，不回落旧内联（避免静默换端点烧钱）
    return {
      endpoint: p.endpoint,
      model: p.model,
      apiKey: envRagApiKey() || p.apiKey,
      providerId: p.id,
      providerName: p.name,
    }
  }

  if (cfg.endpoint && cfg.model) {
    return {
      endpoint: cfg.endpoint,
      model: cfg.model,
      apiKey: envRagApiKey() || (workDir ? (readApiKey(workDir) ?? '') : ''),
      legacy: true,
    }
  }

  return null
}
