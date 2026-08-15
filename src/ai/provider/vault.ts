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
 * - `dek.byApp`：用 KEK 封装的 DEK（内置密钥路径）
 * - `keys[id]`：用 DEK 加密的各 API Key（provider id 为键）
 */
export interface Vault {
  v: number
  salt: string
  dek: { byApp: SealedKey }
  keys: Record<string, SealedKey>
}

/** 当前支持的 vault 格式版本 */
export const VAULT_VERSION = 1

/** HKDF info 串——隔离 KEK 派生用途 */
const KEK_INFO = 'clwriting-vault-kek'

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

// ── HKDF ─────────────────────────────────────────────

/** HKDF-SHA256 派生 KEK（32 字节），微秒级（§4.2） */
function deriveKEK(keyMaterial: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', keyMaterial, salt, KEK_INFO, 32))
}

// ── AES-256-GCM ──────────────────────────────────────

/** AES-256-GCM 加密（§4.2：IV 每次必须重新随机，12 字节） */
function sealAESGCM(key: Buffer, plaintext: Buffer): SealedKey {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: tag.toString('base64') }
}

/** AES-256-GCM 解密——认证失败抛 VaultDecryptError */
function openAESGCM(key: Buffer, sealed: SealedKey): Buffer {
  try {
    const iv = Buffer.from(sealed.iv, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()])
  } catch {
    throw new VaultDecryptError('密文认证失败——文件损坏或密钥不匹配')
  }
}

// ── Vault 生命周期 ───────────────────────────────────

/**
 * 创建新 vault——生成随机 salt + 随机 DEK，用 KEK 封装 DEK（§4.1）。
 * 返回落盘 vault 结构 + 内存中的明文 DEK（不落盘）。
 */
export function createVault(keyMaterial: Buffer): { vault: Vault; dek: Buffer } {
  const salt = randomBytes(32)
  const dek = randomBytes(32)
  const kek = deriveKEK(keyMaterial, salt)
  return {
    vault: {
      v: VAULT_VERSION,
      salt: salt.toString('base64'),
      dek: { byApp: sealAESGCM(kek, dek) },
      keys: {},
    },
    dek,
  }
}

/**
 * 打开已有 vault——版本守卫 + HKDF 派生 KEK + 解封 DEK。
 * 抛 VaultVersionError（版本过高）/ VaultDecryptError（认证失败）。
 */
export function openVault(vault: Vault, keyMaterial: Buffer): Buffer {
  // X-P2-25：版本守卫补下界——v=0/缺失此前放行，走进 GCM 后抛误导性的
  // 「密文认证失败」（真凶是版本不识别，作者会去重试密钥白折腾）
  if (vault.v > VAULT_VERSION) throw new VaultVersionError(vault.v)
  if (!Number.isInteger(vault.v) || vault.v < 1) {
    throw new VaultDecryptError(`vault 版本不识别（v=${String(vault.v)}），文件损坏或来源不明`)
  }
  const salt = Buffer.from(vault.salt, 'base64')
  const kek = deriveKEK(keyMaterial, salt)
  return openAESGCM(kek, vault.dek.byApp)
}

/** 用 DEK 加密单个 API Key → SealedKey（IV 每次随机） */
export function sealKey(dek: Buffer, apiKey: string): SealedKey {
  return sealAESGCM(dek, Buffer.from(apiKey, 'utf8'))
}

/** 用 DEK 解密单个 API Key → 明文 */
export function openKey(dek: Buffer, sealed: SealedKey): string {
  return openAESGCM(dek, sealed).toString('utf8')
}
