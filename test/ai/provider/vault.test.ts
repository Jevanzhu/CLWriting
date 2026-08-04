/**
 * Vault 加解密纯函数测试——凭据存储设计 S4。
 *
 * 用注入的测试密钥（不依赖真实 builtinKeyMaterial），验证：
 * - createVault/openVault 往返
 * - sealKey/openKey 往返
 * - IV 不复用（§4.2 唯一致命错误）
 * - 密钥不匹配 → VaultDecryptError
 * - 版本守卫 → VaultVersionError（§4.4）
 */
import { test, expect } from 'vitest'
import {
  createVault,
  openVault,
  sealKey,
  openKey,
  VAULT_VERSION,
  VaultVersionError,
  VaultDecryptError,
} from '../../../src/ai/provider/vault.js'

/** 测试密钥 A（注入，非真实材料） */
const KEY_A = Buffer.alloc(32, 0xab)
/** 测试密钥 B（与 A 不同，验证密钥不匹配） */
const KEY_B = Buffer.alloc(32, 0xcd)

test('vault: createVault + openVault 往返——DEK 一致', () => {
  const { vault, dek } = createVault(KEY_A)
  const reopened = openVault(vault, KEY_A)
  expect(Buffer.compare(dek, reopened)).toBe(0)
})

test('vault: 错误密钥 → VaultDecryptError', () => {
  const { vault } = createVault(KEY_A)
  expect(() => openVault(vault, KEY_B)).toThrow(VaultDecryptError)
})

test('vault: 版本守卫——高于当前版本抛 VaultVersionError', () => {
  const { vault } = createVault(KEY_A)
  const future = { ...vault, v: VAULT_VERSION + 1 }
  expect(() => openVault(future, KEY_A)).toThrow(VaultVersionError)
})

test('vault: sealKey + openKey 往返', () => {
  const { dek } = createVault(KEY_A)
  const sealed = sealKey(dek, 'sk-test-12345')
  expect(openKey(dek, sealed)).toBe('sk-test-12345')
})

test('vault: IV 不复用——同一明文加密两次 iv/ct 不同（§4.2）', () => {
  const { dek } = createVault(KEY_A)
  const a = sealKey(dek, 'sk-same-key')
  const b = sealKey(dek, 'sk-same-key')
  expect(a.iv).not.toBe(b.iv)
  expect(a.ct).not.toBe(b.ct)
  // 都能解出同一明文
  expect(openKey(dek, a)).toBe('sk-same-key')
  expect(openKey(dek, b)).toBe('sk-same-key')
})

test('vault: dek 不匹配 → openKey 抛 VaultDecryptError', () => {
  const { dek: dek1 } = createVault(KEY_A)
  const { dek: dek2 } = createVault(KEY_A)
  const sealed = sealKey(dek1, 'sk-test')
  expect(() => openKey(dek2, sealed)).toThrow(VaultDecryptError)
})

test('vault: 两次 createVault 产生不同 salt（随机性）', () => {
  const a = createVault(KEY_A)
  const b = createVault(KEY_A)
  expect(a.vault.salt).not.toBe(b.vault.salt)
})
