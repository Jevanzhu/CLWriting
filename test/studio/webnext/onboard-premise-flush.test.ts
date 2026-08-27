// @vitest-environment happy-dom
/**
 * R65-51（十三轮批 E-3）回归：OnboardPremise 卸载冲刷在途防抖写。
 * 修复前：输入后 300ms 防抖窗口内离开本卡 → onBeforeUnmount 只清定时器，
 * 最后一次编辑丢弃，重进回退旧值（作者「丢稿」感知）。
 * 注：不传 modelValue 挂载（defineModel 纯本地态）——传静态 prop 会触发
 * Vue 的「prop 为真源」回滚，本地编辑被夹回初值，非本组件缺陷。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import OnboardPremise from '../../../src/studio/web-next/src/components/onboard/OnboardPremise.vue'

// happy-dom localStorage 在 vitest 集成下缺 clear()，Map-backed 替身（照 prefs-store 范型）
function createLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
}
const localStorageMock = createLocalStorage()
vi.stubGlobal('localStorage', localStorageMock)

const KEY = 'clwriting:onboard-premise:书测'

beforeEach(() => {
  localStorageMock.clear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('OnboardPremise: 卸载冲刷（R65-51）', () => {
  it('防抖在途时卸载 → 立即落盘（不等 300ms，不丢最后一次编辑）', async () => {
    localStorageMock.setItem(KEY, '旧设想')
    const w = mount(OnboardPremise, { props: { bookName: '书测', modelValue: '' } })
    await nextTickFlush()
    expect(w.find('textarea').element.value).toBe('旧设想') // onMounted 回填旧值
    await w.find('textarea').setValue('新设想（尚未过防抖）')
    expect(localStorageMock.getItem(KEY)).toBe('旧设想') // 防抖未到，尚未写

    w.unmount() // 300ms 内离开本卡
    expect(localStorageMock.getItem(KEY)).toBe('新设想（尚未过防抖）') // 冲刷落盘
  })

  it('防抖已自然落盘后卸载 → 不重复写（无在途定时器）', async () => {
    const w = mount(OnboardPremise, { props: { bookName: '书测', modelValue: '' } })
    await nextTickFlush()
    await w.find('textarea').setValue('已定稿设想')
    vi.advanceTimersByTime(400) // 防抖自然触发
    expect(localStorageMock.getItem(KEY)).toBe('已定稿设想')

    const spy = vi.spyOn(localStorageMock, 'setItem')
    w.unmount()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

/** fake timers 下等 Vue 微任务调度排空（onMounted 回填 / watch flush） */
async function nextTickFlush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}
