/**
 * Y-31 / Y-32（第五十七轮）回归——provider 与 learn store 的并发态守卫。
 *
 * Y-31：provider.test/testRag 的 testing 单值按 id 归属清空——A/B 连点「测试连接」时
 * 先完成者不得提前清掉后跑者的行内 spinner（按钮提前复位可重复触发）。
 * Y-32：learn.commit finally 查代 + clear() 复位 committing——A 书收录在途切书后，
 * 迟到的 finally 不得解锁 B 书新一次 commit 的按钮。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/providers', () => ({
  getProviders: vi.fn(),
  getRagProviders: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  setCurrentProvider: vi.fn(),
  testProvider: vi.fn(),
  fetchModels: vi.fn(),
  setTiers: vi.fn(),
  setChatTier: vi.fn(),
  createRagProvider: vi.fn(),
  updateRagProvider: vi.fn(),
  deleteRagProvider: vi.fn(),
  testRagProvider: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/learn', () => ({
  runLearnHarvest: vi.fn(),
  runLearnCommit: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: vi.fn(() => ({ toast: vi.fn() })),
}))

import {
  testProvider,
  testRagProvider,
  deleteProvider,
  deleteRagProvider,
} from '../../../src/studio/web-next/src/api/providers'
import { runLearnCommit } from '../../../src/studio/web-next/src/api/learn'
import { useProviderStore } from '../../../src/studio/web-next/src/stores/provider'
import { useLearnStore } from '../../../src/studio/web-next/src/stores/learn'

const testMock = testProvider as ReturnType<typeof vi.fn>
const testRagMock = testRagProvider as ReturnType<typeof vi.fn>
const deleteMock = deleteProvider as ReturnType<typeof vi.fn>
const deleteRagMock = deleteRagProvider as ReturnType<typeof vi.fn>
const commitMock = runLearnCommit as ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('Y-31: provider testing 单值按 id 归属清空', () => {
  it('A/B 连点测试：A 先返回不得清掉 B 的 testing', async () => {
    testMock.mockImplementation(async (id: string) => {
      if (id === 'A') return { ok: true, caps: null }
      await new Promise((r) => setTimeout(r, 20))
      return { ok: true, caps: null }
    })
    const s = useProviderStore()
    const pa = s.test('A', undefined)
    const pb = s.test('B', undefined)
    await new Promise((r) => setTimeout(r, 5))
    expect(s.testing).toBe('B') // A 未完成前由 B 占位；A 完成后不得清空
    await pa
    expect(s.testing).toBe('B') // 修复点：A 的 finally 只清自己（此前被清成 null）
    await pb
    expect(s.testing).toBeNull()
  })

  it('testRag 同款归属清空', async () => {
    testRagMock.mockImplementation(async (id: string) => {
      if (id === 'A') return { ok: true }
      await new Promise((r) => setTimeout(r, 20))
      return { ok: true }
    })
    const s = useProviderStore()
    const pa = s.testRag('A')
    const pb = s.testRag('B')
    await pa
    expect(s.ragTesting).toBe('B')
    await pb
    expect(s.ragTesting).toBeNull()
  })
})

describe('Y-32: learn.commit 代守卫', () => {
  it('A 书 commit 在途切书（clear 推代）→ 迟到 finally 不解锁，clear 已复位', async () => {
    commitMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20))
      return { sampleFiles: [], quoteFiles: [] }
    })
    const s = useLearnStore()
    // 候选项 + 勾选
    s.samples = [{ 场景: '战斗', 正文: '样A', 出处: 'c', 章号: 1, 打分: 80 } as never]
    s.toggleSample(s.samples[0]!)
    const p = s.commit('bookA')
    expect(s.committing).toBe(true)
    s.clear() // 切书：推代 + 复位（Y-32 修复点：committing 也复位）
    expect(s.committing).toBe(false)
    await p
    // 迟到 finally 查代不过 → 不把（可能已开启的）新 commit 提前解锁
    expect(s.committing).toBe(false)
  })

  it('正常路径：commit 完成后解锁（既有行为保持）', async () => {
    commitMock.mockResolvedValue({ sampleFiles: [], quoteFiles: [] })
    const s = useLearnStore()
    s.samples = [{ 场景: '战斗', 正文: '样A', 出处: 'c', 章号: 1, 打分: 80 } as never]
    s.toggleSample(s.samples[0]!)
    await s.commit('bookA')
    expect(s.committing).toBe(false)
  })
})

describe('MP-1（专项重评）: 删提供方/删 RAG 清测试结果缓存', () => {
  it('remove() 后 testResults/modelsByProvider/probeModels 不再残留该 id', async () => {
    deleteMock.mockResolvedValue({ currentId: null, revision: 2 })
    const s = useProviderStore()
    s.providers = [{ id: 'A' } as never]
    s.testResults = new Map([['A', { ok: true }]])
    s.modelsByProvider = new Map([['A', ['m1']]])
    s.probeModels = new Map([['A', 'm1']])
    await s.remove('A')
    expect(s.testResults.has('A')).toBe(false) // 修复点：删提供方清测试结果缓存
    expect(s.modelsByProvider.has('A')).toBe(false)
    expect(s.probeModels.has('A')).toBe(false)
  })

  it('removeRag() 后 ragTestResults 不再残留该 id', async () => {
    deleteRagMock.mockResolvedValue({ revision: 2 })
    const s = useProviderStore()
    s.ragProviders = [{ id: 'R' } as never]
    s.ragTestResults = new Map([['R', { ok: true }]])
    await s.removeRag('R')
    expect(s.ragTestResults.has('R')).toBe(false) // 修复点：删 RAG 配置清测试结果缓存
  })
})
