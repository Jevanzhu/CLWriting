// @vitest-environment happy-dom
/**
 * R36-21（三十六轮）：onActivated 续轮询缺「仍激活」复检，关窗后可新起后台轮询。
 *
 * 机理：SettingsModal 用 keep-alive 包 tab——关弹窗只 deactivated 不 unmount。
 * onActivated 的 `refreshRagStatus(name).then(...)` 在途期间关窗（onDeactivated 已跑
 * stopRagPolling 停掉旧表），.then 续拍仍会以 ragBuilding=true 条件新起一轮 interval，
 * 关窗后后台持续打旧书 status。修复：ragActive 标记随 activate/deactivate/unmount
 * 置位，续拍前复检吞掉。
 *
 * 测试用 KeepAlive 宿主挂载（对齐真实 SettingsModal 的 keep-alive 语义），show ref
 * 切换 = 开/关弹窗（deactivate/activate）。fake timers 驱动 1.5s 轮询节拍。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, KeepAlive, nextTick, ref, type Ref } from 'vue'
import SettingsBookAnalysis from '../../../src/studio/web-next/src/components/ui/SettingsBookAnalysis.vue'
import { SAVE_CONFIG_KEY } from '../../../src/studio/web-next/src/components/ui/settings-context'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import { usePrefsStore } from '../../../src/studio/web-next/src/stores/prefs'
import type { BookConfig, RagStatus } from '../../../src/studio/web-next/src/api/books'

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getRagStatus: vi.fn(),
  triggerRagBuild: vi.fn(),
  getRagProviders: vi.fn(),
  saveConfig: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
  getRagStatus: mocks.getRagStatus,
  triggerRagBuild: mocks.triggerRagBuild,
}))
vi.mock('../../../src/studio/web-next/src/api/providers', () => ({
  getRagProviders: mocks.getRagProviders,
}))

const IDLE_STATUS: RagStatus = {
  running: false, indexedChapters: 0, chunkCount: 0, model: null,
  ragConfig: {}, providerName: null, legacy: false, lastResult: null,
}
const RUNNING_STATUS: RagStatus = {
  running: true, indexedChapters: 0, chunkCount: 0, model: null,
  ragConfig: {}, providerName: null, legacy: false, lastResult: null,
}

/** KeepAlive 宿主挂载（SettingsModal 同款 keep-alive 语义）；show=false 即「关窗」。 */
async function mountInKeepAlive(show: Ref<boolean>): Promise<ReturnType<typeof mount>> {
  const ui = useUiStore()
  const ws = useWorkspaceStore()
  ui.settingsOpen = true
  ws.bookName = '测试书'
  const Host = defineComponent({
    setup: () => () =>
      h(KeepAlive, null, {
        default: () => (show.value ? [h(SettingsBookAnalysis)] : []),
      }),
  })
  const wrapper = mount(Host, {
    global: { provide: { [SAVE_CONFIG_KEY as symbol]: mocks.saveConfig } },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.getConfig.mockResolvedValue({ kind: 'long', book: { title: '测试书' } } satisfies BookConfig)
  mocks.getRagStatus.mockResolvedValue(IDLE_STATUS)
  mocks.getRagProviders.mockResolvedValue({ ragProviders: [] })
  mocks.triggerRagBuild.mockResolvedValue({ ok: true })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('R36-21：onActivated 续轮询「仍激活」复检', () => {
  it('续轮询刷新在途关窗 → settle 后不新起轮询（修复前后台持续打旧书 status）', async () => {
    vi.useFakeTimers()
    usePrefsStore().setRagEnabled(true)

    // 调用序：#1 mount 直调（idle）；#2 mount onActivated 直调（idle）；
    // #3 轮询第 1 拍（running，保持构建中）；#4 重新 activate 的 refresh（挂起）
    let n = 0
    let pendingResolve!: (s: RagStatus) => void
    mocks.getRagStatus.mockImplementation(() => {
      n++
      if (n === 4) return new Promise<RagStatus>((res) => { pendingResolve = res })
      return Promise.resolve(n <= 2 ? IDLE_STATUS : RUNNING_STATUS)
    })

    const show = ref(true)
    const wrapper = await mountInKeepAlive(show)

    // 建立索引 → ragBuilding=true + 轮询启动
    await wrapper.find('.rag-build-row button').trigger('click')
    await flushPromises()
    vi.advanceTimersByTime(1500) // 第 1 拍：running → 保持构建中
    await flushPromises()
    expect(n).toBe(3)

    // 关窗（deactivate：stopRagPolling + ragActive=false）→ 再开窗（activate：续刷新）
    show.value = false
    await nextTick()
    show.value = true
    await nextTick()
    await flushPromises()
    expect(n).toBe(4) // onActivated 的 refreshRagStatus 在途

    // 刷新在途期间再次关窗——修复前：stopRagPolling 已停掉旧表，但 .then 续拍仍会
    // 以 ragBuilding=true 新起轮询（关窗后后台轮询）
    show.value = false
    await nextTick()
    pendingResolve(RUNNING_STATUS)
    await flushPromises()

    // 修复点：续拍被 ragActive 复检吞掉，无新 interval——走 3 拍不再打接口
    const calls = mocks.getRagStatus.mock.calls.length
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(1500)
      await flushPromises()
    }
    expect(mocks.getRagStatus.mock.calls.length).toBe(calls)
    wrapper.unmount()
  })

  it('仍激活：重新开窗续轮询正常（不误伤）', async () => {
    vi.useFakeTimers()
    usePrefsStore().setRagEnabled(true)

    let n = 0
    mocks.getRagStatus.mockImplementation(() => {
      n++
      return Promise.resolve(n <= 2 ? IDLE_STATUS : RUNNING_STATUS)
    })

    const show = ref(true)
    const wrapper = await mountInKeepAlive(show)

    await wrapper.find('.rag-build-row button').trigger('click')
    await flushPromises()
    vi.advanceTimersByTime(1500) // 轮询第 1 拍（running，保持构建中）
    await flushPromises()
    expect(n).toBe(3)

    // 关窗停表 → 开窗续刷新（running）→ 续轮询启动
    show.value = false
    await nextTick()
    show.value = true
    await nextTick()
    await flushPromises() // onActivated refresh settle → 续轮询
    const calls = mocks.getRagStatus.mock.calls.length
    expect(calls).toBe(4)

    // 续轮询节拍照常打接口（修复点对照：未误伤激活态续拍）
    vi.advanceTimersByTime(1500)
    await flushPromises()
    expect(mocks.getRagStatus.mock.calls.length).toBeGreaterThan(calls)
    wrapper.unmount()
  })
})