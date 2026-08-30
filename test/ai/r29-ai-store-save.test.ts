/**
 * R29-2（二十九轮）：providers.json 排队写失败静默吞——saveProviders 签名 void →
 * Promise<void> 回归。
 *
 * 修复前：排队段 IO 异常仅 log.warn 吞掉，saveProviders 同步返回 void「成功」——
 * 设置页保存 API 已按成功返回而配置未落盘。修复后：
 * - 空闲快路：同步写完后 resolve（IO 异常照旧同步抛，try{await}catch 两侧等价捕获）；
 * - 排队段：返回链式 promise，失败 log.warn 留痕 + 随 promise 上抛（不吞）；
 * - 排队成功链按调用序落盘，链清空后恢复快路。
 *
 * 排队段生产不可直达（空闲快路永不入链），经 __seedProvidersWriteChainForTest 注入
 * 在途 promise 触达（生产零调用测试钩子）。
 */
import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadProviders,
  saveProviders,
  emptySettings,
  __seedProvidersWriteChainForTest,
  type ProviderStore,
} from '../../src/ai/provider/store.js'
import type { ProviderConf } from '../../src/ai/provider/types.js'

function makeConf(overrides: Partial<ProviderConf> = {}): ProviderConf {
  return {
    id: 'prov-a',
    name: '测试供应商',
    protocol: 'openai',
    auth: 'bearer',
    baseUrl: 'https://api.test.com/v1',
    model: 'test-model',
    apiKey: 'sk-r29-store-secret-0001',
    caps: null,
    sortIndex: 0,
    ...overrides,
  }
}

function storeOf(id: string): ProviderStore {
  const s = emptySettings()
  s.providers = [makeConf({ id, apiKey: `sk-${id}-secret` })]
  s.currentId = id
  return s
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'r29-store-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const FP = (): string => join(dir, 'providers.json')

test('R29-2① 快路成功：返回 promise resolve 且配置落盘', async () => {
  const p = saveProviders(dir, storeOf('prov-fast'))
  await expect(p).resolves.toBeUndefined()
  const loaded = loadProviders(dir)
  expect(loaded.providers.map((x) => x.id)).toEqual(['prov-fast'])
  expect(loaded.providers[0]!.apiKey).toBe('sk-prov-fast-secret')
})

test('R29-2② 快路 IO 异常：保持同步 throw（throw 路径不因签名变更改为静默）', () => {
  // providers.json 被目录占位 → bak 段 readFileSync EISDIR 同步抛
  mkdirSync(FP())
  expect(() => saveProviders(dir, storeOf('prov-x'))).toThrow()
})

test('R29-2③ 排队段失败：返回 promise reject 不吞 + log.warn 留痕', async () => {
  __seedProvidersWriteChainForTest(dir, Promise.resolve()) // 注入在途段 → 本写排队
  mkdirSync(FP()) // 排队段执行时写必失败（EISDIR）
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    // 修复前：void 返回、异常被吞，此 await 无从观察失败
    await expect(saveProviders(dir, storeOf('prov-y'))).rejects.toThrow()
    // 留痕仍保留：内部旁挂分支 warn 一次
    const queued = warn.mock.calls.filter((c) => String(c[0]).includes('排队'))
    expect(queued.length).toBe(1)
  } finally {
    warn.mockRestore()
  }
})

test('R29-2④ 排队成功链：按调用序落盘，末写为准', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  __seedProvidersWriteChainForTest(dir, gate)
  const p1 = saveProviders(dir, storeOf('prov-1')) // 排队段 1
  const p2 = saveProviders(dir, storeOf('prov-2')) // 排队段 2（链在 p1 后）
  release()
  await expect(p1).resolves.toBeUndefined()
  await expect(p2).resolves.toBeUndefined()
  // 链序正确：后写覆盖前写，最终落盘为末次 store
  const loaded = loadProviders(dir)
  expect(loaded.providers.map((x) => x.id)).toEqual(['prov-2'])
})

test('R29-2⑤ 链清空后恢复快路：写后立即可读（无 await 同步可见）', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  __seedProvidersWriteChainForTest(dir, gate)
  const queued = saveProviders(dir, storeOf('prov-queued'))
  release()
  await queued // 落定 → 链清理

  // 快路同步直行：不 await 即落盘可读（若链未清会排队，此刻不可见）
  saveProviders(dir, storeOf('prov-sync'))
  const raw = JSON.parse(readFileSync(FP(), 'utf8'))
  expect(raw.providers.map((p: { id: string }) => p.id)).toEqual(['prov-sync'])
})
