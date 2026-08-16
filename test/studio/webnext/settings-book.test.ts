// @vitest-environment happy-dom
/**
 * SettingsBook 书名改名交互测试：书名改动 → 全量改名 API（目录+登记+active 一起搬），
 * renamed=true → 路由切新名；同名 no-op 不切路由；失败回退输入框。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import SettingsBook from '../../../src/studio/web-next/src/components/ui/SettingsBook.vue'
import { SAVE_CONFIG_KEY } from '../../../src/studio/web-next/src/components/ui/settings-context'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import type { BookConfig } from '../../../src/studio/web-next/src/api/books'

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  renameBook: vi.fn(),
  routerReplace: vi.fn(),
  saveConfig: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
  renameBook: mocks.renameBook,
}))

vi.mock('../../../src/studio/web-next/node_modules/vue-router', () => ({
  useRouter: () => ({ replace: mocks.routerReplace }),
}))

/** 打开设置 + 切到一本书（触发 watch 拉配置）。 */
async function mountOpen(): Promise<ReturnType<typeof mount>> {
  const ui = useUiStore()
  const ws = useWorkspaceStore()
  ui.settingsOpen = true
  ws.bookName = '旧名'
  const wrapper = mount(SettingsBook, {
    global: { provide: { [SAVE_CONFIG_KEY as symbol]: mocks.saveConfig } },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.getConfig.mockResolvedValue({
    kind: 'long',
    book: { title: '旧名', genre: '玄幻' },
  } satisfies BookConfig)
})

describe('SettingsBook 书名全量改名', () => {
  it('书名改动 → renameBook(旧名,新名)；renamed=true → 路由切新名 + 已保存 toast', async () => {
    mocks.renameBook.mockResolvedValue({ ok: true, renamed: true, name: '新名', path: '长篇/新名' })
    const ui = useUiStore()
    const wrapper = await mountOpen()

    const input = wrapper.find('input.text-input')
    expect((input.element as HTMLInputElement).value).toBe('旧名')

    await input.setValue('新名')
    await input.trigger('change')
    await flushPromises()

    expect(mocks.renameBook).toHaveBeenCalledWith('旧名', '新名')
    expect(mocks.routerReplace).toHaveBeenCalledWith('/book/%E6%96%B0%E5%90%8D')
    expect(ui.toasts.at(-1)?.msg).toBe('已保存')
  })

  it('同名 no-op（renamed=false）→ 不切路由', async () => {
    mocks.renameBook.mockResolvedValue({ ok: true, renamed: false, name: '旧名', path: '长篇/旧名' })
    const wrapper = await mountOpen()

    const input = wrapper.find('input.text-input')
    await input.setValue('新名')
    await input.trigger('change')
    await flushPromises()

    expect(mocks.renameBook).toHaveBeenCalledWith('旧名', '新名')
    expect(mocks.routerReplace).not.toHaveBeenCalled()
  })

  it('书名与基线相同 → 不调 renameBook', async () => {
    const wrapper = await mountOpen()
    const input = wrapper.find('input.text-input')
    await input.setValue('旧名')
    await input.trigger('change')
    await flushPromises()
    expect(mocks.renameBook).not.toHaveBeenCalled()
  })

  it('改名失败 → error toast + 输入框回退当前名', async () => {
    mocks.renameBook.mockRejectedValue(new Error('已有一本叫「新名」的书'))
    const ui = useUiStore()
    const wrapper = await mountOpen()

    const input = wrapper.find('input.text-input')
    await input.setValue('新名')
    await input.trigger('change')
    await flushPromises()

    expect(ui.toasts.at(-1)?.msg).toContain('已有一本')
    expect((input.element as HTMLInputElement).value).toBe('旧名')
    expect(mocks.routerReplace).not.toHaveBeenCalled()
  })

  it('空书名 → 回退基线，不调 renameBook', async () => {
    const wrapper = await mountOpen()
    const input = wrapper.find('input.text-input')
    await input.setValue('   ')
    await input.trigger('change')
    await flushPromises()
    expect(mocks.renameBook).not.toHaveBeenCalled()
    expect((input.element as HTMLInputElement).value).toBe('旧名')
  })
})

describe('SettingsBook 短篇严格模式（short.strict）', () => {
  it('短篇书显示开关且反映已存值；切换写入 short.strict', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'short',
      short: { strict: false },
      book: { title: '短篇', genre: '现实' },
    } satisfies BookConfig)
    const wrapper = await mountOpen()

    const sw = wrapper.find('input[aria-label="短篇严格模式"]')
    expect(sw.exists()).toBe(true)
    expect((sw.element as HTMLInputElement).checked).toBe(false)

    // 捕获 saveConfig 的 mutator，验证写入 short.strict
    let captured: ((c: BookConfig) => void) | undefined
    mocks.saveConfig.mockImplementation((mut: (c: BookConfig) => void) => {
      captured = mut
      return Promise.resolve()
    })
    await sw.setValue(true)
    await flushPromises()
    const cfg = { kind: 'short', short: {} } as BookConfig
    captured!(cfg)
    expect(cfg.short?.strict).toBe(true)
  })

  it('已存 strict:true 时开关为勾选态', async () => {
    mocks.getConfig.mockResolvedValue({
      kind: 'short',
      short: { strict: true },
      book: { title: '短篇', genre: '现实' },
    } satisfies BookConfig)
    const wrapper = await mountOpen()
    const sw = wrapper.find('input[aria-label="短篇严格模式"]')
    expect((sw.element as HTMLInputElement).checked).toBe(true)
  })

  it('长篇书不显示「短篇严格模式」开关', async () => {
    const wrapper = await mountOpen() // beforeEach 默认长篇
    expect(wrapper.find('input[aria-label="短篇严格模式"]').exists()).toBe(false)
  })
})
