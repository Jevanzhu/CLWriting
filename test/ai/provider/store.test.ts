/**
 * Provider store 加密集成测试——凭据存储设计 S4 九条验收判据。
 *
 * 端到端验证 loadProviders/saveProviders 的 vault 加解密、
 * 明文迁移、半迁移收敛、删除清理、损坏不覆盖、版本守卫。
 */
import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadProviders,
  saveProviders,
  emptySettings,
  type ProviderStore,
} from '../../../src/ai/provider/store.js'
import type { ProviderConf } from '../../../src/ai/provider/types.js'

/** 造一个 provider conf（含明文 apiKey） */
function makeConf(overrides: Partial<ProviderConf> = {}): ProviderConf {
  return {
    id: 'prov-test',
    name: '测试供应商',
    protocol: 'openai',
    auth: 'bearer',
    baseUrl: 'https://api.test.com/v1',
    model: 'test-model',
    apiKey: 'sk-test-secret-key-12345',
    caps: null,
    sortIndex: 0,
    ...overrides,
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vault-store-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const FP = () => join(dir, 'providers.json')

// ── 判据 1：保存后文件无明文 apiKey ──────────────────

test('判据1: 保存后 providers.json 不含明文 apiKey', () => {
  const store = emptySettings()
  store.providers = [makeConf({ apiKey: 'sk-super-secret-12345' })]
  store.currentId = store.providers[0]!.id
  saveProviders(dir, store)

  const raw = readFileSync(FP(), 'utf8')
  expect(raw).not.toContain('sk-super-secret')
  const parsed = JSON.parse(raw)
  expect(parsed.vault).toBeDefined()
  expect(parsed.vault.keys).toBeDefined()
  expect(parsed.providers[0].apiKey).toBeUndefined()
})

// ── 判据 2+3：save → load 往返（换设备 + 升级路径） ──

test('判据2+3: save → load 往返，apiKey 完整还原', () => {
  const store = emptySettings()
  const conf = makeConf({ apiKey: 'sk-roundtrip-key-99999' })
  store.providers = [conf]
  store.currentId = conf.id
  saveProviders(dir, store)

  // load 还原
  const loaded = loadProviders(dir)
  expect(loaded.providers).toHaveLength(1)
  expect(loaded.providers[0]!.apiKey).toBe('sk-roundtrip-key-99999')
  expect(loaded.vault).not.toBeNull()
  expect(loaded.dek).not.toBeNull()

  // vault 版本号 = 当前版本（升级路径：同版本永远可读）
  expect(loaded.vault!.v).toBe(1)
})

// ── 判据 4：存量明文自动转密文 ──────────────────────

test('判据4: 明文 providers.json load 后自动迁移为密文', () => {
  // 手写旧版明文格式
  const conf = makeConf({ apiKey: 'sk-legacy-plaintext-key' })
  const legacy = { providers: [{ ...conf }], currentId: conf.id }
  writeFileSync(FP(), JSON.stringify(legacy, null, 2), 'utf8')

  // load 触发迁移
  const loaded = loadProviders(dir)
  expect(loaded.providers[0]!.apiKey).toBe('sk-legacy-plaintext-key')

  // 文件已转为密文
  const raw = readFileSync(FP(), 'utf8')
  expect(raw).not.toContain('sk-legacy-plaintext')
  expect(JSON.parse(raw).vault).toBeDefined()
  expect(JSON.parse(raw).providers[0].apiKey).toBeUndefined()
})

// ── 判据 5：半迁移收敛（vault + 明文并存）────────────

test('判据5: 半迁移(vault+明文并存)→vault优先，明文补迁移后清理', () => {
  // 先正常 save 一个有 vault 的
  const store = emptySettings()
  const conf1 = makeConf({ id: 'prov-a', apiKey: 'sk-key-a' })
  store.providers = [conf1]
  store.currentId = 'prov-a'
  saveProviders(dir, store)

  // 手动加一个明文 provider + 给 prov-a 留明文残留（模拟写入中断）
  const raw = JSON.parse(readFileSync(FP(), 'utf8'))
  raw.providers.push({
    id: 'prov-b', name: '补充', protocol: 'openai', auth: 'bearer',
    baseUrl: 'https://x.com', model: 'm', apiKey: 'sk-key-b', caps: null, sortIndex: 1,
  })
  raw.providers[0].apiKey = 'sk-legacy-residue' // prov-a 明文残留
  writeFileSync(FP(), JSON.stringify(raw), 'utf8')

  // load → §五规则收敛
  const loaded = loadProviders(dir)
  // prov-a: vault 有 → vault 优先（非明文残留）
  expect(loaded.providers.find((p) => p.id === 'prov-a')!.apiKey).toBe('sk-key-a')
  // prov-b: vault 缺 → 补迁移（从明文）
  expect(loaded.providers.find((p) => p.id === 'prov-b')!.apiKey).toBe('sk-key-b')

  // 文件已清理——无明文残留
  const raw2 = readFileSync(FP(), 'utf8')
  expect(raw2).not.toContain('sk-legacy-residue')
  expect(raw2).not.toContain('sk-key-b')
  // vault.keys 现在含两条
  expect(JSON.parse(raw2).vault.keys['prov-b']).toBeDefined()
})

// ── 判据 6：IV 不复用（同一 key save 两次密文不同）──

test('判据6: 同一 store save 两次，vault.keys 密文不同(IV不复用)', () => {
  const store = emptySettings()
  store.providers = [makeConf({ id: 'prov-x', apiKey: 'sk-same-value' })]
  saveProviders(dir, store)
  const sealed1 = JSON.parse(readFileSync(FP(), 'utf8')).vault.keys['prov-x']

  // 再次 save（复用 dek，sealKey 用新 IV）
  saveProviders(dir, store)
  const sealed2 = JSON.parse(readFileSync(FP(), 'utf8')).vault.keys['prov-x']

  expect(sealed1.iv).not.toBe(sealed2.iv)
  expect(sealed1.ct).not.toBe(sealed2.ct)
})

// ── 判据 7：删除 provider → vault.keys 同步清除 ──────

test('判据7: 删除 provider → vault.keys 条目消失', () => {
  const store = emptySettings()
  store.providers = [
    makeConf({ id: 'prov-keep', apiKey: 'sk-keep' }),
    makeConf({ id: 'prov-del', apiKey: 'sk-del' }),
  ]
  saveProviders(dir, store)

  // 删除 prov-del
  store.providers = store.providers.filter((p) => p.id !== 'prov-del')
  saveProviders(dir, store)

  const raw = JSON.parse(readFileSync(FP(), 'utf8'))
  expect(raw.vault.keys['prov-keep']).toBeDefined()
  expect(raw.vault.keys['prov-del']).toBeUndefined()
})

// ── 判据 8：vault.dek 损坏 → 报错且不覆盖 ────────────

test('判据8: vault.dek 损坏 → load 抛错且文件不被覆盖', () => {
  const store = emptySettings()
  store.providers = [makeConf({ apiKey: 'sk-to-corrupt' })]
  saveProviders(dir, store)

  // 改坏 dek 密文
  const raw = JSON.parse(readFileSync(FP(), 'utf8'))
  raw.vault.dek.byApp.ct = raw.vault.dek.byApp.ct.slice(0, -4) + 'AAAA'
  writeFileSync(FP(), JSON.stringify(raw), 'utf8')

  // load 应抛错（不静默返回空）
  expect(() => loadProviders(dir)).toThrow()

  // 文件未被覆盖（仍是改坏后的版本）
  const after = readFileSync(FP(), 'utf8')
  expect(after).toContain('AAAA')
})

// ── 判据 9：vault.v = 未来版本 → 拒绝解析且不覆盖 ────

test('判据9: vault.v=未来版本 → load 抛错且文件不被覆盖', () => {
  const store = emptySettings()
  store.providers = [makeConf({ apiKey: 'sk-future' })]
  saveProviders(dir, store)

  // 改成未来版本号（vault.v 是内层版本字段）
  const raw = JSON.parse(readFileSync(FP(), 'utf8'))
  raw.vault.v = 999
  writeFileSync(FP(), JSON.stringify(raw), 'utf8')

  expect(() => loadProviders(dir)).toThrow(/更新版本/)

  // 文件未被覆盖
  const after = JSON.parse(readFileSync(FP(), 'utf8'))
  expect(after.vault.v).toBe(999)
})

// ── 补充：空 key 的 provider 不进 vault.keys ─────────

test('补充: apiKey 为空的 provider 不写入 vault.keys', () => {
  const store = emptySettings()
  store.providers = [
    makeConf({ id: 'prov-with-key', apiKey: 'sk-real' }),
    { ...makeConf({ id: 'prov-no-key' }), apiKey: '' },
  ]
  saveProviders(dir, store)

  const raw = JSON.parse(readFileSync(FP(), 'utf8'))
  expect(raw.vault.keys['prov-with-key']).toBeDefined()
  expect(raw.vault.keys['prov-no-key']).toBeUndefined()
})

// ── S5：写入健壮性（D5-D8）──────────────────────────

test('S5-D6: JSON 损坏 → loadProviders 抛错（不静默返回空）', () => {
  writeFileSync(FP(), '{ broken json !!! }', 'utf8')
  expect(() => loadProviders(dir)).toThrow(/解析失败/)
})

test('S5-D7: 第二次 save 产生 providers.bak.json 备份', () => {
  const store = emptySettings()
  store.providers = [makeConf({ apiKey: 'sk-first-secret12345' })]
  saveProviders(dir, store) // 首次创建（无备份）

  // 改动后再次 save → 应备份首次内容
  store.providers[0]!.apiKey = 'sk-second-secret1234'
  saveProviders(dir, store)

  const bakPath = join(dir, 'providers.bak.json')
  expect(existsSync(bakPath)).toBe(true)
  const bak = readFileSync(bakPath, 'utf8')
  // 备份是首次 save 的密文（不含任何明文 key）
  expect(bak).not.toContain('sk-first-secret12345')
  expect(bak).not.toContain('sk-second-secret1234')
  // 备份含 vault（密文）
  expect(JSON.parse(bak).vault).toBeDefined()
})

test('S5-D5: 原子写——save 后无 .tmp 残留', () => {
  const store = emptySettings()
  store.providers = [makeConf({ apiKey: 'sk-atomic-test123456' })]
  saveProviders(dir, store)
  expect(existsSync(join(dir, 'providers.json.tmp'))).toBe(false)
  // 主文件完整可读
  expect(JSON.parse(readFileSync(FP(), 'utf8')).vault).toBeDefined()
})
