/**
 * N-12（第五十四轮）回归：provider store refresh() 操作代守卫。
 *
 * 并发两次 refresh，先发的慢响应迟到不回填——后发者生效（与 check/shelf store 同款
 * opGen 纪律）。只 mock getProviders，其余 api/providers 导出透传原模块。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/providers', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getProviders: mocks.getProviders,
}))

import { useProviderStore } from '../../../src/studio/web-next/src/stores/provider'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

function providersDto(ids: string[]): { providers: { id: string }[]; currentId: string | null; currentModel: string | null; tiers: { creative: { model: string; effort: string } }; revision: number } {
  return {
    providers: ids.map((id) => ({ id })),
    currentId: ids[0] ?? null,
    currentModel: null,
    tiers: { creative: { model: '', effort: 'xhigh' } },
    revision: 1,
  }
}

describe('N-12 · provider refresh 操作代', () => {
  it('并发两次 refresh → 后发者生效（慢响应迟到不回填旧数据）', async () => {
    let resolveSlow!: (v: ReturnType<typeof providersDto>) => void
    mocks.getProviders.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveSlow = r
        }),
    )
    mocks.getProviders.mockResolvedValueOnce(providersDto(['b']))
    const s = useProviderStore()
    const p1 = s.refresh()
    const p2 = s.refresh() // 后发：先返回
    resolveSlow(providersDto(['a'])) // 先发的慢响应迟到
    await Promise.all([p1, p2])
    expect(s.providers.map((p) => p.id)).toEqual(['b'])
    expect(s.loading).toBe(false)
  })
})
