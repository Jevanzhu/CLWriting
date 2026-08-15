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
  expect(parsed.vault).toBeTypeOf('object')
  expect(parsed.vault.keys).toBeTypeOf('object')
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
  expect(JSON.parse(raw).vault).toBeTypeOf('object')
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
  expect(JSON.parse(raw2).vault.keys['prov-b']).toBeTypeOf('object')
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
  expect(raw.vault.keys['prov-keep']).toBeTypeOf('object')
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
  expect(raw.vault.keys['prov-with-key']).toBeTypeOf('object')
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
  expect(JSON.parse(bak).vault).toBeTypeOf('object')
})

// ── W-P2-9：主文件损坏 → 自动从 bak 恢复 ────────────

test('W-P2-9: 主文件 JSON 损坏但 bak 可用 → load 自动恢复并保留配置', () => {
  // 正常 save 两次（第二次生成 bak）
  const store = emptySettings()
  store.providers = [makeConf({ id: 'prov-restore', apiKey: 'sk-restore-me-123' })]
  store.currentId = 'prov-restore'
  saveProviders(dir, store)
  store.providers[0]!.apiKey = 'sk-restore-v2-456'
  saveProviders(dir, store)

  // 改坏主文件（bak 完好）
  writeFileSync(FP(), '{ broken json !!!', 'utf8')

  // load 应静默恢复（不抛错），配置从 bak 还原
  const loaded = loadProviders(dir)
  expect(loaded.providers).toHaveLength(1)
  expect(loaded.providers[0]!.id).toBe('prov-restore')
  // bak = 第二次 save 前的备份（S5-D7 语义：保存时备份的是前一次内容 → 这里是 v1 key）
  expect(loaded.providers[0]!.apiKey).toBe('sk-restore-me-123')

  // 主文件已被恢复内容重写（不再是损坏内容）
  const raw = readFileSync(FP(), 'utf8')
  expect(raw).not.toContain('broken')
  expect(JSON.parse(raw).providers[0].id).toBe('prov-restore')
})

test('W-P2-9: 主文件损坏且无 bak → 仍抛错（不静默返回空）', () => {
  // 首次 save 不产生 bak（S5-D7 语义：仅第二次起有备份）
  const store = emptySettings()
  store.providers = [makeConf({ apiKey: 'sk-no-bak-key' })]
  saveProviders(dir, store)
  expect(existsSync(join(dir, 'providers.bak.json'))).toBe(false)

  writeFileSync(FP(), '{ broken json !!!', 'utf8')
  expect(() => loadProviders(dir)).toThrow(/备份恢复亦失败/)
})

test('S5-D5: 原子写——save 后无 .tmp 残留', () => {
  const store = emptySettings()
  store.providers = [makeConf({ apiKey: 'sk-atomic-test123456' })]
  saveProviders(dir, store)
  expect(existsSync(join(dir, 'providers.json.tmp'))).toBe(false)
  // 主文件完整可读
  expect(JSON.parse(readFileSync(FP(), 'utf8')).vault).toBeTypeOf('object')
})

// ── P2-AI-3：缓存未命中路径返回 clone（防调用方突变污染缓存）────────

test('P2-AI-3: loadProviders 返回的 store 突变不污染缓存', () => {
  const store = emptySettings()
  store.providers = [makeConf({ apiKey: 'sk-clone-test123456' })]
  saveProviders(dir, store)

  // 第一次 load（缓存未命中）→ 返回 clone
  const s1 = loadProviders(dir)
  expect(s1.providers[0]!.name).toBe('测试供应商')
  // 突变 s1（模拟 API 端点直接 mutate 后未 save）
  s1.providers[0]!.name = '被污染的中间态'

  // 第二次 load（缓存命中）→ 不应看到 s1 的突变
  const s2 = loadProviders(dir)
  expect(s2.providers[0]!.name).toBe('测试供应商')
})
