/**
 * 适配器注册表（批次 D2，学 cherry-studio ProviderExtension 注册表）。
 *
 * 声明式条目 `{ name, aliases, create }`——新增协议 = 加一行条目，
 * 不再改 switch；adapterFamily 字符串（协议名 + 别名）成为唯一运行时路由键。
 *
 * 实例缓存按 settings hash（学 cherry computeHash + LRU）：
 * - 每次 AI 生成不再重建 SDK 客户端对象；
 * - **配置 + 适配器原子绑定**（学 cherry prepareCall「配置与当时捕获的适配器绑定
 *   防注册漂移」）：入参 conf 在创建时浅拷贝为 bound conf，调用方事后改自己的
 *   对象不影响已绑定实例；hash 覆盖适配器消费的全部字段，配置变 → 新实例，
 *   命中缓存则配置与实例严格一一对应，无漂移。
 *
 * 与 cherry 的有意分歧：cherry 的 create 是 `async (await import(...))` 懒加载——
 * CLWriting 的 createProvider 是同步 API（runner resolveProvider 同步返回），
 * 动态 import 装不进同步签名，故条目持同步工厂；SDK 包本就随 provider/index.ts
 * 静态加载，模块加载面无回退。
 */
import { createHash } from 'node:crypto'
import type { ProviderConf, Protocol, ModelProvider } from './types.js'
import type { ProviderStore } from './store.js'
import { createAnthropicProvider } from './anthropic-adapter.js'
import { createOpenAIProviderChat } from './openai-adapter.js'
import { createOpenAIResponsesProvider } from './responses-adapter.js'

/** 注册表条目——一行声明一个协议适配器 */
export interface AdapterEntry {
  /** 主路由键 = Protocol */
  name: Protocol
  /** 别名（中转/网关的 adapterFamily 叫法，小写；解析不出主名时兜底） */
  aliases: readonly string[]
  /** 同步工厂（见文件头「有意分歧」注）；userDataPath 为来源配置目录
   *  （R30-4：降级记忆通道按显式 path 分发，见 createProvider 注） */
  create(conf: ProviderConf, store?: ProviderStore, userDataPath?: string): ModelProvider
}

/** 全量注册表——新增协议在此加一行 */
export const ADAPTER_REGISTRY: readonly AdapterEntry[] = [
  {
    name: 'anthropic',
    aliases: ['anthropic-messages', 'claude'],
    create: (conf, store, userDataPath) => createAnthropicProvider(conf, undefined, store, userDataPath),
  },
  {
    name: 'openai',
    aliases: ['openai-chat', 'openai-completions', 'chat-completions'],
    create: (conf, store, userDataPath) => createOpenAIProviderChat(conf, undefined, store, userDataPath),
  },
  {
    // Responses 启用批（2026-08-17）回接——曾随 Z-P2-1 误判停用摘除
    name: 'openai-responses',
    aliases: ['openai-responses-api', 'responses'],
    create: (conf, store, userDataPath) => createOpenAIResponsesProvider(conf, undefined, store, userDataPath),
  },
]

/**
 * 路由键 → 条目。主名精确 → 别名精确 → null（宁缺勿错：
 * 拼错的键返回 null 报「未知协议」，绝不猜测近邻条目）。
 */
export function resolveAdapter(key: string): AdapterEntry | null {
  const k = key.trim().toLowerCase()
  return (
    ADAPTER_REGISTRY.find((e) => e.name === k) ??
    ADAPTER_REGISTRY.find((e) => e.aliases.includes(k)) ??
    null
  )
}

/**
 * settings hash——适配器消费的全部 conf 字段（id 进降级记忆键、model 进参数表
 * 查询、protocol/auth/baseUrl/apiKey 决定客户端；models 行影响 maxTokens/contextWindow 解析），
 * 固定字段序 → stringify 稳定。
 * name/notes/caps/sortIndex 等展示字段不入键（不影响适配器行为，入键白白击穿缓存）。
 * R30-4（三十轮）：userDataPath 入键——实例捕获来源 path 供降级记忆通道按 path 分发，
 * 同 conf 跨 path 不得复用实例（否则后 resolve 的库会借缓存实例把降级记忆写进他库）。
 */
function settingsHash(conf: ProviderConf, userDataPath?: string): string {
  const material = JSON.stringify({
    id: conf.id,
    protocol: conf.protocol,
    auth: conf.auth,
    baseUrl: conf.baseUrl,
    apiKey: conf.apiKey,
    model: conf.model ?? null,
    models: conf.models ?? null,
    userDataPath: userDataPath ?? null,
  })
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

/** LRU 上限（cherry QuickLRU maxSize=10 同量级——按书分库场景同时活跃的 provider 配置很少） */
const CACHE_CAPACITY = 8

const _cache = new Map<string, ModelProvider>()

/** 读时提升（Map 迭代序 = 插入序，get 后重插即 LRU） */
function cacheGet(hash: string): ModelProvider | undefined {
  const hit = _cache.get(hash)
  if (hit) {
    _cache.delete(hash)
    _cache.set(hash, hit)
  }
  return hit
}

function cachePut(hash: string, provider: ModelProvider): void {
  if (_cache.has(hash)) _cache.delete(hash)
  _cache.set(hash, provider)
  while (_cache.size > CACHE_CAPACITY) {
    const oldest = _cache.keys().next().value as string
    _cache.delete(oldest)
  }
}

/** 测试辅助：清实例缓存（防跨用例串味） */
export function clearProviderCache(): void {
  _cache.clear()
}

/** 测试辅助：缓存占用量 */
export function providerCacheSize(): number {
  return _cache.size
}

/**
 * 按 conf 创建/复用适配器实例（原 probe.ts 的 createProvider 迁入）。
 *
 * hash 命中 → 复用实例（原子绑定：其 bound conf 与本 conf 的行为字段全等）；
 * 未命中 → 路由 protocol → create（conf 浅拷贝绑定）→ 入缓存。
 * 降级记忆的新鲜度经 store.lookupDegraded 通道保证（见 store.ts 注释），
 * 不依赖缓存实例捕获的 store 快照。
 * R30-4（三十轮）：userDataPath 为来源配置目录——适配器降级记忆读/写按此显式 path
 * 分发（双库并发生成互不劫持，缺省回落 runner 侧活跃 path）；并参与实例缓存键
 * （同 conf 跨 path 不复用实例，见 settingsHash 注）。
 *
 * R33-21（三十三轮）：`opts.bypassCache` 供一次性旁路调用（流式探测把 model 换成
 * 列表首项，若入缓存会以「正常生成永不使用的 key」挤占 LRU 容量，把正常实例挤出
 * 重建）——探测等临时实例读缓存仍命中但不写入、不驱逐既有条目。
 */
export function createProvider(
  conf: ProviderConf,
  store?: ProviderStore,
  userDataPath?: string,
  opts?: { bypassCache?: boolean },
): ModelProvider {
  const hash = settingsHash(conf, userDataPath)
  if (!opts?.bypassCache) {
    const cached = cacheGet(hash)
    if (cached) return cached
  }

  const entry = resolveAdapter(conf.protocol)
  if (!entry) {
    // Protocol 是封闭联合类型，落到这里说明类型被绕过（JSON 直灌等）——显式报错不做猜测
    throw new Error(`未知协议适配器：${String(conf.protocol)}`)
  }
  // 原子绑定：适配器捕获 bound conf，调用方后续 mutate 自己的对象不影响本实例。
  // R26-22（二十六轮）：models 数组浅拷贝补齐——spread 只拷引用，调用方原地
  // mutate conf.models（push/改项）时缓存实例行为漂移而 settingsHash 不变
  //（缓存失效判定与实例状态脱钩）。数组新建浅拷元素（元素被视为不可变值）。
  const bound: ProviderConf = { ...conf, ...(conf.models ? { models: [...conf.models] } : {}) }
  const provider = entry.create(bound, store, userDataPath)
  if (!opts?.bypassCache) cachePut(hash, provider)
  return provider
}
