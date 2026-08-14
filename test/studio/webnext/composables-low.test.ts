/**
 * P2-TST-1（低优先）：useFocusTrap / useHotkeys / useAppActions / useHeartbeat / useSse。
 *
 * DOM 相关用 happy-dom（文件级环境注释）。
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref, nextTick, h, render } from 'vue'

// ── mock api 层 ─────────────────────────────────
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  apiFetch: vi.fn(),
  getToken: vi.fn(() => 'token-123'),
}))
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

import { apiFetch, getToken } from '../../../src/studio/web-next/src/api/client'
import { useFocusTrap } from '../../../src/studio/web-next/src/composables/useFocusTrap'
import { useHotkeys } from '../../../src/studio/web-next/src/composables/useHotkeys'
import { useAppActions } from '../../../src/studio/web-next/src/composables/useAppActions'
import { useHeartbeat, serverOnline } from '../../../src/studio/web-next/src/composables/useHeartbeat'
import { useSse } from '../../../src/studio/web-next/src/composables/useSse'

const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // 重置模块级 serverOnline（useHeartbeat 共享）
  serverOnline.value = true
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useFocusTrap', () => {
  it('挂载聚焦第一个可交互元素', async () => {
    document.body.innerHTML = '<div tabindex="-1" id="trap"><button id="a">A</button><button id="b">B</button></div>'
    const trap = document.getElementById('trap')!
    const refObj = ref<HTMLElement | null>(trap)
    useFocusTrap(refObj)
    await nextTick()
    expect(document.activeElement).toBe(document.getElementById('a'))
  })

  it('Tab 循环：末元素 Tab → 聚焦首个', async () => {
    document.body.innerHTML = '<div tabindex="-1" id="trap"><button id="a">A</button><button id="b">B</button></div>'
    const trap = document.getElementById('trap')!
    const refObj = ref<HTMLElement | null>(trap)
    useFocusTrap(refObj)
    await nextTick()
    // 聚焦末元素后 Tab → 回首个
    ;(document.getElementById('b') as HTMLElement).focus()
    const evt = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })
    document.dispatchEvent(evt)
    expect(document.activeElement).toBe(document.getElementById('a'))
  })

  it('ref 清空（v-if 关闭）→ 归还焦点', async () => {
    document.body.innerHTML = '<button id="trigger">触发</button><div tabindex="-1" id="trap"><button>A</button></div>'
    const trigger = document.getElementById('trigger')!
    trigger.focus()
    const trap = document.getElementById('trap')!
    const refObj = ref<HTMLElement | null>(trap)
    useFocusTrap(refObj)
    await nextTick()
    refObj.value = null
    await nextTick()
    expect(document.activeElement).toBe(trigger)
  })
})

describe('useHotkeys', () => {
  /** useHotkeys 在 onMounted 注册监听 → 需组件上下文挂载 */
  function mountHotkeys(): void {
    const comp = { setup: () => useHotkeys(), render: () => h('div') }
    const holder = document.createElement('div')
    document.body.appendChild(holder)
    render(h(comp), holder)
  }

  it('⌘S → 保存 activeDoc', async () => {
    const ws = (await import('../../../src/studio/web-next/src/stores/workspace')).useWorkspaceStore()
    const doc = (await import('../../../src/studio/web-next/src/stores/doc')).useDocStore()
    // 设 activeDocId + mock save
    ws.activeDocId = 'doc-1'
    doc.save = vi.fn().mockResolvedValue(undefined)
    mountHotkeys()
    const evt = new KeyboardEvent('keydown', { key: 's', metaKey: true, cancelable: true })
    window.dispatchEvent(evt)
    expect(doc.save).toHaveBeenCalledWith('doc-1', 'manual')
  })

  it('⌘P → 打开命令面板', async () => {
    const ui = (await import('../../../src/studio/web-next/src/stores/ui')).useUiStore()
    ui.openPalette = vi.fn()
    mountHotkeys()
    const evt = new KeyboardEvent('keydown', { key: 'p', metaKey: true, cancelable: true })
    window.dispatchEvent(evt)
    expect(ui.openPalette).toHaveBeenCalled()
  })

  it('无 metaKey → 不触发', async () => {
    const ws = (await import('../../../src/studio/web-next/src/stores/workspace')).useWorkspaceStore()
    const doc = (await import('../../../src/studio/web-next/src/stores/doc')).useDocStore()
    ws.activeDocId = 'doc-1'
    doc.save = vi.fn()
    mountHotkeys()
    const evt = new KeyboardEvent('keydown', { key: 's', cancelable: true })
    window.dispatchEvent(evt)
    expect(doc.save).not.toHaveBeenCalled()
  })
})

describe('useAppActions', () => {
  it('actions 含 8 个标准动作 + dispatch 命中执行', async () => {
    const ui = (await import('../../../src/studio/web-next/src/stores/ui')).useUiStore()
    ui.openSettings = vi.fn()
    const { actions, dispatch } = useAppActions()
    expect(actions.map((a) => a.id)).toContain('settings')
    expect(dispatch('settings')).toBe(true)
    expect(ui.openSettings).toHaveBeenCalled()
  })

  it('dispatch 未知 id → false 不执行', () => {
    const { dispatch } = useAppActions()
    expect(dispatch('not-exist')).toBe(false)
  })

  it('theme 动作调 useTheme.toggle → prefs.theme 切暗', async () => {
    const prefs = (await import('../../../src/studio/web-next/src/stores/prefs')).usePrefsStore()
    prefs.theme = 'light'
    const { dispatch } = useAppActions()
    expect(dispatch('theme')).toBe(true)
    expect(prefs.theme).toBe('dark')
  })
})

describe('useHeartbeat', () => {
  it('进书 → 立即 beat（POST）+ online 更新', async () => {
    apiFetchMock.mockResolvedValue({ ok: true })
    const name = ref<string | null>('书A')
    useHeartbeat(() => name.value)
    await Promise.resolve() // beat 异步
    expect(apiFetchMock).toHaveBeenCalledWith('/api/books/%E4%B9%A6A/heartbeat', { method: 'POST' })
    expect(serverOnline.value).toBe(true)
  })

  it('beat 失败 → serverOnline false', async () => {
    apiFetchMock.mockRejectedValue(new Error('offline'))
    const name = ref<string | null>('书A')
    useHeartbeat(() => name.value)
    await Promise.resolve()
    expect(serverOnline.value).toBe(false)
  })

  it('无书名 → 不 beat', async () => {
    useHeartbeat(() => null)
    await Promise.resolve()
    expect(apiFetchMock).not.toHaveBeenCalled()
  })
})

describe('useSse', () => {
  class MockES {
    static instances: MockES[] = []
    onopen: (() => void) | null = null
    onerror: (() => void) | null = null
    onmessage: ((e: MessageEvent) => void) | null = null
    url = ''
    closed = false
    constructor(url: string) {
      this.url = url
      MockES.instances.push(this)
    }
    close(): void {
      this.closed = true
    }
  }

  it('进书 → EventSource 连接（带 token）→ onmessage 分流 chat/workbench', async () => {
    vi.stubGlobal('EventSource', MockES)
    MockES.instances = []
    const name = ref('书A')
    useSse(name)
    await nextTick()
    expect(MockES.instances).toHaveLength(1)
    expect(MockES.instances[0]!.url).toContain('/api/books/%E4%B9%A6A/stream')
    expect(getToken).toHaveBeenCalled()

    // onmessage → workbench dispatch
    const wb = (await import('../../../src/studio/web-next/src/stores/workbench')).useWorkbenchStore()
    wb.dispatch = vi.fn()
    MockES.instances[0]!.onmessage?.({ data: JSON.stringify({ type: 'task_start' }) } as MessageEvent)
    expect(wb.dispatch).toHaveBeenCalledWith({ type: 'task_start' })
  })

  it('切书 → 断开旧 + 重连新', async () => {
    vi.stubGlobal('EventSource', MockES)
    MockES.instances = []
    const name = ref('书A')
    useSse(name)
    await nextTick()
    expect(MockES.instances).toHaveLength(1)
    name.value = '书B'
    await nextTick()
    expect(MockES.instances).toHaveLength(2)
    expect(MockES.instances[0]!.closed).toBe(true)
    expect(MockES.instances[1]!.url).toContain('/api/books/%E4%B9%A6B/stream')
  })

  it('errorCount 超阈值 → 指数退避重连（fake timers）', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('EventSource', MockES)
    MockES.instances = []
    const name = ref('书A')
    useSse(name)
    await nextTick()
    const es0 = MockES.instances[0]!
    // 6 次 error（>5 阈值）→ 接管重连
    for (let i = 0; i < 6; i++) es0.onerror?.()
    vi.advanceTimersByTime(2_100) // 首次退避 2s
    expect(MockES.instances.length).toBeGreaterThanOrEqual(2)
  })
})
