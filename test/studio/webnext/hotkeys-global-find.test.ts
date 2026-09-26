// @vitest-environment happy-dom
/**
 * 复审-0913-mac适配 P3-7 回归：⌘F 全局查找接线。
 *
 * 修复背景：⌘F 此前仅在编辑器聚焦时由 CM searchKeymap 响应——焦点在外时按 ⌘F
 * 完全无响应，与右键菜单「查找 CmdOrCtrl+F」的暗示不符。修复后：
 * - useHotkeys 挂全局 ⌘F（k==='f' && !e.shiftKey，与 ⌘S/⌘P 同款 preventDefault
 *   与让渡口径）→ 派发 APP_FIND_EVENT；
 * - useAppActions 注册 'find' 动作（系统菜单「查找…」/ 命令面板共用）→ 同事件桥；
 * - EditorView 监听该事件复用右键菜单同一条 cmHost.openSearch() 路径
 *  （接线行为在 editor-view.test.ts）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
}))
// useAppActions 依赖 useRouter——mock 成无实例可调的假 router（本文件不真路由）
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}))

import { useHotkeys } from '../../../src/studio/web-next/src/composables/useHotkeys'
import { useAppActions, APP_FIND_EVENT } from '../../../src/studio/web-next/src/composables/useAppActions'

const HotkeysHost = defineComponent({
  setup: () => {
    useHotkeys()
    return () => ''
  },
})

function pressCmdF(init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true, ...init })
  window.dispatchEvent(e)
  return e
}

/** 收集 APP_FIND_EVENT 的临时监听（返回退订，对齐 preload onMenuAction 口径）。 */
function listenFind(events: Event[]): () => void {
  const onFind = (e: Event): void => {
    events.push(e)
  }
  window.addEventListener(APP_FIND_EVENT, onFind)
  return () => window.removeEventListener(APP_FIND_EVENT, onFind)
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('复审-0913-mac适配 P3-7: useHotkeys 全局 ⌘F', () => {
  it('焦点在编辑器外按 ⌘F → preventDefault + 派发 APP_FIND_EVENT', () => {
    mount(HotkeysHost)
    const events: Event[] = []
    const off = listenFind(events)
    try {
      const e = pressCmdF()
      expect(e.defaultPrevented).toBe(true)
      expect(events).toHaveLength(1)
    } finally {
      off()
    }
  })

  it('事件已被消费（defaultPrevented，编辑器聚焦时 CM searchKeymap 场景）→ 让渡不重复派发', () => {
    mount(HotkeysHost)
    const events: Event[] = []
    const off = listenFind(events)
    try {
      // 模拟 CM keymap 已消费：preventDefault 后事件仍冒泡到 window
      const consumed = new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true })
      consumed.preventDefault()
      window.dispatchEvent(consumed)
      expect(events).toHaveLength(0)
    } finally {
      off()
    }
  })

  it('IME 组合期（isComposing）让渡：不派发、不 preventDefault', () => {
    mount(HotkeysHost)
    const events: Event[] = []
    const off = listenFind(events)
    try {
      const e = pressCmdF({ isComposing: true })
      expect(e.defaultPrevented).toBe(false)
      expect(events).toHaveLength(0)
    } finally {
      off()
    }
  })

  it('⌘⇧F 不触发查找（shift 变体归系统菜单「专注模式」accelerator 口径）', () => {
    mount(HotkeysHost)
    const events: Event[] = []
    const off = listenFind(events)
    try {
      const e = pressCmdF({ shiftKey: true })
      expect(e.defaultPrevented).toBe(false)
      expect(events).toHaveLength(0)
    } finally {
      off()
    }
  })
})

describe('复审-0913-mac适配 P3-7: useAppActions find 动作分发', () => {
  it("dispatch('find') → 派发 APP_FIND_EVENT（系统菜单「查找…」与命令面板共用链路）", () => {
    const { dispatch } = useAppActions()
    const events: Event[] = []
    const off = listenFind(events)
    try {
      expect(dispatch('find')).toBe(true)
      expect(events).toHaveLength(1)
    } finally {
      off()
    }
  })

  it('未注册的 actionKey 返回 false（未知菜单 key 静默 no-op 口径不变）', () => {
    const { dispatch } = useAppActions()
    expect(dispatch('不存在的动作')).toBe(false)
  })
})
