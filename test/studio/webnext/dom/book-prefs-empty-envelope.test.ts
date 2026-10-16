/**
 * R61-F-2（P3）回归：getBookPrefs 对「200 空信封（缺 prefs 字段）」的防御。
 *
 * 原实现直返 r.prefs——信封异常（代理截断/旧网关）时把 undefined 交给消费侧：
 * workspace.loadBookPrefs 的 Object.keys(prefs) 抛 TypeError，且该 rejection 在
 * setBook 的 `void loadBookPrefs(gen)` 浮空无人接（prefsLoaded 永不置位、持久化
 * watch 不挂）。修复为 `r.prefs ?? {}` 兜底（对齐全局侧 stores/prefs init 的
 * R51-H-2 同族口径）：空偏好走既有「迁移/默认布局」链，不抛不挂。
 * revision 一并回传（乐观并发守卫的期望号来源）：缺该字段同样按「号未知」（null，写链
 * 不带 expectedRevision）降级——不把 undefined 当合法号。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { getBookPrefs } from '../../../../src/studio/web-next/src/api/prefs'
import { useWorkspaceStore } from '../../../../src/studio/web-next/src/stores/workspace'
import { usePrefsStore } from '../../../../src/studio/web-next/src/stores/prefs'

const BOOK = '空信封书'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('R61-F-2: getBookPrefs 200 空信封兜底', () => {
  it('200 体 {}（缺 prefs 键）→ prefs 兜底为空对象而非 undefined（修复前直返 undefined）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    )
    const r = await getBookPrefs(BOOK)
    expect(r.prefs).toEqual({})
    expect(r.revision).toBeNull() // 缺 revision → 号未知（写链不带守卫发出）
  })

  it('对照：正常信封 {prefs:{...}, revision} → 原样透传（守卫不误伤常规加载）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ prefs: { pageWidth: 800 }, revision: 3 }), { status: 200 })),
    )
    const r = await getBookPrefs(BOOK)
    expect(r.prefs).toEqual({ pageWidth: 800 })
    expect(r.revision).toBe(3)
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

// 书级覆盖「关得掉」：关掉 = prefs store 的 bookPageWidth/bookAutosaveInterval 置 null。
// 载荷必须**带着 null 发**（旧实现 `?? undefined` 被 JSON.stringify 丢掉该键）——服务端
// 据此删键（prefs.ts NULL_DELETE_KEYS）；键不发则盘上旧覆盖键永存，关掉重进本书即复活。
describe('书级覆盖关闭：落盘载荷显式带 null（服务端按删键处理）', () => {
  /** 起一套 fetch 桩：GET 预置书级覆盖，PUT 记录载荷 */
  function stubFetchWithOverrides(getPrefs: Record<string, unknown>): Array<{ prefs: Record<string, unknown> }> {
    const putBodies: Array<{ prefs: Record<string, unknown> }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase()
        if (method === 'GET' && path === `/api/books/${encodeURIComponent(BOOK)}/prefs`) {
          return new Response(JSON.stringify({ prefs: getPrefs, revision: 1 }), { status: 200 })
        }
        if (method === 'PUT' && path === `/api/books/${encodeURIComponent(BOOK)}/prefs`) {
          putBodies.push(JSON.parse(String(init?.body)))
          return new Response(JSON.stringify({ ok: true, revision: 2 }), { status: 200 })
        }
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      }),
    )
    return putBodies
  }

  it('书级覆盖在位 → 关闭后落盘载荷带 pageWidth: null（不是缺键）', async () => {
    vi.useFakeTimers()
    const putBodies = stubFetchWithOverrides({ pageWidth: 900, autosaveInterval: 30 })
    setActivePinia(createPinia())
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    await vi.advanceTimersByTimeAsync(600)
    // 读入即生效（覆盖在位）
    const prefs = usePrefsStore()
    expect(prefs.bookPageWidth).toBe(900)

    prefs.set('pageWidth', 900, false) // 「关」：回写全局默认口径 → 覆盖置 null
    expect(prefs.bookPageWidth).toBeNull()
    await vi.advanceTimersByTimeAsync(600)
    expect(putBodies.length).toBe(1)
    // 键必须在载荷里且为 null——缺键会被服务端合并写放过，盘上旧覆盖键永存
    expect(putBodies[0]!.prefs['pageWidth']).toBeNull()
    expect('pageWidth' in putBodies[0]!.prefs).toBe(true)
  })

  it('本书从未开覆盖 → 载荷同样带 null（无覆盖是显式声明，不是缺省）', async () => {
    vi.useFakeTimers()
    const putBodies = stubFetchWithOverrides({ leftWidth: 300 })
    setActivePinia(createPinia())
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    await vi.advanceTimersByTimeAsync(600)
    expect(usePrefsStore().bookPageWidth).toBeNull()

    ws.openTab('doc-1') // 触发一次落盘
    await vi.advanceTimersByTimeAsync(600)
    expect(putBodies.length).toBe(1)
    expect(putBodies[0]!.prefs['pageWidth']).toBeNull()
    expect(putBodies[0]!.prefs['autosaveInterval']).toBeNull()
  })
})
