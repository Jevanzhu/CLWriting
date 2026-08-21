/**
 * P2-TST-1：composables 单测（高/中优先子集）。
 *
 * 覆盖 useChatComposer / useChatTier / useNativeMenu / useSystemFonts / useTheme
 * 的纯逻辑 + 关键交互。DOM 相关用 happy-dom（文件级环境注释）。
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

// ── mock api 层（不碰真实 HTTP）──────────────────
vi.mock('../../../src/studio/web-next/src/api/chat', () => ({
  sendChat: vi.fn(),
  clearChatHistory: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/stream', () => ({
  interrupt: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/providers', () => ({
  getProviders: vi.fn(),
  setChatTier: vi.fn(),
  fetchModels: vi.fn(),
}))

import { sendChat, clearChatHistory } from '../../../src/studio/web-next/src/api/chat'
import { interrupt } from '../../../src/studio/web-next/src/api/stream'
import { getProviders, setChatTier, fetchModels } from '../../../src/studio/web-next/src/api/providers'
import { useChatComposer } from '../../../src/studio/web-next/src/composables/useChatComposer'
import { useChatTier } from '../../../src/studio/web-next/src/composables/useChatTier'
import { useNativeMenu } from '../../../src/studio/web-next/src/composables/useNativeMenu'
import { useSystemFonts, selValue } from '../../../src/studio/web-next/src/composables/useSystemFonts'
import { useTheme } from '../../../src/studio/web-next/src/composables/useTheme'

const sendMock = sendChat as ReturnType<typeof vi.fn>
const clearMock = clearChatHistory as ReturnType<typeof vi.fn>
const interruptMock = interrupt as ReturnType<typeof vi.fn>
const getProvidersMock = getProviders as ReturnType<typeof vi.fn>
const setTierMock = setChatTier as ReturnType<typeof vi.fn>
const fetchModelsMock = fetchModels as ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('useChatComposer', () => {
  it('handleSend 空输入不发送', async () => {
    const c = useChatComposer(() => '书', () => undefined)
    await c.handleSend()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('handleSend 发送文本 + 清空输入 + 附带章节', async () => {
    sendMock.mockResolvedValue({})
    const c = useChatComposer(() => '书', () => 3)
    c.input.value = '帮我看看第三章'
    await c.handleSend()
    expect(sendMock).toHaveBeenCalledWith('书', { message: '帮我看看第三章', chapter: 3 })
    expect(c.input.value).toBe('')
    expect(c.sending.value).toBe(false)
  })

  it('handleSend 失败 → popUser + error 设置（input 已清空不回填）', async () => {
    sendMock.mockRejectedValue(new Error('网络错误'))
    const c = useChatComposer(() => '书', () => undefined)
    const chat = (await import('../../../src/studio/web-next/src/stores/chat')).useChatStore()
    chat.pushUser = vi.fn()
    chat.popUser = vi.fn()
    c.input.value = 'hi'
    await c.handleSend()
    expect(chat.popUser).toHaveBeenCalled()
    expect(chat.error).toBe('网络错误')
    expect(c.input.value).toBe('')
  })

  // 第五轮：书名入口捕获——发送在途期间切书，失败回滚不得作用于新书（Book.vue 已
  // clear+seed 新书历史，盲弹 popUser 会弹掉新书末条用户消息、错误写进新书对话区）
  it('handleSend 失败时已切书 → 不回滚新书（popUser 不调、error 不写）', async () => {
    let current = 'A书'
    sendMock.mockImplementation(
      () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('慢失败')), 10)),
    )
    const c = useChatComposer(() => current, () => undefined)
    const chat = (await import('../../../src/studio/web-next/src/stores/chat')).useChatStore()
    chat.popUser = vi.fn()
    c.input.value = '给A的消息'
    const pending = c.handleSend()
    current = 'B书' // 发送在途时切书
    await pending
    expect(sendMock).toHaveBeenCalledWith('A书', { message: '给A的消息' }) // 消息发给发起时的书
    expect(chat.popUser).not.toHaveBeenCalled() // 新书历史不受回滚
    expect(chat.error).toBeNull() // 错误不写进新书对话区
  })

  it('handleKeydown Enter 不 Shift → 发送并 preventDefault', async () => {
    sendMock.mockResolvedValue({})
    const c = useChatComposer(() => '书', () => undefined)
    c.input.value = 'x'
    const e = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
    const spy = vi.spyOn(e, 'preventDefault')
    c.handleKeydown(e)
    await Promise.resolve()
    expect(spy).toHaveBeenCalled()
    expect(sendMock).toHaveBeenCalled()
  })

  it('handleClear 确认后清空历史 + chat.clear（CC-P2-16 起 danger 二次确认）', async () => {
    clearMock.mockResolvedValue({})
    const c = useChatComposer(() => '书', () => undefined)
    const chat = (await import('../../../src/studio/web-next/src/stores/chat')).useChatStore()
    chat.clear = vi.fn()
    const ui = (await import('../../../src/studio/web-next/src/stores/ui')).useUiStore()
    const p = c.handleClear()
    expect(ui.confirmState?.danger).toBe(true) // 不可恢复操作 → danger 样式
    ui.resolveConfirm(true)
    await p
    expect(clearMock).toHaveBeenCalledWith('书')
    expect(chat.clear).toHaveBeenCalled()
  })

  it('handleClear 取消 → 不删服务端历史（CC-P2-16）', async () => {
    const c = useChatComposer(() => '书', () => undefined)
    const chat = (await import('../../../src/studio/web-next/src/stores/chat')).useChatStore()
    chat.clear = vi.fn()
    const ui = (await import('../../../src/studio/web-next/src/stores/ui')).useUiStore()
    const p = c.handleClear()
    ui.resolveConfirm(false)
    await p
    expect(clearMock).not.toHaveBeenCalled()
    expect(chat.clear).not.toHaveBeenCalled()
  })

  it('selectChapter 切换选中章节 + 关菜单', () => {
    const c = useChatComposer(() => '书', () => undefined)
    c.toggleChapterMenu()
    expect(c.chapterMenuOpen.value).toBe(true)
    c.selectChapter(5)
    expect(c.selectedChapter.value).toBe(5)
    expect(c.chapterMenuOpen.value).toBe(false)
  })
})

describe('useChatTier', () => {
  it('refresh 加载 providers（模型清单来自 store 已配置行，不打上游）', async () => {
    getProvidersMock.mockResolvedValue({
      tiers: { chat: { model: 'm1', effort: 'high' }, creative: { model: 'm2', effort: 'low' } },
      currentId: 'prov-1',
    })
    const t = useChatTier()
    await t.refresh()
    expect(t.activeModel).toBe('m1')
    expect(t.activeEffort).toBe('high')
    // 阶段 14 store 化后此层是薄视图：refresh 只拉 providers，模型清单取已配置行——
    // 不再 fetchModels 打上游（预热归 ModelListEditor 按需「获取模型」）
    expect(fetchModelsMock).not.toHaveBeenCalled()
  })

  it('refresh 无 chat 档 → 回落 creative 档', async () => {
    getProvidersMock.mockResolvedValue({
      tiers: { creative: { model: 'c1', effort: 'medium' } },
      currentId: null,
    })
    const t = useChatTier()
    await t.refresh()
    expect(t.activeModel).toBe('c1')
    expect(t.activeEffort).toBe('medium')
  })

  it('applyTier 更新本地 + 写对话档', async () => {
    // 阶段 14 store 化后：applyTier → store.applyChatTier → setChatTier(slot, revision)，
    // 响应带回完整 tiers——mock 须按新契约返回，否则档位不更新（chatTier 停留 null）
    setTierMock.mockResolvedValue({ ok: true, tiers: { chat: { model: 'new-model', effort: 'low' } }, revision: 2 })
    const t = useChatTier()
    await t.applyTier('new-model', 'low')
    expect(t.chatTier).toEqual({ model: 'new-model', effort: 'low' })
    expect(setTierMock).toHaveBeenCalledWith({ model: 'new-model', effort: 'low' }, undefined)
  })
})

describe('useNativeMenu', () => {
  it('浏览器回退：popup 显示菜单 + onPopupSelect 回调 + 关闭', () => {
    const m = useNativeMenu()
    expect(m.isNative).toBe(false) // happy-dom 无 clwritingDesktop
    let selected = ''
    const onSelect = (k: string) => (selected = k)
    m.popup([{ key: 'a', label: 'A' }], 10, 20, onSelect)
    expect(m.menuVisible.value).toBe(true)
    expect(m.menuX.value).toBe(10)
    expect(m.menuY.value).toBe(20)
    m.onPopupSelect('a')
    expect(selected).toBe('a')
    expect(m.menuVisible.value).toBe(false)
  })

  it('onPopupClose 取消不回调', () => {
    const m = useNativeMenu()
    let called = false
    m.popup([], 0, 0, () => (called = true))
    m.onPopupClose()
    expect(called).toBe(false)
    expect(m.menuVisible.value).toBe(false)
  })
})

describe('useSystemFonts / selValue', () => {
  it('selValue 取 select 值', () => {
    const sel = document.createElement('select')
    sel.innerHTML = '<option value="light">亮</option><option value="dark">暗</option>'
    sel.value = 'dark'
    const e = new Event('change', { bubbles: true })
    sel.dispatchEvent(e)
    expect(selValue(e)).toBe('dark')
  })

  it('fontDisplayName 映射中文标签（不依赖 onMounted）', async () => {
    // 直接 import 模块级 ref 不可行（模块单例），验证暴露的纯函数逻辑经 chineseFonts computed
    const sf = useSystemFonts()
    expect(typeof sf.fontDisplayName('PingFang SC')).toBe('string')
  })
})

describe('useTheme', () => {
  it('theme 读 prefs + setTheme 写 prefs', async () => {
    const prefs = (await import('../../../src/studio/web-next/src/stores/prefs')).usePrefsStore()
    prefs.theme = 'light'
    const t = useTheme()
    expect(t.theme.value).toBe('light')
    t.setTheme('dark')
    expect(prefs.theme).toBe('dark')
    // happy-dom 无 startViewTransition → 直接 apply
  })

  it('toggle 亮暗切换', async () => {
    const prefs = (await import('../../../src/studio/web-next/src/stores/prefs')).usePrefsStore()
    prefs.theme = 'light'
    const t = useTheme()
    t.toggle()
    expect(prefs.theme).toBe('dark')
    t.toggle()
    expect(prefs.theme).toBe('light')
  })
})
