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
  TokenUsage,
  ModelProvider,
  ProbeResult,
} from './types.js'


export {
  loadProviders,
  saveProviders,
  currentProvider,
  setCurrentModel,
  resolveTier,
  tierFromStore,
  emptySettings,
  newProviderId,
  maskKey,
  registerDegradedPersist,
  persistDegraded,
  registerDegradedLookup,
  lookupDegraded,
  resetDegradedChannels,
  type ProviderStore,
} from './store.js'
export {
  createVault,
  openVault,
  sealKey,
  openKey,
  VAULT_VERSION,
  VaultVersionError,
  VaultDecryptError,
  type Vault,
  type SealedKey,
} from './vault.js'
export { probeCapabilities } from './probe.js'
export { MODEL_CATALOG, MODEL_CATALOG_VERSION } from './catalog.gen.js'
export {
  createProvider,
  resolveAdapter,
  clearProviderCache,
  providerCacheSize,
  ADAPTER_REGISTRY,
  type AdapterEntry,
} from './registry.js'
export { detectFamily, quirksFor, type FamilyQuirks, type ModelFamily } from './model-quirks.js'
export { createAnthropicProvider } from './anthropic-adapter.js'
export { createOpenAIProvider, createOpenAIProviderChat } from './openai-adapter.js'
