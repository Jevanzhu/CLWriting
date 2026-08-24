// @vitest-environment happy-dom
/**
 * 专注模式（完全沉浸）测试：
 * - EditorView：focus 态隐藏 EditorDocHead/page-title、editor-focus class、CmHost 打字机 prop
 * - useHotkeys：Esc 退出专注；弹层打开时让渡；非 focus 态 Esc 不触发；已 preventDefault 的键让渡
 * - workspace：focusMode 不进入持久化 watch（不记忆，刷新即失）；进入/退出驱动全屏桥
 * - WorkspaceShell：全屏退出反向同步（系统手势退全屏 → 连带退出专注）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  getConfig: vi.fn(),
  getBookPrefs: vi.fn(),
  putBookPrefs: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: mocks.getContent,
  saveContent: mocks.saveContent,
  finalizeDoc: mocks.finalizeDoc,
  updateChapterMetaDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
  getTree: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  ApiError: class ApiError extends Error {
    status = 0
    code?: string
  },
  getToken: vi.fn(() => null),
}))
vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getBookPrefs: mocks.getBookPrefs,
  putBookPrefs: mocks.putBookPrefs,
}))
// CodeMirror 在 happy-dom 起不来——stub 掉
vi.mock('../../../src/studio/web-next/src/editor/CmHost.vue', () => ({
  default: {
    name: 'CmHost',
    props: ['modelValue', 'mode', 'readonly', 'typewriter', 'historyKey'],
    template: '<div class="cm-host-stub" />',
  },
}))

import { defineComponent, h, nextTick } from 'vue'
import EditorView from '../../../src/studio/web-next/src/views/EditorView.vue'
import WorkspaceShell from '../../../src/studio/web-next/src/components/shell/WorkspaceShell.vue'
import { useHotkeys } from '../../../src/studio/web-next/src/composables/useHotkeys'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const BOOK = 'test-book'

function makeNode(docId: string): TreeNode {
  return {
    path: '写作/正文/第1章-标题.md',
    name: '第1章-标题.md',
    isDirectory: false,
    role: 'chapter',
    docId,
    status: 'draft',
    children: [],
  }
}

/** 挂载 useHotkeys 的宿主组件（composable 需组件生命周期挂 window 监听） */
const HotkeyHost = defineComponent({
  setup() {
    useHotkeys()
    return () => h('div')
  },
})

function pressKey(key: string, opts: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts }))
}

/** 注入桌面全屏桥 mock（captured = onFullScreenChange 注册的回调）；用完 restoreDesktopBridge 清理 */
interface FsBridgeMock {
  setFullScreen: ReturnType<typeof vi.fn>
  onFullScreenChange: ReturnType<typeof vi.fn>
  captured: ((fs: boolean) => void) | null
}
function mockDesktopBridge(): FsBridgeMock {
  const m: FsBridgeMock = {
    setFullScreen: vi.fn(() => Promise.resolve()),
    onFullScreenChange: vi.fn((cb: (fs: boolean) => void) => {
      m.captured = cb
      return () => {}
    }),
    captured: null,
  }
  ;(window as unknown as Record<string, unknown>).clwritingDesktop = m
  return m
}

function restoreDesktopBridge(): void {
  delete (window as unknown as Record<string, unknown>).clwritingDesktop
}

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.getContent.mockReset().mockResolvedValue('---\n标题: 标题\n---\n\n正文')
  mocks.saveContent.mockReset()
  mocks.finalizeDoc.mockReset()
  mocks.getConfig.mockReset().mockResolvedValue({ kind: 'long' })
  mocks.getBookPrefs.mockReset().mockResolvedValue({})
  mocks.putBookPrefs.mockReset().mockResolvedValue(undefined)
})

describe('EditorView: 专注模式沉浸态', () => {
  async function mountEditor(docId: string) {
    const doc = useDocStore()
    const tree = useTreeStore()
    doc.setBook(BOOK)
    tree.raw = [makeNode(docId)]
    const w = mount(EditorView, { props: { docId } })
    await flushPromises()
    await vi.waitFor(() => expect(doc.get(docId)).toBeDefined())
    return w
  }

  it('focus 态：EditorDocHead/page-title 隐藏，editor-focus class 挂上，打字机 prop 开启', async () => {
    const ws = useWorkspaceStore()
    const w = await mountEditor('d1')

    // 非 focus：顶栏与标题在，无收窄 class
    expect(w.findComponent({ name: 'EditorDocHead' }).exists()).toBe(true)
    expect(w.find('.page-title-area').exists()).toBe(true)
    expect(w.find('.editor-view.editor-focus').exists()).toBe(false)
    expect(w.findComponent({ name: 'CmHost' }).props('typewriter')).toBe(false)

    // 进专注：顶栏/标题卸载，收窄 class 挂上，打字机开启
    ws.toggleFocus()
    await flushPromises()
    expect(w.find('.page-title-area').exists()).toBe(false)
    expect(w.find('.editor-view.editor-focus').exists()).toBe(true)
    expect(w.findComponent({ name: 'CmHost' }).props('typewriter')).toBe(true)
    // EditorDocHead 是子组件，focus 态不应存在
    expect(w.findComponent({ name: 'EditorDocHead' }).exists()).toBe(false)
  })

  it('退出专注：顶栏/标题恢复', async () => {
    const ws = useWorkspaceStore()
    ws.toggleFocus()
    const w = await mountEditor('d1')
    expect(w.find('.page-title-area').exists()).toBe(false)

    ws.toggleFocus()
    await flushPromises()
    expect(w.find('.page-title-area').exists()).toBe(true)
    expect(w.findComponent({ name: 'EditorDocHead' }).exists()).toBe(true)
  })
})

describe('useHotkeys: Esc 退出专注', () => {
  it('focus 态按 Esc → 退出', () => {
    const ws = useWorkspaceStore()
    ws.toggleFocus()
    mount(HotkeyHost)
    pressKey('Escape')
    expect(ws.focusMode).toBe(false)
  })

  it('非 focus 态按 Esc → 不触发', () => {
    const ws = useWorkspaceStore()
    mount(HotkeyHost)
    pressKey('Escape')
    expect(ws.focusMode).toBe(false)
  })

  it('命令面板打开时按 Esc → 让渡（不退专注，面板归自身 Esc 处理）', () => {
    const ws = useWorkspaceStore()
    const ui = useUiStore()
    ws.toggleFocus()
    ui.openPalette()
    mount(HotkeyHost)
    pressKey('Escape')
    expect(ws.focusMode).toBe(true)
    expect(ui.paletteOpen).toBe(true)
  })

  it('确认弹窗打开时按 Esc → 让渡', () => {
    const ws = useWorkspaceStore()
    const ui = useUiStore()
    ws.toggleFocus()
    void ui.ask({ title: 't', message: 'm' })
    mount(HotkeyHost)
    pressKey('Escape')
    expect(ws.focusMode).toBe(true)
  })

  it('已 preventDefault 的 Esc → 让渡（CM 搜索面板等编辑器内 Esc 已被消费，关面板不连带退专注）', () => {
    const ws = useWorkspaceStore()
    ws.toggleFocus()
    mount(HotkeyHost)
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    e.preventDefault() // 模拟 CodeMirror keymap 处理后冒泡到 window 的按键
    window.dispatchEvent(e)
    expect(ws.focusMode).toBe(true)
  })

  it('B-9: IME 组合期 Esc（isComposing / keyCode 229）→ 让渡（收候选框不连带退专注）', () => {
    const ws = useWorkspaceStore()
    ws.toggleFocus()
    mount(HotkeyHost)
    // 组合期按键：isComposing 判据
    pressKey('Escape', { isComposing: true } as KeyboardEventInit)
    expect(ws.focusMode).toBe(true)
    // 组合期兼容判据：keyCode 229（部分输入法不置 isComposing）
    const e229 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    Object.defineProperty(e229, 'keyCode', { value: 229 })
    window.dispatchEvent(e229)
    expect(ws.focusMode).toBe(true)
    // 对照：非组合期 Esc 正常退出
    pressKey('Escape')
    expect(ws.focusMode).toBe(false)
  })
})

describe('workspace: 专注驱动全屏', () => {
  afterEach(() => restoreDesktopBridge())

  it('进入/退出专注 → setFullScreen(true/false)（桌面桥路径）', () => {
    const bridge = mockDesktopBridge()
    const ws = useWorkspaceStore()
    ws.toggleFocus()
    expect(ws.focusMode).toBe(true)
    expect(bridge.setFullScreen).toHaveBeenCalledWith(true)
    ws.toggleFocus()
    expect(ws.focusMode).toBe(false)
    expect(bridge.setFullScreen).toHaveBeenLastCalledWith(false)
  })

  it('无桌面桥（浏览器/happy-dom）→ 不抛（HTML5 全屏降级或 no-op）', () => {
    const ws = useWorkspaceStore()
    expect(() => ws.toggleFocus()).not.toThrow()
    expect(() => ws.toggleFocus()).not.toThrow()
  })
})

describe('WorkspaceShell: 全屏退出反向同步', () => {
  afterEach(() => restoreDesktopBridge())

  it('系统手势退出全屏（onFullScreenChange cb(false)）→ 连带退出专注', async () => {
    const bridge = mockDesktopBridge()
    const ws = useWorkspaceStore()
    const w = mount(WorkspaceShell, { props: { bookName: BOOK }, shallow: true })
    expect(bridge.onFullScreenChange).toHaveBeenCalled()
    ws.setFocus(true)
    expect(ws.focusMode).toBe(true)

    bridge.captured?.(false) // 主进程 leave-full-screen 转发
    await nextTick()
    expect(ws.focusMode).toBe(false)
    w.unmount()
  })

  it('进入全屏（cb(true)）不反向改专注态（全屏 ≠ 专注）', async () => {
    const bridge = mockDesktopBridge()
    const ws = useWorkspaceStore()
    const w = mount(WorkspaceShell, { props: { bookName: BOOK }, shallow: true })
    bridge.captured?.(true)
    await nextTick()
    expect(ws.focusMode).toBe(false)
    w.unmount()
  })

  it('无桌面桥：document fullscreenchange（浏览器降级路径）退出全屏 → 退出专注', async () => {
    const ws = useWorkspaceStore()
    const w = mount(WorkspaceShell, { props: { bookName: BOOK }, shallow: true })
    ws.setFocus(true)
    document.dispatchEvent(new Event('fullscreenchange')) // fullscreenElement 为空 → cb(false)
    await nextTick()
    expect(ws.focusMode).toBe(false)
    w.unmount()
  })
})

describe('workspace: focusMode 不持久化（不记忆）', () => {
  it('切 focus 不触发 prefs.json 写回', async () => {
    vi.useFakeTimers()
    try {
      const ws = useWorkspaceStore()
      ws.setBook(BOOK)
      await vi.advanceTimersByTimeAsync(0)
      await flushPromises()
      expect(mocks.getBookPrefs).toHaveBeenCalled()
      mocks.putBookPrefs.mockClear()

      ws.toggleFocus()
      await vi.advanceTimersByTimeAsync(600)
      expect(mocks.putBookPrefs).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
