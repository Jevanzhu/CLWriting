// @vitest-environment happy-dom
/**
 * R67-18（十五轮）回归：FocusStatsBar 章目标 config 拉取的请求代守卫。
 *
 * 快速切书时 A 书的 getConfig 慢响应迟归，旧实现无守卫直接 config.value = A 配置，
 * 把 A 书的 chapter_target_words 串进 B 书的目标区显示；守卫后代数不符的迟归弃用。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
}))
vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getBookPrefs: vi.fn(async () => ({})),
  putBookPrefs: vi.fn(async () => ({})),
  getGlobalPrefs: vi.fn(async () => ({})),
  putGlobalPrefs: vi.fn(async () => ({})),
}))

import FocusStatsBar from '../../../src/studio/web-next/src/components/shell/FocusStatsBar.vue'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.getConfig.mockReset()
})

describe('R67-18: config 拉取请求代守卫', () => {
  it('A 书慢响应迟归不覆盖 B 书配置（目标区显示 B 书字数目标）', async () => {
    // A 书请求挂起（慢），B 书请求立即回
    let resolveA!: (v: { book: { chapter_target_words: number } }) => void
    const slowA = new Promise<{ book: { chapter_target_words: number } }>((r) => {
      resolveA = r
    })
    mocks.getConfig.mockImplementation((name: string) =>
      name === '书A' ? slowA : Promise.resolve({ book: { chapter_target_words: 2222 } }),
    )

    const ws = useWorkspaceStore()
    ws.bookName = '书A'
    ws.activeDocId = null
    const w = mount(FocusStatsBar)
    await flushPromises()

    // 快速切书：B 请求发出并先回
    ws.bookName = '书B'
    await flushPromises()
    // A 的慢响应此刻迟归（代数已过期 → 弃用）
    resolveA({ book: { chapter_target_words: 1111 } })
    await flushPromises()

    // 目标区显示 B 的 2222，不是 A 迟归的 1111
    const text = w.text()
    expect(text).toContain('2,222')
    expect(text).not.toContain('1,111')
  })

  it('守恒回归：无并发迟归时正常书配置生效（目标区显示该书字数目标）', async () => {
    mocks.getConfig.mockResolvedValue({ book: { chapter_target_words: 3333 } })
    const ws = useWorkspaceStore()
    ws.bookName = '守恒书'
    ws.activeDocId = null
    const w = mount(FocusStatsBar)
    await flushPromises()
    expect(w.text()).toContain('3,333')
  })
})
