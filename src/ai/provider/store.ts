/**
 * providers.json 读写——应用级（userDataPath），跨书共享（方案 §四①）。
 *
 * 不进书库目录：供应商是「这台机器的作者用什么服务」，不是「这本书的属性」。
 * 书库可能进 git，凭据不能跟着走。
 *
 * S4 加密落地（凭据存储设计 §四–七）：
 * - API Key 经 vault 信封加密（HKDF→KEK→DEK→AES-GCM），不明文落盘
 * - 加解密只发生在 load/save 边界，内存中 ProviderConf 仍含明文 apiKey
 * - 上层 API（providers.ts）零改动
 * - load 时自动迁移明文→密文 + 半迁移状态收敛（§五）
 *
 * 写入健壮性（原子写/备份/损坏不静默）属于 S5，本文件仅做 chmod 0600。
 */
import { readFileSync, mkdirSync, existsSync, chmodSync, copyFileSync, statSync } from 'node:fs'
import { atomicWriteFile } from '../../fs/atomic.js'
import { dirname, join } from 'node:path'
import type { ProviderConf, ModelCaps, TierSlot, TierConfig } from './types.js'
import { builtinKeyMaterial } from './vault-key.js'
import {
  createVault,
  openVault,
  sealKey,
  openKey,
  type Vault,
} from './vault.js'

const FILE = 'providers.json'

/**
 * mtime 缓存——避免每次 AI 生成重复 readFileSync + AES-256-GCM 解密。
 * saveProviders 写后失效；外部改动经 mtime 检测自动失效。
 */
let _cache: { path: string; store: ProviderStore; mtime: number } | null = null

/** 深拷贝 store——structuredClone 将 Buffer 降级为 Uint8Array，dek 须恢复（P2-AI-1） */
function cloneStore(store: ProviderStore): ProviderStore {
  const cloned = structuredClone(store)
  if (cloned.dek) cloned.dek = Buffer.from(cloned.dek)
  return cloned
}

/**
 * 内存中的供应商存储——ProviderSettings 超集。
 *
 * load 时解密得到明文 apiKey + vault/dek（复用避免重解）；
 * save 时用 dek 加密、剥离明文、写回 vault。
 * vault/dek 为 null 表示无存量 vault（首次启动 / 全新配置）。
 */
export interface ProviderStore {
  providers: ProviderConf[] // 含明文 apiKey（仅内存）
  currentId: string | null
  currentModel: string | null // 全局模型选择（方案 A：model 独立于供应商）
  /** 模型级 caps 缓存：key = `${providerId}/${model}` */
  modelCaps: Record<string, ModelCaps>
  /** 任务档位（D 档：创作档/助手档；端点按任务类型取档） */
  tiers: TierConfig
  vault: Vault | null
  dek: Buffer | null
}

/** 默认档位配置（首次启动 / 文件无 tiers 字段时） */
function defaultTiers(model: string | null): TierConfig {
  return {
    creative: { model: model ?? '', effort: 'xhigh' },
    assistant: null,
    chat: null,
  }
}

/** 空 store（首次启动 / 文件缺失时） */
export function emptySettings(): ProviderStore {
  return { providers: [], currentId: null, currentModel: null, modelCaps: {}, tiers: defaultTiers(null), vault: null, dek: null }
}

/** 磁盘文件结构——providers 不含 apiKey，密文统一在 vault.keys */
interface DiskFormat {
  providers: Array<Omit<ProviderConf, 'apiKey'> & { apiKey?: string }>
  currentId: string | null
  currentModel?: string | null
  modelCaps?: Record<string, ModelCaps>
  tiers?: TierConfig
  vault?: Vault
}

/**
 * 读 providers.json → 解密 → ProviderStore（含明文 apiKey）。
 *
 * 解密失败（版本过高 / 认证失败）抛错——S5 会兜住"损坏不静默"，
 * 当前版本向上传播，由调用方（server API）转成错误响应。
 */
export function loadProviders(userDataPath: string): ProviderStore {
  const fp = `${userDataPath}/${FILE}`
  if (!existsSync(fp)) {
    _cache = null
    return emptySettings()
  }

  // mtime 缓存命中——跳过 readFileSync + vault 解密（高频 AI 生成场景核心优化）
  // P2-SEC-4：返回副本而非同一引用——调用方（API 端点）会直接 mutate store 后 saveProviders，
  // 若缓存返回原引用，未 save 的中间态会泄漏给后续 loadProviders 调用方
  try {
    const mtime = statSync(fp).mtimeMs
    if (_cache && _cache.path === fp && _cache.mtime === mtime) return cloneStore(_cache.store)
  } catch {
    _cache = null
  }

  let raw: DiskFormat
  try {
    raw = JSON.parse(readFileSync(fp, 'utf8')) as DiskFormat
  } catch (e) {
    // D6：损坏不静默——保留原文件、向上报错（router 全局 catch 转 500 响应）
    throw new Error(`providers.json 解析失败，文件可能损坏：${e instanceof Error ? e.message : ''}`)
  }
  if (!Array.isArray(raw.providers)) return emptySettings()

  const vault: Vault | null = raw.vault ?? null
  let dek: Buffer | null = null

  if (vault) {
    // 版本守卫 + HKDF 派生 KEK + 解封 DEK（可能抛 VaultVersionError / VaultDecryptError）
    dek = openVault(vault, builtinKeyMaterial())
  }

  // 逐条提取明文 apiKey，按 §五半迁移规则收敛
  let needsRewrite = false
  const providers: ProviderConf[] = raw.providers.map((p) => {
    const conf = { ...p, apiKey: '' } as ProviderConf
    if (vault && dek && vault.keys[conf.id]) {
      // vault 有 → 解密（vault 永远优先）
      conf.apiKey = openKey(dek, vault.keys[conf.id]!)
      // 残留明文 apiKey 字段 → 标记清理
      if (p.apiKey) needsRewrite = true
    } else if (p.apiKey) {
      // vault 缺该条目但明文有 → 补迁移
      conf.apiKey = p.apiKey
      needsRewrite = true
    }
    return conf
  })

  // 无 vault 但有明文 apiKey → 全量首次迁移
  if (!vault && providers.some((p) => p.apiKey)) {
    needsRewrite = true
  }

  const store: ProviderStore = { providers, currentId: raw.currentId ?? null, currentModel: raw.currentModel ?? null, modelCaps: raw.modelCaps ?? {}, tiers: raw.tiers ?? defaultTiers(raw.currentModel ?? null), vault, dek }

  // 迁移写回——剥离明文、加密进 vault（§五）
  if (needsRewrite) {
    saveProviders(userDataPath, store)
  }

  // 更新 mtime 缓存
  try {
    _cache = { path: fp, store, mtime: statSync(fp).mtimeMs }
  } catch { /* 迁移写后 stat 失败忽略，下次 loadProviders 自然 miss */ }

  // P2-AI-3：缓存未命中也返回 clone（与缓存命中路径 structuredClone 一致）——
  // 否则调用方（API 端点）直接 mutate store 后 saveProviders 前，未保存的中间态会泄漏给后续 loadProviders
  return cloneStore(store)
}

/**
 * 写 providers.json——加密 apiKey 进 vault + 剥离明文 + chmod 0600。
 *
 * 每次 save 以 providers 列表为准重建 vault.keys（D4：删除的 provider 自动清除密文）。
 * 若 store 无 vault（首次 / 迁移），创建新 vault + 随机 DEK。
 */
export function saveProviders(userDataPath: string, store: ProviderStore): void {
  const fp = `${userDataPath}/${FILE}`
  mkdirSync(dirname(fp), { recursive: true })

  // 确保 vault + DEK（首次创建或迁移时新建）
  let vault = store.vault
  let dek = store.dek
  if (!vault || !dek) {
    const created = createVault(builtinKeyMaterial())
    vault = created.vault
    dek = created.dek
    store.vault = vault
    store.dek = dek
  }

  // 以 providers 为准重建 vault.keys——加密每个 apiKey
  vault.keys = {}
  const diskProviders = store.providers.map((p) => {
    if (p.apiKey) {
      vault!.keys[p.id] = sealKey(dek!, p.apiKey)
    }
    // 剥离明文 apiKey（落盘不含）
    return { ...p, apiKey: undefined } as Omit<ProviderConf, 'apiKey'>
  })

  const disk: DiskFormat = { providers: diskProviders, currentId: store.currentId, currentModel: store.currentModel, modelCaps: store.modelCaps, tiers: store.tiers, vault }
  const json = JSON.stringify(disk, null, 2) + '\n'

  // D7：写前备份（文件已存在时）——同权限 0600
  if (existsSync(fp)) {
    const bak = join(dirname(fp), 'providers.bak.json')
    copyFileSync(fp, bak)
    try {
      chmodSync(bak, 0o600)
    } catch {
      // Windows / 某些 FS 不支持 chmod；备份成功即可
    }
  }

  // D5+D8：原子写（atomicWriteFile: PID+UUID tmp 防冲突 + fsync 落盘）→ chmod 0600 收敛凭据权限
  atomicWriteFile(fp, json, { fsync: true })
  try {
    chmodSync(fp, 0o600)
  } catch {
    // Windows / 某些 FS 不支持 chmod
  }

  // 写后失效缓存（下次 loadProviders 自动重读 + 更新缓存）
  _cache = null
}

/** 当前启用的供应商；未配置 / currentId 指向已删条目 → null */
export function currentProvider(userDataPath: string): ProviderConf | null {
  const s = loadProviders(userDataPath)
  if (!s.currentId) return null
  return s.providers.find((p) => p.id === s.currentId) ?? null
}

/** 设置全局当前模型 */
export function setCurrentModel(userDataPath: string, model: string): void {
  const s = loadProviders(userDataPath)
  s.currentModel = model
  saveProviders(userDataPath, s)
}

/** 模型级 caps（按 providerId+model 缓存）；未探测 → null */
export function getModelCaps(userDataPath: string, providerId: string, model: string): ModelCaps | null {
  return loadProviders(userDataPath).modelCaps[`${providerId}/${model}`] ?? null
}

/** 写入模型级 caps（选模型探测后调用） */
export function setModelCaps(userDataPath: string, providerId: string, model: string, caps: ModelCaps): void {
  const s = loadProviders(userDataPath)
  s.modelCaps[`${providerId}/${model}`] = caps
  saveProviders(userDataPath, s)
}

/** 从已加载 store 算档位（纯函数，不读磁盘——供 resolveProvider 复用，避免重复 loadProviders） */
export function tierFromStore(s: ProviderStore, kind: 'creative' | 'assistant' | 'chat'): TierSlot {
  const fallback = s.currentModel ?? ''
  if (kind === 'assistant' && s.tiers.assistant) {
    return s.tiers.assistant.model ? s.tiers.assistant : { ...s.tiers.assistant, model: fallback }
  }
  if (kind === 'chat' && s.tiers.chat) {
    return s.tiers.chat.model ? s.tiers.chat : { ...s.tiers.chat, model: fallback }
  }
  return s.tiers.creative.model ? s.tiers.creative : { ...s.tiers.creative, model: fallback }
}

/** 取档位配置（assistant/chat 未配 / model 为空 → 回落 creative + currentModel） */
export function resolveTier(userDataPath: string | null, kind: 'creative' | 'assistant' | 'chat'): TierSlot {
  if (!userDataPath) return { model: '', effort: 'xhigh' }
  return tierFromStore(loadProviders(userDataPath), kind)
}

/** 新供应商 ID */
export function newProviderId(): string {
  return `prov-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** key 遮蔽：只留前 4 后 4，不足 8 位 → *** */
export function maskKey(key: string): string {
  if (key.length < 8) return '***'
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}
