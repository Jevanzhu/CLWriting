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
