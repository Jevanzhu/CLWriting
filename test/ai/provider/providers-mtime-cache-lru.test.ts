/**
 * 四轮-A404（2026-09-18 全量源码独立重评四轮修复批）回归：providers store mtime 缓存
 * 单槽 → 小 LRU（容量 8，先例 registry.ts CACHE_CAPACITY=8）。
 *
 * 修复前：单槽 `_cache`（path 不匹配即弃用重读）在双书库（双 userDataPath）交错
 * loadProviders 时反复互相击穿，每次都重付全量 readFileSync + AES-256-GCM 解密。
 * 修复后：键 = join 后绝对路径、值含 mtime 做命中校验——mtime 不同即 miss 的既有语义
 * 逐位保持（外部改动自动失效；A105 登记的同毫秒粒度窗原样保留，本测经 utimesSync 钉
 * 显式时刻规避该窗的不确定性）；写侧/备份恢复侧/文件缺失三个失效点由 `_cache = null`
 * 全量清除改按键清除（单文件操作不涉他路径条目，他路径命中仍受 mtime 校验兜底）。
 *
 * 命中/重读经 vi.mock node:fs 的 readFileSync 计数观测（passthrough 直通真实实现，
 * 先例 leak-keywords-derive.test.ts（原 r47-leak-derive-cache））——loadProviders 缓存命中路径不再触 readFileSync。
 * 各 test 的计数以紧邻断言前的 mockClear 为窗（写链内部 bak/复验也走 readFileSync，
 * 不计入窗口）。
 */
import { rmSync, utimesSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdtempTracked } from '../../helpers/temp-dir.js'
import {
  loadProviders,
  saveProviders,
  emptySettings,
  processProviderRuntime,
} from '../../../src/ai/provider/store.js'
import type { ProviderConf } from '../../../src/ai/provider/types.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

function makeConf(id: string, apiKey: string): ProviderConf {
  return {
    id,
    name: `供应商-${id}`,
    protocol: 'openai',
    auth: 'bearer',
    baseUrl: 'https://api.test.com/v1',
    model: 'test-model',
    apiKey,
    caps: null,
    sortIndex: 0,
  }
}

const dirs: string[] = []

/** 造一个已落盘的 userData 目录（saveProviders 走 vault 加密），返回其路径 */
function saveDir(tag: string, apiKey: string): string {
  const d = mkdtempTracked(join(tmpdir(), `clw-mtime-lru-${tag}-`))
  dirs.push(d)
  const store = emptySettings()
  store.providers = [makeConf(`prov-${tag}`, apiKey)]
  store.currentId = `prov-${tag}`
  saveProviders(d, store)
  return d
}

beforeEach(() => {
  processProviderRuntime().__clearProvidersCacheForTest()
})

afterEach(() => {
  processProviderRuntime().__clearProvidersCacheForTest()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** spy 的 readFileSync 对指定路径的调用次数（缓存命中观测面） */
function readCallsFor(fp: string): number {
  return vi.mocked(readFileSync).mock.calls.filter((c) => c[0] === fp).length
}

test('交错访问两个 userDataPath：第二轮各自命中缓存、零重读（单槽时代互相击穿）', () => {
  const a = saveDir('A', 'sk-key-aaaa-1111')
  const b = saveDir('B', 'sk-key-bbbb-2222')
  const fpA = join(a, 'providers.json')
  const fpB = join(b, 'providers.json')

  // 各首次 load（各自 miss 一次，读 + 解密）
  expect(loadProviders(a).providers[0]!.apiKey).toBe('sk-key-aaaa-1111')
  expect(loadProviders(b).providers[0]!.apiKey).toBe('sk-key-bbbb-2222')
  expect(readCallsFor(fpA)).toBe(1)
  expect(readCallsFor(fpB)).toBe(1)

  // 交错第二轮：双双命中（修复前：loadProviders(a) 击穿 b 的缓存槽，再 load(b) 必重读）
  expect(loadProviders(a).providers[0]!.apiKey).toBe('sk-key-aaaa-1111')
  expect(loadProviders(b).providers[0]!.apiKey).toBe('sk-key-bbbb-2222')
  expect(loadProviders(a).currentId).toBe('prov-A')
  expect(readCallsFor(fpA)).toBe(1)
  expect(readCallsFor(fpB)).toBe(1)
})

test('mtime 变化后失效重读（外部改动自动失效，语义保持）；mtime 未变则命中不重读', () => {
  const a = saveDir('A', 'sk-key-aaaa-3333')
  const fp = join(a, 'providers.json')
  // 钉显式 mtime（与落盘时刻拉开，避开 A105 同毫秒窗的测试不确定性）——先钉再首载，
  // 使缓存记下的 mtime 即 T1
  utimesSync(fp, new Date(1_700_000_000_000), new Date(1_700_000_000_000))
  loadProviders(a)

  vi.mocked(readFileSync).mockClear()
  expect(loadProviders(a).providers[0]!.apiKey).toBe('sk-key-aaaa-3333')
  expect(readCallsFor(fp)).toBe(0) // mtime 未变 → 命中

  // 外部改写（非 vault 通道改非加密字段）+ mtime 前推 → miss 重读、读到新内容
  const disk = JSON.parse(readFileSync(fp, 'utf8')) as { currentId?: string }
  disk.currentId = 'prov-B-side'
  writeFileSync(fp, JSON.stringify(disk), 'utf8')
  utimesSync(fp, new Date(1_700_000_100_000), new Date(1_700_000_100_000))
  vi.mocked(readFileSync).mockClear()
  expect(loadProviders(a).currentId).toBe('prov-B-side')
  expect(readCallsFor(fp)).toBe(1) // mtime 变 → 恰重读一次
})

test('容量 8：第 9 个路径入场逐出最旧条目，命中路径不受影响（LRU 有界）', () => {
  const paths = Array.from({ length: 9 }, (_, i) => saveDir(`K${i}`, `sk-key-${i}-abcdef`))
  for (const p of paths) loadProviders(p)
  expect(processProviderRuntime().__providersCacheSizeForTest()).toBe(8)

  vi.mocked(readFileSync).mockClear()
  // 最旧（K0）已被逐出 → 重读一次；容量维持 8
  expect(loadProviders(paths[0]!).providers[0]!.apiKey).toBe('sk-key-0-abcdef')
  expect(readCallsFor(join(paths[0]!, 'providers.json'))).toBe(1)
  expect(processProviderRuntime().__providersCacheSizeForTest()).toBe(8)
  // 最新（K8）仍在缓存 → 零重读
  expect(loadProviders(paths[8]!).providers[0]!.apiKey).toBe('sk-key-8-abcdef')
  expect(readCallsFor(join(paths[8]!, 'providers.json'))).toBe(0)
})

test('saveProviders 写后按键失效：本路径下次 load 重读，他路径缓存不受击穿', async () => {
  const a = saveDir('A', 'sk-key-aaaa-4444')
  const b = saveDir('B', 'sk-key-bbbb-5555')
  loadProviders(a)
  loadProviders(b)

  // 写 A（写后本路径失效）——store 为 loadProviders 副本（P2-AI-3），revision 与盘上一致
  const store = loadProviders(a)
  store.providers[0]!.apiKey = 'sk-key-aaaa-6666'
  await saveProviders(a, store)
  vi.mocked(readFileSync).mockClear()
  expect(loadProviders(a).providers[0]!.apiKey).toBe('sk-key-aaaa-6666') // 本路径重读生效
  expect(readCallsFor(join(a, 'providers.json'))).toBe(1)
  expect(loadProviders(b).providers[0]!.apiKey).toBe('sk-key-bbbb-5555') // 内容不变
  expect(readCallsFor(join(b, 'providers.json'))).toBe(0) // 他路径仍命中（原 `_cache = null` 全表清除会击穿）
})
