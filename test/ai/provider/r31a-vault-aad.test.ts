/**
 * R31-28（三十一轮）回归——vault SealedKey 以 providerId 绑 AAD：
 *
 * 此前 sealKey/openKey 无 AAD——同 DEK 下把 providers.json 里两条 SealedKey 互换，
 * GCM 认证照过，供应商 A 会把 B 的 key 发往 A 的 baseUrl（key 定向泄漏）。
 * 修复后：sealKey 绑 aad（store 传 providerId）；openKey 先走绑定通道、失败落
 * 无 AAD 存量通道（legacy=true 由 load 置 needsRewrite 自动重封迁移）；绑定态
 * 密文换绑/裸解均失败。
 */
import { describe, expect, it } from 'vitest'
import { createVault, openKey, sealKey } from '../../../src/ai/provider/vault.js'
import { VaultDecryptError } from '../../../src/ai/provider/vault.js'

const KEY_A = Buffer.alloc(32, 1)

describe('R31-28：vault AAD 绑定', () => {
  it('sealKey 绑 aad → 同 aad 打开成功且 legacy=false', () => {
    const { dek } = createVault(KEY_A)
    const sealed = sealKey(dek, 'sk-provider-a', 'provider-a')
    const opened = openKey(dek, sealed, 'provider-a')
    expect(opened).toEqual({ apiKey: 'sk-provider-a', legacy: false })
  })

  it('绑定态密文换绑到其他 providerId → 抛 VaultDecryptError（互换攻击被拦截）', () => {
    const { dek } = createVault(KEY_A)
    const sealedA = sealKey(dek, 'sk-provider-a', 'provider-a')
    expect(() => openKey(dek, sealedA, 'provider-b').apiKey).toThrow(VaultDecryptError)
  })

  it('绑定态密文不带 aad（裸解）→ 抛 VaultDecryptError', () => {
    const { dek } = createVault(KEY_A)
    const sealed = sealKey(dek, 'sk-provider-a', 'provider-a')
    expect(() => openKey(dek, sealed).apiKey).toThrow(VaultDecryptError)
  })

  it('存量无 AAD 密文 + 带 aad 打开 → legacy=true 兼容通道（load 据此重封迁移）', () => {
    const { dek } = createVault(KEY_A)
    const legacySealed = sealKey(dek, 'sk-legacy') // 升级前形态：未绑 AAD
    const opened = openKey(dek, legacySealed, 'provider-a')
    expect(opened).toEqual({ apiKey: 'sk-legacy', legacy: true })
  })

  it('存量密文被替换为他人绑定态密文 → 两通道均失败抛错', () => {
    const { dek } = createVault(KEY_A)
    const boundB = sealKey(dek, 'sk-provider-b', 'provider-b')
    expect(() => openKey(dek, boundB, 'provider-a').apiKey).toThrow(VaultDecryptError)
  })
})
