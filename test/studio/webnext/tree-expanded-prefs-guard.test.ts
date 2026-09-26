/**
 * loadBookPrefs 回填 treeExpanded 的用户已操作守卫（store 面，node 环境）。
 * （原 r29-fe-e3-e6-stores 的 E-3 节，按行为单拆。）
 *
 * E-3（二十九轮）：进书后用户是否动过 treeExpanded（展开/折叠唯一入口 setTreeExpanded
 * 置位）——loadBookPrefs 迟到回填不得覆盖作者已手工调整的展开态（比照 activeDocId 的
 * R72-11 守卫口径）；未操作时照常回填（守卫不误伤）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  getBookPrefs: vi.fn(),
  putBookPrefs: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getBookPrefs: mocks.getBookPrefs,
  putBookPrefs: mocks.putBookPrefs,
}))
// prefs store 的 apply() 触碰 document（node 环境无 DOM）——stub 掉，本文件不测 CSS 注入
vi.mock('../../../src/studio/web-next/src/stores/prefs', () => ({
  usePrefsStore: () => ({
    bookPageWidth: null,
    bookAutosaveInterval: null,
    apply: vi.fn(),
  }),
}))

import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.putBookPrefs.mockResolvedValue(undefined)
})

describe('E-3: loadBookPrefs 回填 treeExpanded 的用户已操作守卫', () => {
  it('用户已展开/折叠 → 迟到的 prefs 回填不覆盖；未操作 → 照常回填', async () => {
    const ws = useWorkspaceStore()
    // 书A：getBookPrefs 挂起 → 用户先动展开态 → prefs 迟到
    let releaseA!: (v: { treeExpanded?: string[] }) => void
    mocks.getBookPrefs.mockImplementationOnce(
      () =>
        new Promise((r) => {
          releaseA = r
        }),
    )
    ws.setBook('书A')
    ws.setTreeExpanded(['我的卷']) // 用户操作（展开/折叠唯一入口）
    releaseA({ treeExpanded: ['服务器组'] })
    await vi.waitFor(() => {}) // 泵微任务
    await Promise.resolve()
    expect(ws.treeExpanded).toEqual(['我的卷']) // 修复点：不覆盖用户意图

    // 对照 书B：无用户操作 → prefs 回填生效（守卫不误伤）
    mocks.getBookPrefs.mockResolvedValueOnce({ treeExpanded: ['服务器组'] })
    ws.setBook('书B')
    await vi.waitFor(() => expect(ws.treeExpanded).toEqual(['服务器组']))
  })
})
