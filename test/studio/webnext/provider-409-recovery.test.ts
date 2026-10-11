/**
 * R40-39（四十轮）回归：provider store 写端点 409（多窗 expectedRevision 冲突）
 * 恢复链——刷新 + 明确提示，不再叠加通用错误 toast。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getRagProviders: vi.fn(),
  updateProvider: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/providers', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getProviders: mocks.getProviders,
  getRagProviders: mocks.getRagProviders,
  updateProvider: mocks.updateProvider,
}))

import { useProviderStore } from '../../../src/studio/web-next/src/stores/provider'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import { ApiError } from '../../../src/studio/web-next/src/api/client'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.getProviders.mockResolvedValue({
    providers: [{ id: 'p1' }],
    currentId: 'p1',
    currentModel: null,
    tiers: { creative: { model: '', effort: 'xhigh' } },
    revision: 7,
  })
  mocks.getRagProviders.mockResolvedValue({ ragProviders: [], revision: 7 })
})

const INPUT = { name: 'n', protocol: 'openai' as const, auth: 'bearer' as const, baseUrl: 'http://x', apiKey: 'k' }

describe('R40-39: provider 409 恢复链', () => {
  it('update 吃 409 → 刷新（getProviders 重拉）+ warning 提示，不叠通用错误 toast', async () => {
    mocks.updateProvider.mockRejectedValue(new ApiError('已在其他窗口被修改', 409))
    const store = useProviderStore()
    const r = await store.update('p1', INPUT)
    expect(r).toBe(false)
    expect(mocks.getProviders).toHaveBeenCalled() // refreshAll 刷新
    expect(mocks.getRagProviders).toHaveBeenCalled()
    const ui = useUiStore()
    expect(ui.toasts.at(-1)?.kind).toBe('warning')
    expect(ui.toasts.at(-1)?.msg).toContain('其他窗口')
    expect(ui.toasts.at(-1)?.msg).not.toContain('保存失败')
  })

  it('非 409 错误（500）→ 不触发恢复链（不刷新），走通用错误 toast', async () => {
    mocks.updateProvider.mockRejectedValue(new ApiError('服务端炸了', 500))
    const store = useProviderStore()
    const r = await store.update('p1', INPUT)
    expect(r).toBe(false)
    expect(mocks.getProviders).not.toHaveBeenCalled()
    const ui = useUiStore()
    expect(ui.toasts.at(-1)?.kind).toBe('error')
  })
})

// ── 共享 revision：AI / RAG 两域写同一份 providers.json、共用同一个计数 ──────────

describe('provider: 两域共用 revision 的读写口径', () => {
  /** 服务端事实：src/ai/provider/store.ts 单文件 providers.json + 单 revision 字段，
   *  providers.get 与 rag-providers.get 同回该计数——故按域分 ref 会互相失配，正确解是
   *  「读取响应只许前进」（advanceRevision），PROVIDERS/RAG 的写响应亦同。 */
  function providersDto(revision: number) {
    return {
      providers: [{ id: 'p1' }],
      currentId: 'p1',
      currentModel: null,
      tiers: { creative: { model: '', effort: 'xhigh' } },
      revision,
    }
  }

  it('两域并发刷新：先发起域的旧读数后返回 → 不回退另一域已采纳的新号（伪 409 来源）', async () => {
    const store = useProviderStore()
    let releaseAi!: () => void
    mocks.getProviders.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseAi = () => resolve(providersDto(3)) // 先发起、读到的号旧
        }),
    )
    mocks.getRagProviders.mockResolvedValueOnce({ ragProviders: [], revision: 9 }) // 后发起、号新
    const all = store.refreshAll()
    for (let i = 0; i < 4; i++) await Promise.resolve()
    expect(store.revision).toBe(9) // RAG 域先落定
    releaseAi() // AI 域的旧读数迟到
    await all
    expect(store.revision).toBe(9) // 回归点：不回退（回退即后续写携陈旧号吃伪 409）
  })

  it('409 恢复链取权威口径：远端号小于本地（服务端 providers.json 被外部重置）也采纳', async () => {
    const store = useProviderStore()
    await store.refreshAll()
    expect(store.revision).toBe(7)
    mocks.getProviders.mockResolvedValue(providersDto(2))
    mocks.getRagProviders.mockResolvedValue({ ragProviders: [], revision: 2 })
    mocks.updateProvider.mockRejectedValueOnce(new ApiError('已在其他窗口被修改', 409))
    const r = await store.update('p1', INPUT)
    expect(r).toBe(false)
    // 权威重读：无条件对齐远端号——取大闸拦不住「服务端号变小」这唯一退化形态
    expect(store.revision).toBe(2)
  })
})
