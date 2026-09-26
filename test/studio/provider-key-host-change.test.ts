/**
 * RC 源码重审 B-4（Opus-5.5 轮）：编辑供应商改 baseUrl 主机时不得静默沿用已存 API Key。
 *
 * 缺陷：PUT /api/providers/:id 的 `newKey = input.apiKey || existing.apiKey` 在作者改主机
 * （误填域名/换第三方中转站）而留空 Key 时沿用旧 Key——下一次探测/生成就把已存凭据发往新
 * 主机。修后准入：主机（new URL(...).host，含端口）变化 + apiKey 留空 → 400
 * API_KEY_REQUIRED_ON_HOST_CHANGE，盘上零改写；同请求带 apiKey → 正常保存。
 *
 * 三态口径（本文件逐条锁死）：
 * - 路径/查询串/大小写/尾斜杠差异 = 同主机（常见配置调整，不索要重填）；
 * - 端口差异 = 换主机（可能换到另一服务）；
 * - 解析失败（存量手改脏值） = 按「已变更」处理（fail-closed：证明不了同主机就不发）。
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { saveProviders, loadProviders, type ProviderConf } from '../../src/ai/provider/index.js'
// 缓存清空只有 store.ts 直出（index 未转发）：本文件按 id 直读盘上明文 key 需它兜同毫秒窗
import { processProviderRuntime } from '../../src/ai/provider/store.js'

const HOST_A = 'https://api.host-a.example/v1'
const KEY_A = 'sk-alpha-AAAA1111'
const MASK_A = 'sk-a...1111' // maskKey 口径：前 4 + '...' + 后 4

let studio: StudioHarness
let userDataPath = ''

/** 端点回复类型（成功与错误信封的并集，逐字段按需取） */
interface ProviderReply {
  provider?: { id: string; baseUrl: string; apiKey: string; apiKeyMasked: string; hasKey: boolean }
  code?: string
  error?: string
  revision?: number
}

/** 供应商 body（默认 = 主机 A + Key A；CONF 形状对齐既有 providers 端点用例） */
function body(
  over: Partial<{ name: string; protocol: string; auth: string; baseUrl: string; apiKey: string }> = {},
): unknown {
  return {
    name: '主机变更用例',
    protocol: 'openai',
    auth: 'bearer',
    baseUrl: HOST_A,
    apiKey: KEY_A,
    ...over,
  }
}

/** 经端点新增供应商，返回其 id */
async function createProvider(): Promise<string> {
  const r = await studio.req('POST', '/api/providers', body())
  expect(r.status).toBe(200)
  return (r.json as ProviderReply).provider!.id
}

/** 盘上原文（provider 组端点只此一文件） */
function diskText(): string {
  return readFileSync(join(userDataPath, 'providers.json'), 'utf-8')
}

/** 盘上明文 key（loadProviders 解密读；先清 mtime LRU 免同毫秒陈旧命中） */
function diskKey(id: string): string {
  processProviderRuntime().__clearProvidersCacheForTest()
  return loadProviders(userDataPath).providers.find((p) => p.id === id)!.apiKey
}

/** 直接用库 API 播种（绕开端点校验——模拟手改 providers.json 的存量脏值）。
 *  以盘上现态为基线（revision/vault/dek 原样）只换 providers：saveProviders 锁内复验
 *  revision，凭空造 revision 会被判「他写方已先行落盘」拒绝。 */
async function seedRaw(existing: ProviderConf): Promise<void> {
  processProviderRuntime().__clearProvidersCacheForTest()
  const cur = loadProviders(userDataPath)
  await saveProviders(userDataPath, { ...cur, providers: [existing], currentId: existing.id, modelCaps: {} })
}

beforeAll(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-prov-hostchange-'))
  studio = await bootStudio({ prefix: 'clwriting-prov-hostchange-', userDataPath })
})

afterAll(async () => {
  await studio.close()
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

describe('RC B-4：主机变更 + 留空 Key 的准入闸', () => {
  it('改主机 + 留空 Key → 400 专用码，盘上逐字未改（Key 未外流、baseUrl 亦未改）', async () => {
    const id = await createProvider()
    const before = diskText()

    const r = await studio.req(
      'PUT',
      `/api/providers/${id}`,
      body({ baseUrl: 'https://third-party-relay.example/v1', apiKey: '' }),
    )
    expect(r.status).toBe(400)
    const j = r.json as ProviderReply
    expect(j.code).toBe('API_KEY_REQUIRED_ON_HOST_CHANGE')
    expect(j.error).toContain('主机已变更')
    expect(j.error).toContain('重新填写 API Key')
    // 拒绝信封永不回显 key 本体（I6 口径：密钥不进错误消息）
    expect(JSON.stringify(j)).not.toContain(KEY_A)

    // 盘上零改写：baseUrl 未变（拒绝先于任何 mutate/save），Key 密文条目原样
    expect(diskText()).toBe(before)
    expect(diskKey(id)).toBe(KEY_A)

    // 端点回读：地址仍是主机 A
    const list = await studio.req('GET', '/api/providers')
    const p = (list.json as { providers: { id: string; baseUrl: string; apiKeyMasked: string }[] }).providers.find(
      (x) => x.id === id,
    )!
    expect(p.baseUrl).toBe(HOST_A)
    expect(p.apiKeyMasked).toBe(MASK_A)
  })

  it('改主机 + 同请求带新 Key → 200，新 Key 落盘（旧 Key 被替换）', async () => {
    const id = await createProvider()
    const NEW_KEY = 'sk-beta-BBBB2222'

    const r = await studio.req(
      'PUT',
      `/api/providers/${id}`,
      body({ baseUrl: 'https://api.host-b.example/v1', apiKey: NEW_KEY }),
    )
    expect(r.status).toBe(200)
    const p = (r.json as ProviderReply).provider!
    expect(p.baseUrl).toBe('https://api.host-b.example/v1')
    expect(p.apiKey).toBe('') // 不回传原 key
    expect(p.apiKeyMasked).toBe('sk-b...2222')
    expect(p.hasKey).toBe(true)

    expect(diskKey(id)).toBe(NEW_KEY)
    expect(diskText()).not.toContain(NEW_KEY) // 明文绝不落盘
  })

  it('仅改路径（同主机，/v1 → /v2）+ 留空 Key → 200 且保留原 Key（不误伤常见配置）', async () => {
    const id = await createProvider()

    const r = await studio.req(
      'PUT',
      `/api/providers/${id}`,
      body({ baseUrl: 'https://api.host-a.example/v2', apiKey: '' }),
    )
    expect(r.status).toBe(200)
    const p = (r.json as ProviderReply).provider!
    expect(p.baseUrl).toBe('https://api.host-a.example/v2')
    expect(p.apiKeyMasked).toBe(MASK_A)
    expect(diskKey(id)).toBe(KEY_A)
  })

  it('完全不变（原样提交）+ 留空 Key → 200 保留原 Key（既有语义回归）', async () => {
    const id = await createProvider()

    const r = await studio.req('PUT', `/api/providers/${id}`, body({ apiKey: '' }))
    expect(r.status).toBe(200)
    const p = (r.json as ProviderReply).provider!
    expect(p.baseUrl).toBe(HOST_A)
    expect(p.apiKeyMasked).toBe(MASK_A)
    expect(p.hasKey).toBe(true)
    expect(diskKey(id)).toBe(KEY_A)
  })

  it('同主机的大小写/尾斜杠/查询串差异 → 视为同主机，留空 Key 放行', async () => {
    const id = await createProvider()

    // URL 归一化：hostname 大小写不敏感 → 同主机
    const up = await studio.req(
      'PUT',
      `/api/providers/${id}`,
      body({ baseUrl: 'https://API.Host-A.example/v1', apiKey: '' }),
    )
    expect(up.status).toBe(200)
    expect((up.json as ProviderReply).provider!.apiKeyMasked).toBe(MASK_A)

    // 查询串/尾斜杠不进 host → 同主机
    const q = await studio.req(
      'PUT',
      `/api/providers/${id}`,
      body({ baseUrl: 'https://api.host-a.example/v1/?x=1', apiKey: '' }),
    )
    expect(q.status).toBe(200)
    expect(diskKey(id)).toBe(KEY_A)
  })

  it('仅端口变化 → 视为换主机，留空 Key 拒绝（同主机名不同服务）', async () => {
    const id = await createProvider()
    const before = diskText()

    const r = await studio.req(
      'PUT',
      `/api/providers/${id}`,
      body({ baseUrl: 'https://api.host-a.example:8443/v1', apiKey: '' }),
    )
    expect(r.status).toBe(400)
    expect((r.json as ProviderReply).code).toBe('API_KEY_REQUIRED_ON_HOST_CHANGE')
    expect(diskText()).toBe(before)
  })

  it('存量 baseUrl 解析失败（手改脏值）→ 按「已变更」处理：换合法地址 + 留空 Key 被拒', async () => {
    const id = 'prov-legacy-dirty'
    await seedRaw({
      id,
      name: '存量脏地址',
      protocol: 'openai',
      auth: 'bearer',
      baseUrl: 'https://', // 过不了 new URL（无主机）——存量直写形态
      apiKey: KEY_A,
      caps: null,
    })

    // 换成合法地址但仍留空 Key：判不出原主机 → fail-closed 拒绝
    const r = await studio.req('PUT', `/api/providers/${id}`, body({ baseUrl: HOST_A, apiKey: '' }))
    expect(r.status).toBe(400)
    expect((r.json as ProviderReply).code).toBe('API_KEY_REQUIRED_ON_HOST_CHANGE')
    expect(diskKey(id)).toBe(KEY_A) // 原 Key 未动

    // 同请求带上 Key → 放行（脏值改回合法地址的正常出路）
    const ok = await studio.req('PUT', `/api/providers/${id}`, body({ baseUrl: HOST_A, apiKey: 'sk-gamma-CCCC3333' }))
    expect(ok.status).toBe(200)
    expect(diskKey(id)).toBe('sk-gamma-CCCC3333')
  })

  it('脏值原样提交（两侧解析失败但逐字相同）→ 不索要重填（逐字相等短路）', async () => {
    const id = 'prov-legacy-same'
    await seedRaw({
      id,
      name: '存量脏地址原样提交',
      protocol: 'openai',
      auth: 'bearer',
      baseUrl: 'https://',
      apiKey: KEY_A,
      caps: null,
    })

    const r = await studio.req('PUT', `/api/providers/${id}`, body({ baseUrl: 'https://', apiKey: '' }))
    expect(r.status).toBe(200)
    expect(diskKey(id)).toBe(KEY_A)
  })
})
