// @vitest-environment happy-dom
/**
 * R0916-7-P3-20（评审 P3-20）回归②（本项核心改进点）：切书守卫前移到路由提交之前
 * ——原地切书（/book/A → /book/B）先完成冲刷与三段决断才放行；作者取消 → 路由不提交、
 * 目标书 SSE 从未连上、事件从未落进任何 store，故「先切后回滚」的整段善后（清污 /
 * 回退路由 / resync + 补种）在这一路径上不再需要。
 *
 * 与既有文件的互补关系：f1-flush-failure-guard / book-watch-reentry / r37-e1 等用
 * 「直改 route.params」驱动提交后的 watch 链（本文件不动它们）；本文件用**真路由**
 * （memory history + RouterView）驱动提交前守卫面。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { computed, defineComponent, h, provide, reactive } from 'vue'
// 取嵌套副本而非裸名（本仓惯例：vue-tsc 的 web-next 配置解析不到根侧裸名 'vue-router'；
// 本文件要真路由，故不能用既有测试的 vi.mock 双注册手法）
import {
  createMemoryHistory,
  createRouter,
  matchedRouteKey,
  routeLocationKey,
  type RouteLocationNormalizedLoaded,
  type Router,
} from '../../../src/studio/web-next/node_modules/vue-router'

const mocks = vi.hoisted(() => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  updateChapterMetaDoc: vi.fn(),
  fetchChatHistory: vi.fn(),
  refreshTier: vi.fn(),
  resync: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: mocks.getContent,
  getContentPayload: vi.fn(async (...a: Parameters<typeof mocks.getContent>) => ({ content: await mocks.getContent(...a) })),
  saveContent: mocks.saveContent,
  finalizeDoc: mocks.finalizeDoc,
  updateChapterMetaDoc: mocks.updateChapterMetaDoc,
}))
vi.mock('../../../src/studio/web-next/src/api/chat', () => ({
  sendChat: vi.fn(),
  clearChatHistory: vi.fn(),
  confirmTool: vi.fn(),
  fetchChatHistory: mocks.fetchChatHistory,
  fetchChatBranches: vi.fn(async () => ({ branches: [], activeBranchId: null })),
  regenerateChat: vi.fn(),
}))
// 网络面无关本测：切书链内 ws.setBook（书级 prefs）与 doc 保存成功后的今日字数基线都会发请求
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getTree: vi.fn(async () => ({ nodes: [], revision: '' })),
  getConfig: vi.fn(async () => ({ kind: 'long' })),
  getWordsDiary: vi.fn(async () => ({ date: '2026-09-24', baseline: 0, delta: 0 })),
  postBaseline: vi.fn(async () => {}),
  renameBook: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/prefs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/prefs')>()
  return {
    ...actual,
    getBookPrefs: vi.fn(async () => ({})),
    putBookPrefs: vi.fn(async () => {}),
    getGlobalPrefs: vi.fn(async () => ({})),
    putGlobalPrefs: vi.fn(async () => {}),
  }
})

// 子视图全部 stub（本测试只关心切书编排，不渲染任何视图内容）
const stub = vi.hoisted(() => ({ template: '<div />' }))
vi.mock('../../../src/studio/web-next/src/components/shell/WorkspaceShell.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/EditorView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/WorkbenchView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/OnboardView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/OverviewView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/RelationsView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/LearnView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/StyleView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/AuditView.vue', () => ({ default: stub }))
// R55-F-2：Book.vue 从本模块具名导入 heartbeatFailStreak（半开看门狗消费面）——mock 需同形导出
vi.mock('../../../src/studio/web-next/src/composables/useHeartbeat', async () => {
  const { ref } = await import('vue')
  return { useHeartbeat: vi.fn(), heartbeatFailStreak: ref(0) }
})
vi.mock('../../../src/studio/web-next/src/composables/useSse', () => ({ useSse: vi.fn(() => ({ resync: mocks.resync })) }))
vi.mock('../../../src/studio/web-next/src/composables/useChatTier', () => ({ useChatTier: vi.fn(() => ({ refresh: mocks.refreshTier })) }))

import Book from '../../../src/studio/web-next/src/pages/Book.vue'
import { bookSessionFor, currentBookSession, endBookSession } from '../../../src/studio/web-next/src/composables/useBookSession'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

function makeNode(docId: string): TreeNode {
  return {
    path: `写作/正文/${docId}.md`,
    name: `${docId}.md`,
    isDirectory: false,
    role: 'chapter',
    docId,
    children: [],
  } as TreeNode
}

const bookPath = (n: string): string => `/book/${encodeURIComponent(n)}`

let router: Router
let w: ReturnType<typeof mount>
let visitOrder: string[] = []
/** app 侧注入的「当前路由」对象（Book.vue 的 useRoute 读它）——为什么不用路由自身注入的
 *  那一份，见 beforeEach 内 harness 注释。 */
let routeState: { params: { name: string } }

beforeEach(async () => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  visitOrder = []
  mocks.getContent.mockResolvedValue('内容')
  mocks.saveContent.mockResolvedValue({ ok: true, revision: `sha256:${'b'.repeat(64)}`, superseded: false })
  mocks.fetchChatHistory.mockResolvedValue({ messages: [] })
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/shelf', component: { template: '<div />' } },
      { path: '/book/:name', component: Book },
    ],
  })
  routeState = reactive({ params: { name: '书A' } })
  // 路由提交后把书名同步进 app 侧路由对象：afterEach 是路由主动回调（不经响应式），
  // 同步时机 = 真实 app 里 routeLocationKey 那份 reactive 路由的更新时机（同一拍、提交后）。
  // failure 非空 =导航被守卫中止（作者取消）→ URL 未变，路由对象也不得变——不滤掉这一步，
  // 「取消」会被伪造成一次提交（watch 链再跑一遍兜底段，多弹一次窗）。
  router.afterEach((to, _from, failure) => {
    if (failure) return
    routeState.params.name = String(to.params.name ?? '')
  })
  await router.push(bookPath('书A'))
  await router.isReady()
  // 宿主：手接 RouterView 通常提供的两个注入键，Book 直挂其下——onBeforeRouteUpdate 的
  // 登记/触发语义与挂在 <router-view> 内逐位一致（走的是同一 registerGuard →
  // record.updateGuards 通道，inject(matchedRouteKey).value 取记录）。不用真 <RouterView>：
  // 本仓库锁定的 vue-router 副本在 happy-dom 下渲染 RouterView 即抛 TypeError
  //（__vrv_devtools，与本改动无关的环境问题，scratch 复现：仅 vue/vue-router/pinia 亦崩）。
  //
  // routeLocationKey 为什么自带一份而不是复用路由注入的：vitest 下 vue-router 是嵌套
  // node_modules 里的外部依赖（原样加载，不走本仓 alias），其内的 'vue' 解析到 web-next
  // 自带的 vue 副本，与测试/源码经 alias 拿到的根 vue 是**两份实例**（实测 isRef 判等
  // false、两份 @vue/reactivity）→ 路由注入的 shallowReactive 路由对象挂在外来响应式
  // 系统上，app 侧 watch/computed 永不收到通知（真路由提交后 Book 的 watch 不触发，已用
  // scratch 复现）。真实 app 单实例（web-next 的源码与 vue-router 同解析到嵌套 vue）
  // 无此问题；此处注入 app 侧同形对象 + afterEach 同步，等价复现真实响应式时序。
  const Host = defineComponent({
    name: 'RouterViewHarness',
    setup() {
      provide(matchedRouteKey, computed(() => router.currentRoute.value.matched[0]))
      provide(routeLocationKey, routeState as unknown as RouteLocationNormalizedLoaded)
      return () => h(Book)
    },
  })
  w = mount(Host, { global: { plugins: [router] } })
  await flushPromises()
})

afterEach(() => {
  w.unmount()
  endBookSession()
})

/** 造「脏 + 可选冲突」的当前书文档（Z-8 / F1 守卫形态）。 */
async function seedDirty(docId: string, opts: { conflict?: boolean } = {}): Promise<void> {
  const doc = useDocStore()
  mocks.getContent.mockResolvedValueOnce('盘上内容')
  await doc.open(makeNode(docId))
  doc.patch(docId, '本地未落盘编辑')
  doc.get(docId)!.conflict = opts.conflict === true
}

/** 决断弹窗桩：记录「弹窗出现时路由停在哪本书」——提交前守卫的判据就是它。 */
function askAt(ui: ReturnType<typeof useUiStore>, answer: boolean) {
  return vi.spyOn(ui, 'ask').mockImplementation(async () => {
    visitOrder.push(String(router.currentRoute.value.params.name))
    return answer
  })
}

describe('R0916-7-P3-20: 提交前守卫——取消不切书（零状态变更，无需回滚善后）', () => {
  it('未决冲突 + 取消 → 弹窗先于路由提交；路由留在原书、目标书 store 未被污染、A 状态原封', async () => {
    const doc = useDocStore()
    const wb = useWorkbenchStore()
    const ui = useUiStore()
    await seedDirty('d1', { conflict: true })
    wb.textOut = 'A 书工作台残留'
    const askSpy = askAt(ui, false)
    const replaceSpy = vi.spyOn(router, 'replace')
    const resyncBefore = mocks.resync.mock.calls.length
    const sessionA = currentBookSession()!

    await router.push(bookPath('书B'))
    await flushPromises()

    expect(visitOrder).toEqual(['书A']) // 决断发生在路由提交之前（「先切后弹窗」不再存在）
    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(askSpy.mock.calls[0]![0].title).toContain('存在未处理的修改冲突')
    expect(router.currentRoute.value.params.name).toBe('书A') // 取消 → 路由不提交
    expect(replaceSpy).not.toHaveBeenCalled() // 无「回退路由」动作（没切过，无从回退）
    expect(doc.bookName).toBe('书A')
    expect(doc.get('d1')!.dirty).toBe(true) // A 的未落盘编辑原封（缓存未被 setBook 清）
    expect(wb.textOut).toBe('A 书工作台残留') // 事件 store 未被清（旧行为：取消后 clearEventStores 善后）
    expect(mocks.resync.mock.calls.length).toBe(resyncBefore) // 无 resync：未重连、无善后
    expect(sessionA.stillIn()).toBe(true) // 会话仍是 A（未切）
    expect(bookSessionFor('书B')).toBeNull() // 目标书会话从未建立 → B 的 SSE 从未连上、事件从未落 store
  })

  it('F1 形态（flush 失败）+ 取消 → 路由留在原书、dirty 保留可重试', async () => {
    const doc = useDocStore()
    const ui = useUiStore()
    await seedDirty('d1')
    mocks.saveContent.mockRejectedValue(new Error('网络断了'))
    const askSpy = askAt(ui, false)

    await router.push(bookPath('书B'))
    await flushPromises()

    expect(visitOrder).toEqual(['书A'])
    expect(askSpy.mock.calls[0]![0].title).toContain('保存失败')
    expect(router.currentRoute.value.params.name).toBe('书A')
    expect(doc.get('d1')!.dirty).toBe(true)
  })
})

describe('R0916-7-P3-20: 提交前守卫——决断后照常切书', () => {
  it('冲突 + 确认丢弃 → 提交路由并进书（新会话、旧会话作废、链尾 resync）', async () => {
    const doc = useDocStore()
    const ui = useUiStore()
    await seedDirty('d1', { conflict: true })
    const sessionA = currentBookSession()!
    const resyncBefore = mocks.resync.mock.calls.length
    askAt(ui, true)

    await router.push(bookPath('书B'))
    await flushPromises()

    expect(visitOrder).toEqual(['书A']) // 决断仍在提交前
    expect(router.currentRoute.value.params.name).toBe('书B')
    expect(doc.bookName).toBe('书B')
    expect(doc.get('d1')).toBeUndefined() // 已决断丢弃 → setBook 清缓存
    expect(sessionA.stillIn()).toBe(false) // 旧会话随切书作废
    expect(sessionA.signal.aborted).toBe(true)
    expect(currentBookSession()!.name).toBe('书B') // 进书建新会话
    expect(mocks.resync.mock.calls.length).toBeGreaterThan(resyncBefore)
  })

  it('无脏无冲突 → 不弹窗直接提交（守卫不误伤）', async () => {
    const ui = useUiStore()
    const askSpy = vi.spyOn(ui, 'ask')

    await router.push(bookPath('书B'))
    await flushPromises()

    expect(askSpy).not.toHaveBeenCalled()
    expect(router.currentRoute.value.params.name).toBe('书B')
    expect(useDocStore().bookName).toBe('书B')
  })
})
