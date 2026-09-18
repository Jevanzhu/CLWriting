// @vitest-environment happy-dom
/**
 * 0918二轮修复批（F104）：WorkbenchView 切书时 ruleHits 重载恰一次回归。
 *
 * 修复前 bookName 注册两个 watch（第一个 immediate：清残留 + refreshState；第二个：
 * loadRuleHits）+ onMounted 初载 loadRuleHits——切书清理逻辑分裂两处，违背「切书
 * 清理单点」纪律。修复后 loadRuleHits 并入第一个 watch（immediate 兼初载，原
 * onMounted 初载随并删除防双调）。本文件钉：初载恰一次、切书恰一次（探测点在
 * trace-stats store 的 getStats——api 层有同书在途去重会掩盖同书双调，store 层
 * 每次 loadRuleHits 调用必留痕），且新书的 ruleHits 真正落到 WbAdvanced。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import WorkbenchView from '../../../src/studio/web-next/src/views/WorkbenchView.vue'
import { useProviderStore } from '../../../src/studio/web-next/src/stores/provider'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useTraceStatsStore } from '../../../src/studio/web-next/src/stores/trace-stats'

const streamMocks = vi.hoisted(() => ({
  getState: vi.fn(),
  spawnRole: vi.fn(),
  interrupt: vi.fn(),
  saveDraft: vi.fn(),
  autoWrite: vi.fn(),
  getDraftPrompt: vi.fn(),
  generateOutline: vi.fn(),
  generateLeadUpdates: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/workbench', () => streamMocks)
const traceMocks = vi.hoisted(() => ({ getTraceStats: vi.fn() }))
vi.mock('../../../src/studio/web-next/src/api/trace-stats', () => traceMocks)
const booksMocks = vi.hoisted(() => ({ getConfig: vi.fn(async () => ({})) }))
vi.mock('../../../src/studio/web-next/src/api/books', () => booksMocks)

const HITS_A = [{ ruleId: 'A-r1', hits: 2, lastHit: '2026-09-18T00:00:00Z', recentMessages: [] }]
const HITS_B = [{ ruleId: 'B-r1', hits: 5, lastHit: '2026-09-18T00:00:00Z', recentMessages: [] }]

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  streamMocks.getState.mockResolvedValue({ nextChapter: 3 })
  traceMocks.getTraceStats.mockImplementation(async (name: string) =>
    name === '书A' ? { ruleHits: HITS_A } : { ruleHits: HITS_B },
  )
  vi.spyOn(useProviderStore(), 'refresh').mockResolvedValue(undefined)
  vi.spyOn(useTreeStore(), 'load').mockResolvedValue(undefined)
})

function mountView() {
  return mount(WorkbenchView, {
    props: { bookName: '书A' },
    global: {
      stubs: { ChatPanel: true, WbStateCard: true, WbDraftCard: true, WbAdvanced: true, WbHealCard: true, WbUsageCard: true },
    },
  })
}

describe('F104：切书清理单点（bookName 单 watch）下的 ruleHits 重载', () => {
  it('初载恰一次（immediate watch 兼初载，无 onMounted 双调无漏调）', async () => {
    const getStats = vi.spyOn(useTraceStatsStore(), 'getStats')
    const wrapper = mountView()
    await flushPromises()

    expect(getStats).toHaveBeenCalledTimes(1)
    expect(getStats).toHaveBeenCalledWith('书A')
    expect(traceMocks.getTraceStats).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('切书 A→B → ruleHits 重载恰一次（带新书名），新书命中落到 WbAdvanced', async () => {
    const getStats = vi.spyOn(useTraceStatsStore(), 'getStats')
    const wrapper = mountView()
    await flushPromises()
    expect(getStats).toHaveBeenCalledTimes(1)

    await wrapper.setProps({ bookName: '书B' })
    await flushPromises()

    // 恰一次重载（残留第二个 watch 或漏并都会破坏此计数）
    expect(getStats).toHaveBeenCalledTimes(2)
    expect(getStats).toHaveBeenLastCalledWith('书B')
    // 数据真正回流到高级区（ruleHits 面随书切换）
    const advanced = wrapper.findComponent({ name: 'WbAdvanced' })
    expect(advanced.exists()).toBe(true)
    expect(advanced.props('ruleHits')).toEqual(HITS_B)
    wrapper.unmount()
  })
})
