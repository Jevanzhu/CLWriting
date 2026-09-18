/**
 * 0918三拍板批（KEK v2）回归：providers.json 的 OS 通道迁移链（store 级）。
 *
 * 链路：os key（env CLW_OS_KEK，桌面主进程 safeStorage 产出）可用时——
 * - load 侧：v1 盘上 vault → 内联迁移（needsRewrite 同款写回）→ 盘上 v2 仅 byOs；
 * - save 侧：新建 vault 即 v2；旁路构造的 v1 store 快照直存时就地迁移；
 * - 回落：env 缺失（纯 node / 测试未设）全程 v1 语义零变化；v2 盘上文件在无 env
 *   环境打开 → VaultOsKeyMissingError（不静默回落旧料——byApp 已摘，回落即伪造）。
 *
 * 断言面：
 * ① v1 存量 + env 注入 → loadProviders 迁移写：盘上 v2（byOs 有 / byApp 无）、key 可解；
 * ② 迁移保留全部密钥（providers + ragProviders 多条）；
 * ③ env 移除后 v2 → VaultOsKeyMissingError（文案含钥匙串）；
 * ④ env 注入下新建保存 → 盘上直接 v2；
 * ⑤ v2 + 篡改 byOs 密文 → VaultDecryptError（认证失败不静默）。
 *
 * 环境注记：vitest forks 池每文件独立进程，CLW_OS_KEK 的 set/delete 不外泄。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { emptySettings, loadProviders, saveProviders, type ProviderStore } from '../../../src/ai/provider/store.js'
import { VaultDecryptError, VaultOsKeyMissingError } from '../../../src/ai/provider/vault.js'

const OS_KEK_HEX = 'aa'.repeat(32)
const dirs: string[] = []

beforeEach(() => {
  delete process.env['CLW_OS_KEK']
})

afterEach(() => {
  delete process.env['CLW_OS_KEK']
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

afterAll(() => {
  delete process.env['CLW_OS_KEK']
})

function setup(): string {
  const d = mkdtempSync(join(tmpdir(), 'clw-vault-osmig-'))
  dirs.push(d)
  return d
}

function prov(id: string, apiKey: string): ProviderStore['providers'][number] {
  return {
    id,
    name: id,
    protocol: 'openai',
    auth: 'bearer',
    baseUrl: 'https://example.invalid/v1',
    model: 'fake-model',
    apiKey,
    caps: { connected: true, streaming: true },
    capsProbedAt: Date.now(),
  }
}

function diskVault(fp: string): { v: number; dek: Record<string, unknown>; keys: Record<string, unknown> } {
  return (JSON.parse(readFileSync(fp, 'utf8')) as { vault: { v: number; dek: Record<string, unknown>; keys: Record<string, unknown> } }).vault
}

describe('KEK v2：providers.json OS 通道迁移链', () => {
  it('① v1 存量 + env 注入 → load 内联迁移：盘上 v2 仅 byOs、key 可解、无 env 则零变化', () => {
    const ud = setup()
    // 无 env：save 走 v1（纯 node 语义）
    const store = emptySettings()
    store.providers = [prov('p1', 'sk-one')]
    saveProviders(ud, store)
    let v = diskVault(join(ud, 'providers.json'))
    expect(v.v).toBe(1)
    expect(v.dek['byApp']).toBeDefined()
    expect(v.dek['byOs']).toBeUndefined()

    // env 注入：load 触发内联迁移写 → v2 仅 byOs
    process.env['CLW_OS_KEK'] = OS_KEK_HEX
    const loaded = loadProviders(ud)
    expect(loaded.providers[0]!.apiKey).toBe('sk-one')
    v = diskVault(join(ud, 'providers.json'))
    expect(v.v).toBe(2)
    expect(v.dek['byOs']).toBeDefined()
    expect(v.dek['byApp']).toBeUndefined()
    expect(v.keys['p1']).toBeDefined()

    // 迁移后再 load（v2 + env）读取稳定
    expect(loadProviders(ud).providers[0]!.apiKey).toBe('sk-one')
  })

  it('② 迁移保留全部密钥（chat providers + ragProviders 两列）', () => {
    const ud = setup()
    const store = emptySettings()
    store.providers = [prov('p1', 'sk-chat'), prov('p2', 'sk-chat2')]
    store.ragProviders = [{ id: 'r1', name: 'r1', protocol: 'openai', auth: 'bearer', baseUrl: 'https://example.invalid/v1', model: 'embed-x', apiKey: 'sk-embed' }]
    saveProviders(ud, store)

    process.env['CLW_OS_KEK'] = OS_KEK_HEX
    const loaded = loadProviders(ud)
    expect(loaded.providers.map((p) => p.apiKey)).toEqual(['sk-chat', 'sk-chat2'])
    expect(loaded.ragProviders[0]!.apiKey).toBe('sk-embed')
    const v = diskVault(join(ud, 'providers.json'))
    expect(v.v).toBe(2)
    for (const id of ['p1', 'p2', 'r1']) expect(v.keys[id]).toBeDefined()
  })

  it('③ env 移除后 v2 → VaultOsKeyMissingError（不静默回落旧料）', () => {
    const ud = setup()
    process.env['CLW_OS_KEK'] = OS_KEK_HEX
    const store = emptySettings()
    store.providers = [prov('p1', 'sk-os')]
    saveProviders(ud, store)
    expect(diskVault(join(ud, 'providers.json')).v).toBe(2)

    delete process.env['CLW_OS_KEK']
    expect(() => loadProviders(ud)).toThrow(VaultOsKeyMissingError)
    expect(() => loadProviders(ud)).toThrow(/钥匙串/)
  })

  it('④ env 注入下新建保存直接 v2；非 64 hex 的 env 视同缺失（显式 resolve 无猜测）', () => {
    // 两个独立目录（同一目录二存会撞 D002 写前 revision 复验——守卫语义另行验证）
    const udFresh = setup()
    process.env['CLW_OS_KEK'] = OS_KEK_HEX
    const store2 = emptySettings()
    store2.providers = [prov('p1', 'sk-fresh')]
    saveProviders(udFresh, store2)
    expect(diskVault(join(udFresh, 'providers.json')).v).toBe(2)

    const udLegacy = setup()
    process.env['CLW_OS_KEK'] = 'zz' // 非法形态 → 视同缺失 → v1
    const store = emptySettings()
    store.providers = [prov('p1', 'sk-legacy')]
    saveProviders(udLegacy, store)
    expect(diskVault(join(udLegacy, 'providers.json')).v).toBe(1)
  })

  it('⑤ v2 + 篡改 byOs 密文 → VaultDecryptError；文件不被覆盖', () => {
    const ud = setup()
    process.env['CLW_OS_KEK'] = OS_KEK_HEX
    const store = emptySettings()
    store.providers = [prov('p1', 'sk-corrupt')]
    saveProviders(ud, store)
    const fp = join(ud, 'providers.json')

    const raw = JSON.parse(readFileSync(fp, 'utf8')) as { vault: { dek: { byOs: { ct: string } } } }
    raw.vault.dek.byOs.ct = raw.vault.dek.byOs.ct.slice(0, -4) + 'AAAA'
    writeFileSync(fp, JSON.stringify(raw), 'utf8')

    expect(() => loadProviders(ud)).toThrow(VaultDecryptError)
    expect(readFileSync(fp, 'utf8')).toContain('AAAA')
  })
})
