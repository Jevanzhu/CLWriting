// @vitest-environment happy-dom
/**
 * R75-6（二十三轮 批E→批F 收尾）回归：SettingsBook 书级 num-input 数值健壮化。
 *
 * 此前 `Number(($event.target).value)` 直写 onPfwInput——`Number('')===0` 穿透
 * 直写 prefs.bookPageWidth（store 的 bookOnly 分支无钳制），apply() 落
 * `--page-width: 0px` 页宽当场塌掉。修法：parseNumericInput 共享 helper（空串/非数字
 * → null 不写）+ 组件层钳制到滑杆同款 min/max。本测挂真组件驱动 change 事件验证
 * 三态：不写 / 钳制 / 正常写。R75-8：本书页此前零组件直测，本文件即最小直测面起点。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SettingsBook from '../../../src/studio/web-next/src/components/ui/SettingsBook.vue'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import { usePrefsStore } from '../../../src/studio/web-next/src/stores/prefs'

const mocks = vi.hoisted(() => ({ getConfig: vi.fn(), renameBook: vi.fn() }))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
  renameBook: mocks.renameBook,
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

// happy-dom localStorage 缺 clear()，Map-backed 替身（meta-form-panel 范型）
function createLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
}
vi.stubGlobal('localStorage', createLocalStorage())

async function mountOpen() {
  const ws = useWorkspaceStore()
  ws.bookName = '测试书' // hasBook → 书级覆盖组渲染
  // num-input 行挂 v-if="pfwOverride/asOverride"——挂载前先开启覆盖（非 null）
  const prefs = usePrefsStore()
  prefs.bookPageWidth = 1020
  prefs.bookAutosaveInterval = 30
  const wrapper = mount(SettingsBook, {
    global: {
      stubs: { SettingsBookWriting: true, SettingsBookAnalysis: true, SettingsBookRetention: true },
    },
  })
  await Promise.resolve()
  return wrapper
}

/** 触发 num-input 的 change（@change 语义——setValue 只发 input 事件，不够） */
async function changeTo(wrapper: Awaited<ReturnType<typeof mountOpen>>, selector: string, value: string): Promise<void> {
  const input = wrapper.find(selector)
  ;(input.element as HTMLInputElement).value = value
  await input.trigger('change')
}

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.getConfig.mockReset().mockResolvedValue({})
  mocks.renameBook.mockReset()
})

describe('SettingsBook num-input（R75-6）', () => {
  it('清空输入框 → 不写 store（页宽保持原值，不再塌 0）', async () => {
    const wrapper = await mountOpen()
    const prefs = usePrefsStore()
    await changeTo(wrapper, 'input[aria-label="本书纸宽"]', '')
    expect(prefs.bookPageWidth).toBe(1020)
    wrapper.unmount()
  })

  it('非数字 → 不写 store', async () => {
    const wrapper = await mountOpen()
    const prefs = usePrefsStore()
    await changeTo(wrapper, 'input[aria-label="本书自动保存间隔"]', 'abc')
    expect(prefs.bookAutosaveInterval).toBe(30)
    wrapper.unmount()
  })

  it('越界值钳到滑杆同款 min/max（纸宽 600-1400、间隔 5-120）', async () => {
    const wrapper = await mountOpen()
    const prefs = usePrefsStore()
    await changeTo(wrapper, 'input[aria-label="本书纸宽"]', '99999')
    expect(prefs.bookPageWidth).toBe(1400)
    await changeTo(wrapper, 'input[aria-label="本书纸宽"]', '300')
    expect(prefs.bookPageWidth).toBe(600)
    await changeTo(wrapper, 'input[aria-label="本书自动保存间隔"]', '999')
    expect(prefs.bookAutosaveInterval).toBe(120)
    await changeTo(wrapper, 'input[aria-label="本书自动保存间隔"]', '1')
    expect(prefs.bookAutosaveInterval).toBe(5)
    wrapper.unmount()
  })

  it('合法值正常写入', async () => {
    const wrapper = await mountOpen()
    const prefs = usePrefsStore()
    await changeTo(wrapper, 'input[aria-label="本书纸宽"]', '800')
    expect(prefs.bookPageWidth).toBe(800)
    wrapper.unmount()
  })
})
