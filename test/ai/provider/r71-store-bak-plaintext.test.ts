/**
 * R71-18 回归：明文→vault 一次性迁移后 providers.bak.json 的明文残留收敛。
 *
 * 修复前 loadProviders 的迁移分支只调 saveProviders——其 D7 写前备份把迁移前的
 * 明文主文件原样拷进 bak，用户此后不改配置则明文 Key 在 bak 永久残留（直到下次
 * save 才被密文覆盖）。修复后：迁移写入 + 读回校验（openVault/openKey 逐条比对）
 * 通过即用密文内容覆写一次 bak（0600+fsync）。
 */
import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProviders } from '../../../src/ai/provider/store.js'
import type { ProviderConf, RagProviderConf } from '../../../src/ai/provider/types.js'

const PLAIN_KEY = 'sk-legacy-plaintext-key-71'

function makeConf(): ProviderConf {
  return {
    id: 'prov-test',
    name: '测试供应商',
    protocol: 'openai',
    auth: 'bearer',
    baseUrl: 'https://api.test.com/v1',
    model: 'test-model',
    apiKey: PLAIN_KEY,
    caps: null,
    sortIndex: 0,
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vault-bak-71-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const FP = () => join(dir, 'providers.json')
const BAK = () => join(dir, 'providers.bak.json')

test('明文 chat providers.json 迁移 → 主文件与 bak 均为密文（bak 不留明文 Key）', () => {
  const conf = makeConf()
  writeFileSync(FP(), JSON.stringify({ providers: [{ ...conf }], currentId: conf.id }, null, 2), 'utf8')

  const loaded = loadProviders(dir)
  expect(loaded.providers[0]!.apiKey).toBe(PLAIN_KEY) // 迁移不丢 Key

  // 主文件：密文（既有判据 4 语义不回归）
  const main = readFileSync(FP(), 'utf8')
  expect(main).not.toContain(PLAIN_KEY)
  expect(JSON.parse(main).vault).toBeTypeOf('object')
  // bak：修复前是 D7 拷入的明文旧文件；修复后为迁移校验通过的密文内容
  expect(existsSync(BAK())).toBe(true)
  const bak = readFileSync(BAK(), 'utf8')
  expect(bak).not.toContain(PLAIN_KEY)
  expect(JSON.parse(bak).vault).toBeTypeOf('object')
})

test('明文 ragProviders 迁移 → bak 同样不留明文 Key（两类 key 同批收敛）', () => {
  const rag: RagProviderConf = {
    id: 'rag-embed-71',
    name: '嵌入供应商',
    endpoint: 'https://api.test.com/v1/embeddings',
    model: 'embed-test',
    apiKey: PLAIN_KEY,
    caps: null,
    sortIndex: 0,
  }
  writeFileSync(FP(), JSON.stringify({ providers: [], ragProviders: [{ ...rag }] }, null, 2), 'utf8')

  const loaded = loadProviders(dir)
  expect(loaded.ragProviders[0]!.apiKey).toBe(PLAIN_KEY)

  const main = readFileSync(FP(), 'utf8')
  expect(main).not.toContain(PLAIN_KEY)
  const bak = readFileSync(BAK(), 'utf8')
  expect(bak).not.toContain(PLAIN_KEY)
  expect(JSON.parse(bak).vault).toBeTypeOf('object')
})

test('迁移后的 bak 是可用恢复通道：主文件损坏 → 从 bak 恢复仍解出 Key（W-P2-9 链路不破）', () => {
  const conf = makeConf()
  writeFileSync(FP(), JSON.stringify({ providers: [{ ...conf }], currentId: conf.id }, null, 2), 'utf8')
  loadProviders(dir) // 触发迁移（bak 已被密文覆写）

  // 主文件损坏 → load 走 bak 恢复：密文 bak 须能完整还原配置（证明覆写内容有效）
  writeFileSync(FP(), '{ broken json !!!', 'utf8')
  const restored = loadProviders(dir)
  expect(restored.providers).toHaveLength(1)
  expect(restored.providers[0]!.apiKey).toBe(PLAIN_KEY)
})
