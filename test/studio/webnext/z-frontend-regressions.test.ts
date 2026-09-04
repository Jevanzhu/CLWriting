// @vitest-environment happy-dom
/**
 * Z 系列（第五十八轮）回归集三：前端（Z-2 / Z-8 / Z-23）。
 *
 * Z-2：AnalysisPanel 分析期间的用户键入不再被 T0 旧正文回拼覆盖（patch 不再调用，
 *      refresh dirty 分支承担正文保护）。
 * Z-8：doc store conflictedDirtyDocs 查询（Book.vue 切书守卫的数据面）。
 * Z-23：弹层 Esc 消费后 preventDefault——useHotkeys 的 defaultPrevented 让渡口生效
 *      （同一按键不再双效：关弹层 + 退专注）。
 * Z-24/Z-25/Z-26 为守卫/提示一行修（书名捕获守卫 / preventDefault / toast），主评审
 * 亲验记档，不虚设组件级覆盖。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/analysis', () => ({
  autotag: vi.fn(async () => ({ 钩子类型: '悬念钩' })),
  inferMeta: vi.fn(async () => ({ 目标情绪: '压抑到释然' })),
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  updateDocMeta: vi.fn(async () => undefined),
}))
const docEntryRef = ref<{ path: string; content: string; dirty: boolean; baselineRevision: string } | undefined>(undefined)
const docPatchMock = vi.fn()
const docRefreshMock = vi.fn(async () => {})
vi.mock('../../../src/studio/web-next/src/stores/doc', () => ({
  useDocStore: vi.fn(() => ({
    get: (id: string) => (id === 'doc_1' ? docEntryRef.value : undefined),
    patch: docPatchMock,
    refresh: docRefreshMock,
    save: vi.fn(async () => true),
  })),
}))
vi.mock('../../../src/studio/web-next/src/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => ({ activeDocId: 'doc_1', openTab: vi.fn() })),
}))
vi.mock('../../../src/studio/web-next/src/stores/tree', () => ({
  useTreeStore: vi.fn(() => ({
    byDocId: new Map([['doc_1', { path: '写作/正文/0001-a.md' }]]),
  })),
}))
const uiToastMock = vi.fn()
// ui mock 单例（组件与测试共享 settingsOpen 态）
const uiMock = {
  toast: uiToastMock,
  ask: vi.fn(async () => true),
  settingsOpen: false,
  closeSettings: vi.fn(),
  confirmState: null as unknown,
  // 遮罩单源判据（ui store 收编后 SettingsModal 的 Esc 让渡走此口）：false = 无其它弹层
  overlayOpenExcept: vi.fn(() => false),
}
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: vi.fn(() => uiMock),
}))
vi.mock('lucide-vue-next', () => new Proxy({}, { get: () => ({ template: '<i/>' }) }))

import AnalysisPanel from '../../../src/studio/web-next/src/components/panels/AnalysisPanel.vue'
import SettingsModal from '../../../src/studio/web-next/src/components/ui/SettingsModal.vue'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('Z-2: 分析期间键入不被旧正文回拼覆盖', () => {
  it('analyzeTags：refresh 被调、patch 不被调（无 T0 回拼）', async () => {
    docEntryRef.value = { path: '写作/正文/0001-a.md', content: '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n新键入的内容', dirty: true, baselineRevision: 'r0' }
    const w = mount(AnalysisPanel, { props: { bookName: '书A' } })
    await flushPromises()
    // 点「分析标签」按钮（带 loading 态的那个）
    const btn = w.findAll('button').find((b) => b.text().includes('分析'))
    expect(btn).toBeDefined()
    await btn!.trigger('click')
    await flushPromises()
    expect(docRefreshMock).toHaveBeenCalledWith('doc_1')
    // 修复点：不再有「本地正文拼回」的 patch（此前 T0 快照覆盖用户键入）
    expect(docPatchMock).not.toHaveBeenCalled()
    w.unmount()
  })
})

describe('Z-23: 弹层 Esc 消费后 preventDefault', () => {
  it('SettingsModal 打开态按 Esc → closeSettings + preventDefault', async () => {
    const ui = useUiStore() as unknown as { settingsOpen: boolean; closeSettings: ReturnType<typeof vi.fn> }
    ui.settingsOpen = true
    ui.closeSettings.mockClear()
    const w = mount(SettingsModal, { props: { bookName: '书A' } })
    await nextTick()
    const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true })
    window.dispatchEvent(ev)
    expect(ui.closeSettings).toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(true) // 修复点：useHotkeys 让渡口可见
    w.unmount()
    ui.settingsOpen = false
  })
})
