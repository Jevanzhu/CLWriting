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
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ProviderConf, ProviderSettings } from './types.js'
import { builtinKeyMaterial } from './vault-key.js'
import {
  createVault,
  openVault,
  sealKey,
  openKey,
  VAULT_VERSION,
  VaultVersionError,
  type Vault,
} from './vault.js'

const FILE = 'providers.json'

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
  vault: Vault | null
  dek: Buffer | null
}

/** 空 store（首次启动 / 文件缺失时） */
export function emptySettings(): ProviderStore {
  return { providers: [], currentId: null, vault: null, dek: null }
}

/** 磁盘文件结构——providers 不含 apiKey，密文统一在 vault.keys */
interface DiskFormat {
  providers: Array<Omit<ProviderConf, 'apiKey'> & { apiKey?: string }>
  currentId: string | null
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
  if (!existsSync(fp)) return emptySettings()

  let raw: DiskFormat
  try {
    raw = JSON.parse(readFileSync(fp, 'utf8')) as DiskFormat
  } catch {
    // 文件损坏——S5 改为保留原文件 + 报错；当前版本静默返回空（D6 待修）
    return emptySettings()
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

  const store: ProviderStore = { providers, currentId: raw.currentId ?? null, vault, dek }

  // 迁移写回——剥离明文、加密进 vault（§五）
  if (needsRewrite) {
    saveProviders(userDataPath, store)
  }

  return store
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

  const disk: DiskFormat = { providers: diskProviders, currentId: store.currentId, vault }
  // 写时即设 0600——先写后 chmod 有 0644 窗口期（D8，S5 修）
  writeFileSync(fp, JSON.stringify(disk, null, 2) + '\n', 'utf8')
  try {
    chmodSync(fp, 0o600)
  } catch {
    // Windows / 某些 FS 不支持 chmod；写成功即可
  }
}

/** 当前启用的供应商；未配置 / currentId 指向已删条目 → null */
export function currentProvider(userDataPath: string): ProviderConf | null {
  const s = loadProviders(userDataPath)
  if (!s.currentId) return null
  return s.providers.find((p) => p.id === s.currentId) ?? null
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
