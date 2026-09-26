/**
 * Provider 抽象层入口（方案 §四①）。
 *
 * 按 ProviderConf.protocol 选适配器；currentProvider 从 providers.json 读当前启用的。
 */
export type {
  Protocol,
  AuthStrategy,
  ProviderConf,
  ProviderSettings,
  ProviderCaps,
  TierSlot,
  TierConfig,
  EffortLevel,
  GenRequest,
  ChatMsg,
  ContentBlock,
  ToolDef,
  GenEvent,
  StopReason, // 三线归一的停止原因判别联合
  TokenUsage,
  ModelProvider,
  ProbeResult,
  ModelConf,
  RagProviderConf,
  RagProviderCaps,
} from './types.js'


export {
  loadProviders,
  saveProviders,
  currentProvider,
  resolveTier,
  tierFromStore,
  emptySettings,
  newProviderId,
  newRagProviderId,
  maskKey,
  modelConfOf,
  registerDegradedPersist,
  persistDegraded,
  registerDegradedLookup,
  lookupDegraded,
  // 收编：原模块级 ForTest 缝（resetDegradedChannels/__clearProvidersCacheForTest/
  // __providersCacheSizeForTest/__seedProvidersWriteChainForTest）随 ProviderRuntime 端口
  // 实例化（processProviderRuntime.__resetForTest 等），不再出模块导出面
  ProviderRevisionConflictError, // 0918修复批（D002）：写前基线复验冲突错误（API 层 409 映射用）
  type ProviderStore,
} from './store.js'
export {
  createVault,
  openVault,
  sealKey,
  openKey,
  migrateVaultToOsChannel,
  VAULT_VERSION,
  VaultVersionError,
  VaultDecryptError,
  VaultOsKeyMissingError,
  type Vault,
  type SealedKey,
} from './vault.js'
export { probeCapabilities } from './probe.js'
export {
  createProvider,
  resolveAdapter,
  clearProviderCache,
  providerCacheSize,
  ADAPTER_REGISTRY,
  type AdapterEntry,
} from './registry.js'
export {
  detectFamily,
  quirksFor,
  responsesQuirksFor,
  type FamilyQuirks,
  type ModelFamily,
  type ResponsesWireQuirks,
} from './model-quirks.js'
export { createAnthropicProvider } from './anthropic-adapter.js'
// 原与 createOpenAIProviderChat 同义的薄壳别名 createOpenAIProvider 已删
// （两导出同名同义，调用方无法从名字判断该用哪个；单源留 carry 全形参的 createOpenAIProviderChat）。
export { createOpenAIProviderChat } from './openai-adapter.js'
export { createOpenAIResponsesProvider } from './responses-adapter.js'
export { normalizeApiKey, apiKeyRefusal, type ApiKeyCheck, type ApiKeyRejection } from './api-key.js'
// 三适配器流尾收口单点（done / 估计兜底 / 过滤判错 / 截断 / stopReason 归一）
export {
  createStreamFinalizer,
  normalizeStopReason,
  isStopReason,
  type StreamFinalizer,
  type StreamFinalizerOpts,
  type EstimateUsageSources,
  type WireLine,
} from './stream-finalize.js'
