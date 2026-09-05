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
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  createDoc: vi.fn(),
  renameDoc: vi.fn(),
  moveDoc: vi.fn(),
  copyDoc: vi.fn(),
  deleteDoc: vi.fn(),
  updateChapterMetaDoc: vi.fn(),
  batchFinalizeDocs: vi.fn(),
}))

import { sendChat, clearChatHistory } from '../../../src/studio/web-next/src/api/chat'
import { getProviders, setChatTier, fetchModels } from '../../../src/studio/web-next/src/api/providers'
import { deleteDoc, createDoc, copyDoc, updateChapterMetaDoc } from '../../../src/studio/web-next/src/api/documents'
import { useChatComposer } from '../../../src/studio/web-next/src/composables/useChatComposer'
import { useChapterTreeActions } from '../../../src/studio/web-next/src/composables/useChapterTreeActions'
import { useChatTier } from '../../../src/studio/web-next/src/composables/useChatTier'
import { useNativeMenu } from '../../../src/studio/web-next/src/composables/useNativeMenu'
import { useSystemFonts, selValue } from '../../../src/studio/web-next/src/composables/useSystemFonts'
import { useTheme } from '../../../src/studio/web-next/src/composables/useTheme'

const sendMock = sendChat as ReturnType<typeof vi.fn>
const clearMock = clearChatHistory as ReturnType<typeof vi.fn>
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
    // R40-37 契约演进：失败回滚按幽灵气泡 id 定位（popUser 仅当末条=本次幽灵气泡）。
    // pushUser 走真 store 动作落真实幽灵气泡（mock 掉它气泡就不存在，回滚按契约不弹）；
    // popUser 换 spy 观察回滚调用。
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

  // R61-3（第六十一轮）：IME 组合期 Enter 让渡——组合期 v-model 尚未同步组合文本，
  // 放行会把不含刚打中文的旧值消息发出去（触发一轮真实 AI 调用）
  it('R61-3: 组合期 Enter（isComposing）不发送；组合结束后真实 Enter 正常发送', async () => {
    sendMock.mockResolvedValue({})
    const c = useChatComposer(() => '书', () => undefined)
    c.input.value = '帮我写'
    c.handleKeydown(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, isComposing: true }))
    await Promise.resolve()
    expect(sendMock).not.toHaveBeenCalled()
    expect(c.input.value).toBe('帮我写') // 输入不清空
    c.handleKeydown(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
    await Promise.resolve()
    expect(sendMock).toHaveBeenCalledWith('书', { message: '帮我写' })
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

  // M-8（第六轮）：清空确认弹窗 await 期间切书 → 确认后中止。修复前 clearChatHistory(bookName())
  // 按确认时的当前书发请求——弹窗按 A 书提问、用户切到 B 后确认，会删掉 B 书的服务端历史
  it('M-8: handleClear 弹窗滞留期间切书 → 确认后中止（不删服务端历史、不清本地对话区）', async () => {
    let current = 'A书'
    const c = useChatComposer(() => current, () => undefined)
    const chat = (await import('../../../src/studio/web-next/src/stores/chat')).useChatStore()
    chat.clear = vi.fn()
    const ui = (await import('../../../src/studio/web-next/src/stores/ui')).useUiStore()
    const p = c.handleClear()
    current = 'B书' // 弹窗滞留期间切书（确认尚未发生）
    ui.resolveConfirm(true)
    await p
    expect(clearMock).not.toHaveBeenCalled() // B 书（及任何书）的服务端历史不动
    expect(chat.clear).not.toHaveBeenCalled() // B 书前端对话区不动
  })

  it('M-8: clearChatHistory 在途切书 → 服务端删发起书，本地不清新书对话区', async () => {
    let current = 'A书'
    clearMock.mockImplementation(() => {
      current = 'B书' // 请求已发出（目标书 A 已捕获）——在途期间切书
      return new Promise((resolve) => setTimeout(() => resolve({}), 10))
    })
    const c = useChatComposer(() => current, () => undefined)
    const chat = (await import('../../../src/studio/web-next/src/stores/chat')).useChatStore()
    chat.clear = vi.fn()
    const ui = (await import('../../../src/studio/web-next/src/stores/ui')).useUiStore()
    const p = c.handleClear()
    ui.resolveConfirm(true)
    await p
    expect(clearMock).toHaveBeenCalledWith('A书') // 服务端删的是发起时的书
    expect(chat.clear).not.toHaveBeenCalled() // B 书刚恢复的历史不被本地 clear 抹掉
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

  it('R46-34（四十六轮）：60s TTL 门——成功刷新后 60s 内非强制跳过重拉，force 穿透', async () => {
    // 带 providers 的成功响应才占 TTL 窗（冷启动拉失败不占，下次切书可重试自愈）
    getProvidersMock.mockResolvedValue({
      tiers: { chat: { model: 'm1', effort: 'high' }, creative: { model: 'm2', effort: 'low' } },
      currentId: 'prov-1',
      providers: [{ id: 'prov-1' }],
    })
    const t = useChatTier()
    await t.refresh()
    const after = getProvidersMock.mock.calls.length
    await t.refresh() // 距成功 <60s 且非强制 → 跳过（切书链不再重复 GET /api/providers）
    expect(getProvidersMock.mock.calls.length).toBe(after)
    await t.refresh(true) // 强制（需要新数据的入口）→ 穿透重拉
    expect(getProvidersMock.mock.calls.length).toBe(after + 1)
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

// ── FE-1（第七轮）：doDelete 上下文捕获（M-8 类横向收敛）──────────────────
describe('useChapterTreeActions · doDelete', () => {
  const deleteMock = deleteDoc as ReturnType<typeof vi.fn>
  function chNode(docId: string) {
    return {
      path: '写作/正文/第一卷/0001-开篇.md',
      name: '0001-开篇.md',
      docId,
      isDirectory: false,
      role: '',
      children: [],
    }
  }

  it('FE-1: 弹窗滞留期间切书 → 确认后中止（不删任何书的文档）', async () => {
    let current = 'A书'
    const actions = useChapterTreeActions({ bookName: () => current, openError: ref(null) })
    const ui = (await import('../../../src/studio/web-next/src/stores/ui')).useUiStore()
    const p = actions.doDelete(chNode('legacy:abc123'))
    current = 'B书' // 弹窗按 A 书提问，滞留期间跨窗切到 B 书——legacy docId 不分书，会命中 B 书同路径文件
    ui.resolveConfirm(true)
    await p
    expect(deleteMock).not.toHaveBeenCalled()
  })

  it('FE-1: 同书确认 → 删发起书的 docId + 刷同书树', async () => {
    deleteMock.mockResolvedValue({})
    const tree = (await import('../../../src/studio/web-next/src/stores/tree')).useTreeStore()
    tree.load = vi.fn()
    const actions = useChapterTreeActions({ bookName: () => 'A书', openError: ref(null) })
    const ui = (await import('../../../src/studio/web-next/src/stores/ui')).useUiStore()
    const p = actions.doDelete(chNode('legacy:abc123'))
    ui.resolveConfirm(true)
    await p
    expect(deleteMock).toHaveBeenCalledWith('A书', 'legacy:abc123')
    expect(tree.load).toHaveBeenCalledWith('A书')
  })
})

// ── M-8/M-4（第十一轮）：createSingleton 供模板 + doCopy 补零单源 ──────────
describe('useChapterTreeActions · createSingleton / doCopy', () => {
  const createMock = createDoc as ReturnType<typeof vi.fn>
  const copyMock = copyDoc as ReturnType<typeof vi.fn>

  it('M-8: 新建总纲 → createDoc 带骨架模板 content（不再落全空文件）', async () => {
    createMock.mockResolvedValue({ path: '大纲/总纲.md' })
    const tree = (await import('../../../src/studio/web-next/src/stores/tree')).useTreeStore()
    tree.load = vi.fn()
    const actions = useChapterTreeActions({ bookName: () => 'A书', openError: ref(null) })
    await actions.createSingleton('大纲/总纲.md', '总纲')
    expect(createMock).toHaveBeenCalledWith('A书', {
      relPath: '大纲/总纲.md',
      content: expect.stringContaining('# 总纲'),
    })
  })

  it('M-8: 新建世界观 → 世界观骨架模板', async () => {
    createMock.mockResolvedValue({ path: '设定/世界观.md' })
    const tree = (await import('../../../src/studio/web-next/src/stores/tree')).useTreeStore()
    tree.load = vi.fn()
    const actions = useChapterTreeActions({ bookName: () => 'A书', openError: ref(null) })
    await actions.createSingleton('设定/世界观.md', '世界观')
    expect(createMock).toHaveBeenCalledWith('A书', {
      relPath: '设定/世界观.md',
      content: expect.stringContaining('# 世界观'),
    })
  })

  it('M-4: doCopy 复制路径补零走单源（空树 → 0001-，长篇 4 位）', async () => {
    copyMock.mockResolvedValue({ path: '写作/正文/0001-开篇 副本.md' })
    const tree = (await import('../../../src/studio/web-next/src/stores/tree')).useTreeStore()
    tree.load = vi.fn()
    const actions = useChapterTreeActions({ bookName: () => 'A书', openError: ref(null) })
    await actions.doCopy({
      path: '写作/正文/0001-开篇.md',
      name: '0001-开篇.md',
      docId: 'legacy:abc123',
      isDirectory: false,
      role: '',
      children: [],
    })
    expect(copyMock).toHaveBeenCalledWith('A书', 'legacy:abc123', '写作/正文/0001-开篇 副本.md')
  })
})

// ── N-8/N-9/N-13（第十二轮）：切书竞态守卫 + 内联态清理 ──────────
describe('useChapterTreeActions · 切书守卫（N-8/N-9/N-13）', () => {
  const updateMetaMock = updateChapterMetaDoc as ReturnType<typeof vi.fn>
  const createMock2 = createDoc as ReturnType<typeof vi.fn>

  function metaNode(docId: string) {
    return {
      path: '写作/正文/0001-开篇.md',
      name: '0001-开篇.md',
      docId,
      isDirectory: false,
      role: 'chapter',
      children: [],
    }
  }

  it('N-8: 篇章弹窗滞留期间切书 → 提交写开弹窗时的书（不写 B 书），不刷 B 树', async () => {
    updateMetaMock.mockResolvedValue({})
    const tree = (await import('../../../src/studio/web-next/src/stores/tree')).useTreeStore()
    tree.load = vi.fn()
    let current = 'A书'
    const actions = useChapterTreeActions({ bookName: () => current, openError: ref(null) })
    actions.onMenuSelect('meta', metaNode('doc_p01'))
    expect(actions.metaEditing.value?.docId).toBe('doc_p01')
    current = 'B书' // 弹窗按 A 书的 docId 打开，滞留期间切到 B 书——deps.bookName() 已是 B
    await actions.onSaveMeta({ 标题: '新标', num: 3 })
    // 修复点：书名取开弹窗时的捕获值——修复前 updateChapterMetaDoc(B书, doc_p01) 错书落 fm
    expect(updateMetaMock).toHaveBeenCalledWith('A书', 'doc_p01', { 标题: '新标', 章号: 3 })
    // 已切书：不刷 B 书树、不动 B 界面
    expect(tree.load).not.toHaveBeenCalled()
  })

  it('N-8: 同书提交 → 写该书 + 刷该书树（守卫不误伤正常路径）', async () => {
    updateMetaMock.mockResolvedValue({})
    const tree = (await import('../../../src/studio/web-next/src/stores/tree')).useTreeStore()
    tree.load = vi.fn()
    const actions = useChapterTreeActions({ bookName: () => 'A书', openError: ref(null) })
    actions.onMenuSelect('meta', metaNode('doc_p01'))
    await actions.onSaveMeta({ 标题: '新标', num: 2 })
    expect(updateMetaMock).toHaveBeenCalledWith('A书', 'doc_p01', { 标题: '新标', 章号: 2 })
    expect(tree.load).toHaveBeenCalledWith('A书')
  })

  it('N-9: createSingleton 建档在途切书 → 文件落发起书，不刷/不开 B 书界面', async () => {
    createMock2.mockResolvedValue({ path: '大纲/总纲.md' })
    const tree = (await import('../../../src/studio/web-next/src/stores/tree')).useTreeStore()
    tree.load = vi.fn()
    let current = 'A书'
    const actions = useChapterTreeActions({ bookName: () => current, openError: ref(null) })
    const p = actions.createSingleton('大纲/总纲.md', '总纲')
    current = 'B书' // createDoc 在途切书——修复前 tree.load(B书) 把 A 书树盖进 B 界面
    await p
    expect(createMock2).toHaveBeenCalledWith('A书', expect.objectContaining({ relPath: '大纲/总纲.md' }))
    expect(tree.load).not.toHaveBeenCalled()
  })

  it('N-13: resetInlineState 清四内联态（切书由 ChapterTreePanel watch 调用）', async () => {
    const actions = useChapterTreeActions({ bookName: () => 'A书', openError: ref(null) })
    actions.onMenuSelect('meta', metaNode('doc_p01'))
    actions.renamePath.value = '写作/正文/0001-开篇.md'
    actions.draggedPath.value = '写作/正文/0001-开篇.md'
    actions.creating.value = { kind: 'doc', renderDir: '设定', fsDir: '设定', seed: '' }
    expect(actions.metaEditing.value).not.toBeNull()
    actions.resetInlineState()
    expect(actions.metaEditing.value).toBeNull()
    expect(actions.renamePath.value).toBeNull()
    expect(actions.draggedPath.value).toBeNull()
    expect(actions.creating.value).toBeNull()
  })
})
