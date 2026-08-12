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
  ModelCaps,
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
  ModelProbeResult,
} from './types.js'

export { PRESETS, type ProviderPreset } from './presets.js'
export {
  loadProviders,
  saveProviders,
  currentProvider,
  setCurrentModel,
  getModelCaps,
  setModelCaps,
  resolveTier,
  tierFromStore,
  emptySettings,
  newProviderId,
  maskKey,
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
export { createProvider, probeCapabilities, probeModelCaps } from './probe.js'
export { detectFamily, quirksFor, type ChatQuirks, type ModelFamily } from './model-quirks.js'
export { createAnthropicProvider } from './anthropic-adapter.js'
export { createOpenAIProvider, createOpenAIProviderChat } from './openai-adapter.js'
export { createOpenAIResponsesProvider } from './responses-adapter.js'
