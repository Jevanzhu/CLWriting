/**
 * 0918三拍板批（KEK v2）回归：vault OS 凭据通道（byOs）纯函数面。
 *
 * 拍板语义：桌面形态 KEK 由 OS 凭据链（Electron safeStorage——mac Keychain / win
 * DPAPI）承载——v2 vault 仅 byOs 通道、内置混淆级材料不再可解（持制品攻击面对已
 * 迁移用户收口）；v1 vault 仍由内置材料解锁并经 migrateVaultToOsChannel 单向迁移
 *（同一 DEK 重封，vault.keys 零重加密）。本文件注入测试密钥（不依赖真实材料）。
 *
 * 断言面：
 * ① createVault(os) → v2 仅 byOs；createVault() 缺省 → v1 仅 byApp（纯 node 语义不变）；
 * ② v2 open 往返 DEK 一致；无 os key → VaultOsKeyMissingError（文案引导桌面启动，
 *   与损坏形态可区分）；错 os key → VaultDecryptError；
 * ③ v1 open 行为不变（既有用例兼容口径）；v1 缺 byApp → 损坏形态明确；
 * ④ migrateVaultToOsChannel：v1→v2 单向、DEK 不变、byApp 摘除、迁移后旧料不可解
 *   （VaultOsKeyMissingError）、幂等（v2 再调 false）、keys 密文引用不动；
 * ⑤ 版本守卫：v = VAULT_VERSION+1 → VaultVersionError（防降级毁配置语义保持）。
 */
import { test, expect } from 'vitest'
import {
  createVault,
  openVault,
  migrateVaultToOsChannel,
  sealKey,
  openKey,
  VAULT_VERSION,
  VaultVersionError,
  VaultDecryptError,
  VaultOsKeyMissingError,
  type Vault,
} from '../../../src/ai/provider/vault.js'

/** 测试密钥（注入，非真实材料）：KEY_A = 内置通道料，OS_A = OS 通道料 */
const KEY_A = Buffer.alloc(32, 0xab)
const KEY_B = Buffer.alloc(32, 0xcd)
const OS_A = Buffer.alloc(32, 0x11)
const OS_B = Buffer.alloc(32, 0x22)

test('① createVault(osKey) → v2 仅 byOs 通道；缺省 → v1 仅 byApp（纯 node 语义不变）', () => {
  const os = createVault(KEY_A, OS_A)
  expect(os.vault.v).toBe(2)
  expect(os.vault.dek.byOs).toBeDefined()
  expect(os.vault.dek.byApp).toBeUndefined()

  const legacy = createVault(KEY_A)
  expect(legacy.vault.v).toBe(1)
  expect(legacy.vault.dek.byApp).toBeDefined()
  expect(legacy.vault.dek.byOs).toBeUndefined()
})

test('② v2 open 往返 DEK 一致；无 os key → VaultOsKeyMissingError（钥匙串文案）；错 os key → 认证失败', () => {
  const { vault, dek } = createVault(KEY_A, OS_A)
  expect(Buffer.compare(openVault(vault, KEY_A, OS_A), dek)).toBe(0)

  // 无 OS 通道 ≠ 文件损坏——专用错误类 + 文案引导桌面启动（既有 catch VaultDecryptError 零改动）
  expect(() => openVault(vault, KEY_A)).toThrow(VaultOsKeyMissingError)
  expect(() => openVault(vault, KEY_A)).toThrow(/钥匙串/)

  expect(() => openVault(vault, KEY_A, OS_B)).toThrow(VaultDecryptError)
})

test('③ v1 open 行为不变；v1 缺 byApp → 损坏形态明确', () => {
  const { vault, dek } = createVault(KEY_A)
  expect(Buffer.compare(openVault(vault, KEY_A, OS_A), dek)).toBe(0) // os 参数存在但 v1 不消费
  expect(() => openVault(vault, KEY_B)).toThrow(VaultDecryptError)

  const broken: Vault = { ...vault, dek: {} }
  expect(() => openVault(broken, KEY_A)).toThrow(/byApp/)
})

test('④ 迁移：DEK 不变 + byApp 摘除 + 迁移后旧料不可解 + keys 零重加密 + 幂等', () => {
  const { vault, dek } = createVault(KEY_A)
  vault.keys['prov-1'] = sealKey(dek, 'sk-test-12345', 'prov-1')
  const keysBefore = vault.keys

  expect(migrateVaultToOsChannel(vault, dek, OS_A)).toBe(true)
  expect(vault.v).toBe(2)
  expect(vault.dek.byOs).toBeDefined()
  expect(vault.dek.byApp).toBeUndefined()
  // keys 密文引用不动（迁移只重封 DEK，各 API Key 零重加密）
  expect(vault.keys).toBe(keysBefore)
  // os 通道打开：DEK 与 keys 均可用
  expect(Buffer.compare(openVault(vault, KEY_A, OS_A), dek)).toBe(0)
  expect(openKey(dek, vault.keys['prov-1']!, 'prov-1').apiKey).toBe('sk-test-12345')
  // 迁移后旧料（无 os key）不可解——持制品攻击面对已迁移用户收口
  expect(() => openVault(vault, KEY_A)).toThrow(VaultOsKeyMissingError)
  // 幂等：v2 再调 no-op
  expect(migrateVaultToOsChannel(vault, dek, OS_A)).toBe(false)
})

test('⑤ 版本守卫保持：v = VAULT_VERSION+1 → VaultVersionError（防降级毁配置）', () => {
  const { vault } = createVault(KEY_A, OS_A)
  const future = { ...vault, v: VAULT_VERSION + 1 }
  expect(() => openVault(future, KEY_A, OS_A)).toThrow(VaultVersionError)
})
