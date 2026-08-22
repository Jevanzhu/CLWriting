// @vitest-environment happy-dom
/**
 * 低-4（第十轮）：ForeshadowPanel.create 的切书守卫。
 *
 * 旧实现 createDoc await 后无书名复检——新建伏笔在途切书 A→B 后，旧书续体继续
 * tree.load / load / openTab，可能顶开 B 书工作台正开的伏笔标签（共享 store 被
 * 旧书写入）。修法：入口捕获 + await 后活源复检（本面板经 SidebarRight 常驻外壳
 * 挂载、非 keyed，props.bookName 即路由活书名，再比 doc store 内 live bookName）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ForeshadowPanel from '../../../src/studio/web-next/src/components/panels/ForeshadowPanel.vue'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'

const fsApiMocks = vi.hoisted(() => ({ getForeshadows: vi.fn() }))
vi.mock('../../../src/studio/web-next/src/api/foreshadows', () => fsApiMocks)
const docApiMocks = vi.hoisted(() => ({ createDoc: vi.fn() }))
vi.mock('../../../src/studio/web-next/src/api/documents', () => docApiMocks)

/** 起一个手动放行的 Promise（模拟在途新建伏笔请求） */
function pending<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  fsApiMocks.getForeshadows.mockResolvedValue([])
})

describe('低-4（第十轮）：新建伏笔在途切书 → 放弃后续写操作', () => {
  it('createDoc 在途切书 A→B → 不 tree.load、不重拉伏笔列表、不顶开标签', async () => {
    const doc = useDocStore()
    doc.setBook('书A') // 对齐 Book.vue 挂载编排：doc store 内 live bookName 先就位
    const tree = useTreeStore()
    const treeLoadSpy = vi.spyOn(tree, 'load').mockResolvedValue(undefined)
    const ws = useWorkspaceStore()
    const openTabSpy = vi.spyOn(ws, 'openTab')

    const wrapper = mount(ForeshadowPanel, { props: { bookName: '书A' } })
    await flushPromises()
    expect(fsApiMocks.getForeshadows).toHaveBeenCalledTimes(1) // 挂载 watch 初载

    const req = pending<{ ok: boolean; path: string; words: number; docId: string; snapshotted: boolean }>()
    docApiMocks.createDoc.mockReturnValue(req.promise)
    await wrapper.find('.fs-add').trigger('click')
    expect(docApiMocks.createDoc).toHaveBeenCalledWith('书A', { relPath: '设定/伏笔/新伏笔.md' })

    // 切书：路由活源（props）与 doc store live bookName 同步翻到 B
    await wrapper.setProps({ bookName: '书B' })
    doc.setBook('书B')
    req.resolve({ ok: true, path: '设定/伏笔/新伏笔.md', words: 0, docId: 'doc_f1', snapshotted: false })
    await flushPromises()

    expect(treeLoadSpy).not.toHaveBeenCalled() // 不再把旧书目录写进共享 tree store
    // 伏笔列表只有两次拉取：挂载初载(书A) + 切书 watch(书B)；死续体不再追加第三次
    expect(fsApiMocks.getForeshadows).toHaveBeenCalledTimes(2)
    expect(fsApiMocks.getForeshadows).toHaveBeenLastCalledWith('书B')
    expect(openTabSpy).not.toHaveBeenCalled() // 不顶开 B 书正开的标签
  })

  it('未切书 → 守卫不误伤：tree.load(书A) + 重拉伏笔列表', async () => {
    const doc = useDocStore()
    doc.setBook('书A')
    const tree = useTreeStore()
    const treeLoadSpy = vi.spyOn(tree, 'load').mockResolvedValue(undefined)

    const wrapper = mount(ForeshadowPanel, { props: { bookName: '书A' } })
    await flushPromises()

    docApiMocks.createDoc.mockResolvedValue({ ok: true, path: '设定/伏笔/新伏笔.md', words: 0, docId: 'doc_f1', snapshotted: false })
    await wrapper.find('.fs-add').trigger('click')
    await flushPromises()

    expect(treeLoadSpy).toHaveBeenCalledWith('书A')
    expect(fsApiMocks.getForeshadows).toHaveBeenCalledTimes(2) // 初载 + create 后 load()
  })
})
