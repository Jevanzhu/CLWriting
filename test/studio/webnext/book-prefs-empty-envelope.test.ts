// @vitest-environment happy-dom
/**
 * R61-F-2（P3）回归：getBookPrefs 对「200 空信封（缺 prefs 字段）」的防御。
 *
 * 原实现直返 r.prefs——信封异常（代理截断/旧网关）时把 undefined 交给消费侧：
 * workspace.loadBookPrefs 的 Object.keys(prefs) 抛 TypeError，且该 rejection 在
 * setBook 的 `void loadBookPrefs(gen)` 浮空无人接（prefsLoaded 永不置位、持久化
 * watch 不挂）。修复为 `r.prefs ?? {}` 兜底（对齐全局侧 stores/prefs init 的
 * R51-H-2 同族口径）：空偏好走既有「迁移/默认布局」链，不抛不挂。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { getBookPrefs } from '../../../src/studio/web-next/src/api/prefs'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'

const BOOK = '空信封书'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('R61-F-2: getBookPrefs 200 空信封兜底', () => {
  it('200 体 {}（缺 prefs 键）→ 返回 {} 而非 undefined（修复前直返 undefined）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })))
    const prefs = await getBookPrefs(BOOK)
    expect(prefs).toEqual({})
  })

  it('对照：正常信封 {prefs:{...}} → 原样透传（守卫不误伤常规加载）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ prefs: { pageWidth: 800 } }), { status: 200 })),
    )
    const prefs = await getBookPrefs(BOOK)
    expect(prefs).toEqual({ pageWidth: 800 })
  })
})

describe('R61-F-2: 消费侧 loadBookPrefs 不因空信封抛错、prefsLoaded 正常置位', () => {
  it('GET prefs 200 空信封 → setBook 无浮空 rejection；后续 openTab 变更经防抖落盘（prefsLoaded 已置位的可观察面）', async () => {
    vi.useFakeTimers()
    const putBodies: Array<{ prefs: Record<string, unknown> }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase()
        if (method === 'GET' && path === `/api/books/${encodeURIComponent(BOOK)}/prefs`) {
          return new Response(JSON.stringify({}), { status: 200 }) // 空信封：无 prefs 键
        }
        if (method === 'PUT' && path === `/api/books/${encodeURIComponent(BOOK)}/prefs`) {
          putBodies.push(JSON.parse(String(init?.body)))
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      }),
    )
    setActivePinia(createPinia())
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    // loadBookPrefs 落定（修复前：Object.keys(undefined) TypeError 沿 void 浮空未接）
    await vi.advanceTimersByTimeAsync(600)
    ws.openTab('doc-1') // prefsLoaded 置位后该变更才经持久化 watch 防抖落盘
    await vi.advanceTimersByTimeAsync(600)
    expect(putBodies.length).toBe(1) // 修复前 prefsLoaded 未置位 → watch 未挂 → 无落盘
    expect(putBodies[0]).toMatchObject({ prefs: { activeDocId: 'doc-1' } })
  })
})
