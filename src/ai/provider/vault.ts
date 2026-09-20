/**
 * Vault 加解密核心——凭据存储设计 §4.1–4.4。
 *
 * 信封结构：
 *   keyMaterial + vault.salt ──HKDF-SHA256──> KEK ──解开──> DEK ──AES-256-GCM──> 各个 API Key
 *
 * 两层意义（§4.1）：
 * - 换钥匙不用重新加密数据（改密码只需重新包一次 DEK）
 * - DEK 随机生成，数据加密强度不受内置密钥质量拖累
 *
 * 可注入设计（§4.3）：keyMaterial 以参数传入，单测可注入测试密钥。
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

/** 加密后的密封值（IV + 密文 + GCM 认证标签，均 base64） */
export interface SealedKey {
  iv: string
  ct: string
  tag: string
}

/**
 * Vault 落盘结构（凭据存储设计 §3.1）。
 *
 * - `v`：格式版本号，算法/参数变更时递增（§4.4）
 * - `salt`：每次创建 vault 随机生成，HKDF 派生 KEK 用
 * - `dek.byApp`：用内置 KEK 封装的 DEK（v1 内置混淆级通道）
 * - `dek.byOs`：用 OS 凭据 KEK 封装的 DEK（v2，0918三拍板批 KEK v2：safeStorage /
 *   Keychain/DPAPI 承载；两通道互斥不并存——v2 摘除 byApp，持制品攻击者不再可解）
 * - `keys[id]`：用 DEK 加密的各 API Key（provider id 为键）
 */
export interface Vault {
  v: number
  salt: string
  dek: { byApp?: SealedKey; byOs?: SealedKey }
  keys: Record<string, SealedKey>
}

/** 当前支持的 vault 格式版本（v2 起：os 通道为主；v1 仅读不新造——迁移链在 store） */
export const VAULT_VERSION = 2

/** HKDF info 串——隔离 KEK 派生用途（os 通道独立 info，域分离防两 KEK 同值） */
const KEK_INFO = 'clwriting-vault-kek'
const KEK_OS_INFO = 'clwriting-vault-kek-os'

/**
 * vault 版本不兼容（高于当前支持版本）——读取时遇到须报错，
 * 不得尝试解析或覆盖（§4.4：防用户在新旧版本间切换时被静默毁配置）。
 */
export class VaultVersionError extends Error {
  constructor(public readonly found: number) {
    super(`配置由更新版本（v${found}）创建，当前应用仅支持 v${VAULT_VERSION}`)
    this.name = 'VaultVersionError'
  }
}

/** AES-GCM 认证失败（密文被篡改 / 密钥不匹配） */
export class VaultDecryptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VaultDecryptError'
  }
}

/** 0918三拍板批（KEK v2）：v2 vault 在无 OS 凭据通道的环境打开——不是文件损坏，
 *  是环境缺通道（纯 node / env 未注入 / Keychain 不可用）；文案须与损坏形态可区分，
 *  引导用户从桌面应用启动。VaultDecryptError 子类：既有 catch 面零改动。 */
export class VaultOsKeyMissingError extends VaultDecryptError {}

// ── HKDF ─────────────────────────────────────────────

/** HKDF-SHA256 派生 KEK（32 字节），微秒级（§4.2）；info 按通道隔离（内置/os） */
function deriveKEK(keyMaterial: Buffer, salt: Buffer, info: string = KEK_INFO): Buffer {
  return Buffer.from(hkdfSync('sha256', keyMaterial, salt, info, 32))
}

// ── AES-256-GCM ──────────────────────────────────────

/** AES-256-GCM 加密（§4.2：IV 每次必须重新随机，12 字节）；aad 可选绑定上下文（R31-28） */
function sealAESGCM(key: Buffer, plaintext: Buffer, aad?: Buffer): SealedKey {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  if (aad) cipher.setAAD(aad)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: tag.toString('base64') }
}

/** AES-256-GCM 解密——认证失败抛 VaultDecryptError */
function openAESGCM(key: Buffer, sealed: SealedKey, aad?: Buffer): Buffer {
  try {
    const iv = Buffer.from(sealed.iv, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
    if (aad) decipher.setAAD(aad)
    return Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()])
  } catch {
    throw new VaultDecryptError('密文认证失败——文件损坏或密钥不匹配')
  }
}

// ── Vault 生命周期 ───────────────────────────────────

/**
 * 创建新 vault——生成随机 salt + 随机 DEK，用 KEK 封装 DEK（§4.1）。
 * 返回落盘 vault 结构 + 内存中的明文 DEK（不落盘）。
 *
 * 0918三拍板批（KEK v2）：osKeyMaterial 提供 → v2（仅 byOs 通道，OS 凭据承载；
 * keyMaterial 在 v2 分支不参与派生——保留参数为对称签名与未来混合通道预留）；
 * 缺省 → v1（仅 byApp 通道，纯 node / 无 OS 通道环境语义不变）。
 */
export function createVault(keyMaterial: Buffer, osKeyMaterial?: Buffer | null): { vault: Vault; dek: Buffer } {
  const salt = randomBytes(32)
  const dek = randomBytes(32)
  if (osKeyMaterial) {
    const kek = deriveKEK(osKeyMaterial, salt, KEK_OS_INFO)
    return {
      vault: {
        v: 2,
        salt: salt.toString('base64'),
        dek: { byOs: sealAESGCM(kek, dek) },
        keys: {},
      },
      dek,
    }
  }
  const kek = deriveKEK(keyMaterial, salt)
  return {
    vault: {
      v: 1,
      salt: salt.toString('base64'),
      dek: { byApp: sealAESGCM(kek, dek) },
      keys: {},
    },
    dek,
  }
}

/**
 * 打开已有 vault——版本守卫 + HKDF 派生 KEK + 解封 DEK。
 * v1 按 keyMaterial（内置混淆级通道）；v2 仅按 osKeyMaterial（OS 凭据通道，
 * byApp 已摘除——旧料不再可解，持制品攻击面收口）。
 * 抛 VaultVersionError（版本过高）/ VaultDecryptError（认证失败）/ 
 * VaultOsKeyMissingError（v2 而环境无 OS 通道）。
 */
export function openVault(vault: Vault, keyMaterial: Buffer, osKeyMaterial?: Buffer | null): Buffer {
  // X-P2-25：版本守卫补下界——v=0/缺失此前放行，走进 GCM 后抛误导性的
  // 「密文认证失败」（真凶是版本不识别，作者会去重试密钥白折腾）
  if (vault.v > VAULT_VERSION) throw new VaultVersionError(vault.v)
  if (!Number.isInteger(vault.v) || vault.v < 1) {
    throw new VaultDecryptError(`vault 版本不识别（v=${String(vault.v)}），文件损坏或来源不明`)
  }
  const salt = Buffer.from(vault.salt, 'base64')
  if (vault.v >= 2) {
    if (!osKeyMaterial) {
      // RC 全项目重审 P2-1：文案必须给真实出路——钥匙串搁置期（os-kek.ts OS_KEK_SHELVED，
      // 2026-09-20 起在档）桌面应用同样无 OS 通道，「请从桌面应用启动」成死胡同。补齐两态：
      // 常态（独立 server / env 未注入）从桌面启动即恢复；搁置期桌面启动仍报此错 → 等通道
      // 恢复，或弃旧凭据重配（providers.json 备份后删除，与 os-kek.ts 损坏分诊文案同出路）。
      throw new VaultOsKeyMissingError(
        '配置已由系统钥匙串保护（vault v2），当前环境缺少 OS 凭据通道无法解锁——请从桌面应用启动；桌面应用启动仍报此错时为钥匙串通道暂缓期，等待后续版本恢复通道，或备份后删除 providers.json 重新配置 API Key',
      )
    }
    if (!vault.dek.byOs) throw new VaultDecryptError('vault v2 缺 byOs 通道，文件损坏或来源不明')
    const kek = deriveKEK(osKeyMaterial, salt, KEK_OS_INFO)
    return openAESGCM(kek, vault.dek.byOs)
  }
  if (!vault.dek.byApp) throw new VaultDecryptError('vault v1 缺 byApp 通道，文件损坏或来源不明')
  const kek = deriveKEK(keyMaterial, salt)
  return openAESGCM(kek, vault.dek.byApp)
}

/**
 * 0918三拍板批（KEK v2）：v1 → v2 就地迁移——同一 DEK 重封到 OS 通道并**摘除 byApp**
 *（vault.keys 不动，各 API Key 密文零重加密）。调用方须已用 v1 通道打开得 dek；
 * 已是 v2 → no-op 返回 false（迁移幂等）。迁移落盘后旧构建按 VaultVersionError 拒读
 *（§4.4 防降级毁配置，既有守卫语义）。
 */
export function migrateVaultToOsChannel(vault: Vault, dek: Buffer, osKeyMaterial: Buffer): boolean {
  if (vault.v >= 2) return false
  const salt = Buffer.from(vault.salt, 'base64')
  const kek = deriveKEK(osKeyMaterial, salt, KEK_OS_INFO)
  vault.dek = { byOs: sealAESGCM(kek, dek) }
  vault.v = 2
  return true
}

/** 用 DEK 加密单个 API Key → SealedKey（IV 每次随机）。
 *  R31-28（三十一轮）：aad 绑定上下文（store 侧传 providerId）——同 DEK 下密文互换
 *  （手改 providers.json 交换两条 SealedKey）GCM 认证不再通过，防 key 定向泄漏。 */
export function sealKey(dek: Buffer, apiKey: string, aad?: string): SealedKey {
  return sealAESGCM(dek, Buffer.from(apiKey, 'utf8'), aad ? Buffer.from(aad, 'utf8') : undefined)
}

/** 用 DEK 解密单个 API Key。
 *  R31-28（三十一轮）：返回 { apiKey, legacy }——legacy=true 表示密文未绑 AAD（存量
 *  形态，经无 AAD 通道打开），调用方（load）以此置 needsRewrite 自动重封迁移；绑定态
 *  密文用错误 aad 解时两通道均失败 → 抛 VaultDecryptError（互换攻击被拦截）。 */
export function openKey(dek: Buffer, sealed: SealedKey, aad?: string): { apiKey: string; legacy: boolean } {
  if (aad) {
    try {
      return { apiKey: openAESGCM(dek, sealed, Buffer.from(aad, 'utf8')).toString('utf8'), legacy: false }
    } catch {
      // 绑定通道失败 → 落存量无 AAD 通道（见返回注）
    }
  }
  return { apiKey: openAESGCM(dek, sealed).toString('utf8'), legacy: aad !== undefined }
}
