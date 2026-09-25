// @vitest-environment happy-dom
/**
 * R43-11（四十三轮）回归：StartupNoticeBanner localStorage 脏值容错
 * （原 r43-frontend-batch R43-11 节，按行为拆分落位）。
 * 非数组不炸 + 非 string 元素过滤；dismiss 回写只固化 string。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const mocks = vi.hoisted(() => ({
  getStartupNotices: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/startup-notices', () => ({
  getStartupNotices: mocks.getStartupNotices,
}))

import StartupNoticeBanner from '../../../src/studio/web-next/src/components/ui/StartupNoticeBanner.vue'

const DISMISS_KEY = 'clw-startup-notices-dismissed'

// happy-dom localStorage 在 vitest 集成下不可用（workspace.test.ts 同款 Map 替身）
function createLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v)
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
}
const localStorageMock = createLocalStorage()
vi.stubGlobal('localStorage', localStorageMock)

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  mocks.getStartupNotices.mockResolvedValue([
    { ts: '1', kind: 'k1', message: 'm1' },
    { ts: '2', kind: 'k2', message: 'm2' },
  ])
})

describe('R43-11: StartupNoticeBanner localStorage 脏值容错', () => {
  it('非数组 JSON（对象）→ 不炸，按无已读处理（通告全可见）', async () => {
    localStorageMock.setItem(DISMISS_KEY, '{"k1@1":true}')
    const w = mount(StartupNoticeBanner, { attachTo: document.body })
    await flushPromises()
    expect(w.findAll('.sn-list li')).toHaveLength(2) // 修复前：对象被 as string[] 透传（不炸但比对失真）
    w.unmount()
  })

  it('数组含非 string 元素 → 过滤，指纹命中照常生效；dismiss 回写全 string', async () => {
    localStorageMock.setItem(DISMISS_KEY, JSON.stringify(['k1@1', 42, null, true]))
    const w = mount(StartupNoticeBanner, { attachTo: document.body })
    await flushPromises()
    // k1@1 被指纹命中隐藏；脏元素被过滤不参与比对（k2@2 照常可见）
    expect(w.findAll('.sn-list li')).toHaveLength(1)
    expect(w.find('.sn-list li').text()).toContain('m2')

    // dismiss 回写：已读列表只含 string（脏值不随回写固化）
    await w.find('.sn-close').trigger('click')
    const stored = JSON.parse(localStorageMock.getItem(DISMISS_KEY) ?? '[]') as unknown[]
    expect(stored).toEqual(['k1@1', 'k2@2'])
    expect(stored.every((x) => typeof x === 'string')).toBe(true)
    w.unmount()
  })
})
