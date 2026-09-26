// @vitest-environment happy-dom
/**
 * RC 源码重审 B-5（Opus-5.5 轮）单测：切书守卫状态机（composables/useBookSwitchGuard）。
 *
 * 被测行为 = 抽出的状态机本身，不经挂载整个 Book.vue 页：把三段守卫的条件转移逐条钉住
 * ——①脏路由（name=''）分支 ②Z-8 未决冲突预检 ③F1 flush 失败 ④R37-1 flush 后冲突复查，
 * 外加取消回滚（清污 → 回退路由 → resync + 补种原书历史）、同书重入短路（R26-18）、
 * 快速连切防乱序（gen 作废）与链尾 resync（R29-10）。
 *
 * 与既有 Book.vue 挂载面（flush-dirty-switch-guard（原 f1/r37-e1）/
 * book-watch-reentry / panel-open-switch-guard）互补：那些从页面装配面（含模板/视图 stub）
 * 验接线，本文件从状态机自身的注入面（bookName ref + resync 桩）验条件转移与回滚时序。
 * 宿主组件只做一件事：在 setup 内挂上状态机（生命周期与真实页一致）。
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { computed, defineComponent, h, ref, type Ref, type WritableComputedRef } from 'vue'

const mocks = vi.hoisted(() => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  fetchChatHistory: vi.fn(),
  refreshTier: vi.fn(),
  replace: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: mocks.getContent,
  // 重评-0912-4 P1-1:doOpen 改走完整载荷——委托默认包装既有 getContent mock
  getContentPayload: vi.fn(async (...a: Parameters<typeof mocks.getContent>) => ({
    content: await mocks.getContent(...a),
  })),
  saveContent: mocks.saveContent,
  finalizeDoc: mocks.finalizeDoc,
}))
vi.mock('../../../src/studio/web-next/src/api/chat', () => ({
  sendChat: vi.fn(),
  clearChatHistory: vi.fn(),
  confirmTool: vi.fn(),
  fetchChatHistory: mocks.fetchChatHistory,
  fetchChatBranches: vi.fn(async () => ({ branches: [], activeBranchId: null })),
  regenerateChat: vi.fn(),
}))
// 重评-0914-三轮 nano R7-1：ApiError 真类单源（本文件构造 409 conflict 用它）
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return { ...actual, getToken: vi.fn(() => 'test-token') }
})
// 切书链尾刷对话档位（R46-34 TTL 门在真实件内）——桩掉避免真 provider 拉网
vi.mock('../../../src/studio/web-next/src/composables/useChatTier', () => ({
  useChatTier: vi.fn(() => ({ refresh: mocks.refreshTier })),
}))
// 网络面无关本测：切书链内 ws.setBook（书级 prefs 拉取）与保存成功后的今日字数基线
// 都会发请求——按「只假网络面、store 全真件」纪律桩掉（沿 finalize-switch-guard（原 r64-switch-guards）惯例）
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getTree: vi.fn(async () => ({ nodes: [], revision: '' })),
  getConfig: vi.fn(async () => ({ kind: 'long' })),
  getWordsDiary: vi.fn(async () => ({ date: '2026-09-23', baseline: 0, delta: 0 })),
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

// 路由桩：只有 useRouter + onBeforeRouteUpdate（本状态机不取 useRoute——bookName 由调用方注入）。
// R0916-7-P3-20：本文件直挂状态机（无 router-view 上下文），提交前守卫（onBeforeRouteUpdate）
// 以空桩登记——本文件验的仍是提交后 watch 链；提交前守卫面见 book-switch-precommit-guard.test.ts。
vi.mock('vue-router', () => ({ useRouter: () => ({ replace: mocks.replace }), onBeforeRouteUpdate: vi.fn() }))
vi.mock('../../../src/studio/web-next/node_modules/vue-router', () => ({
  useRouter: () => ({ replace: mocks.replace }),
  onBeforeRouteUpdate: vi.fn(),
}))

import { useBookSwitchGuard } from '../../../src/studio/web-next/src/composables/useBookSwitchGuard'
import { ApiError } from '../../../src/studio/web-next/src/api/client'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
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

/** 宿主：setup 内只挂状态机（生命周期与 Book.vue 一致，其余一概不装配）。 */
// 注入面类型对齐真实调用方：bookName 为 computed（可写代理仅为测试改值）、resync 为回调
let bookNameSrc: Ref<string>
let bookName: WritableComputedRef<string>
let resync: Mock<() => void>
function mountGuard(): { unmount: () => void } {
  const Host = defineComponent({
    setup() {
      useBookSwitchGuard({ bookName, resync })
      return () => h('div')
    },
  })
  return mount(Host)
}

/** 造「脏 + 可选冲突」的当前书文档（Z-8 / F1 守卫形态） */
async function seedDirty(docId: string, opts: { conflict?: boolean } = {}): Promise<void> {
  const doc = useDocStore()
  mocks.getContent.mockResolvedValueOnce('盘上内容')
  await doc.open(makeNode(docId))
  doc.patch(docId, '本地未落盘编辑')
  doc.get(docId)!.conflict = opts.conflict === true
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  bookNameSrc = ref('书A')
  // 可写 computed：状态机侧仍是 ComputedRef（同真实调用方的 bookName），测试侧可拨值
  bookName = computed({
    get: () => bookNameSrc.value,
    set: (v: string) => {
      bookNameSrc.value = v
    },
  })
  resync = vi.fn<() => void>()
  mocks.getContent.mockResolvedValue('内容')
  mocks.saveContent.mockResolvedValue({ ok: true, revision: `sha256:${'b'.repeat(64)}`, superseded: false })
  mocks.fetchChatHistory.mockResolvedValue({ messages: [] })
  // 路由桩要复刻真实 router.replace 的副作用：回退后 bookName 随 params 变回原书
  // （revertToPrevBook 的 `bookName.value === prevBook` 复检与 watch 重入都依赖它）
  mocks.replace.mockImplementation(async (path: string) => {
    bookName.value = decodeURIComponent(String(path).replace('/book/', ''))
  })
})

describe('RC B-5: 切书守卫——首载与脏路由分支', () => {
  it('首载 name=书A → 走一次切书流程（setBook/doc+ws），不弹任何决断窗', async () => {
    const doc = useDocStore()
    const ws = useWorkspaceStore()
    const ui = useUiStore()
    const askSpy = vi.spyOn(ui, 'ask')
    const w = mountGuard()
    await flushPromises()
    expect(askSpy).not.toHaveBeenCalled()
    expect(doc.bookName).toBe('书A')
    expect(ws.bookName).toBe('书A')
    expect(resync).toHaveBeenCalledTimes(1) // R29-10：链尾 resync
    w.unmount()
  })

  it("脏路由 name='' → 先落盘前书 dirty 再清各 store，且不走 Z-8/F1 弹窗（E-7）", async () => {
    const doc = useDocStore()
    const wb = useWorkbenchStore()
    const ui = useUiStore()
    const askSpy = vi.spyOn(ui, 'ask')
    const w = mountGuard()
    await flushPromises()

    await seedDirty('d1')
    wb.textOut = 'A 书残留'
    bookName.value = ''
    await flushPromises()

    expect(mocks.saveContent).toHaveBeenCalledTimes(1) // 残存 dirty 属前书：先落盘
    expect(askSpy).not.toHaveBeenCalled() // 脏路由非切书决断
    expect(doc.bookName).toBe('')
    expect(doc.docs.size).toBe(0)
    expect(wb.textOut).toBe('')
    w.unmount()
  })
})

describe('RC B-5: 切书守卫——Z-8 未决冲突段', () => {
  it('冲突 + dirty → 弹「冲突」决断窗；拒绝 → 清污 + 回退路由留在原书，doc 缓存不被清', async () => {
    const doc = useDocStore()
    const wb = useWorkbenchStore()
    const ui = useUiStore()
    const askSpy = vi.spyOn(ui, 'ask').mockResolvedValue(false)
    const clearSpy = vi.spyOn(wb, 'clear')
    const w = mountGuard()
    await flushPromises()
    const clearsAfterLoad = clearSpy.mock.calls.length

    await seedDirty('d1', { conflict: true })
    bookName.value = '书B'
    await flushPromises()

    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(askSpy.mock.calls[0]![0].title).toContain('存在未处理的修改冲突')
    expect(mocks.replace).toHaveBeenCalledWith('/book/' + encodeURIComponent('书A')) // 回退路由
    // Z-8 段的弹窗在链首 workbench.clear() 之前（第五轮口径：clear 早于 flushDirty）——
    // 故本路径只有回滚补清一次（clearWorkbench=true），无链首那次
    expect(clearSpy.mock.calls.length).toBe(clearsAfterLoad + 1)
    // 回退链的 resync 另有一道 gen 复检闸（`bookGen.fresh(gen)`）——回退后 watch 重入
    // （n === lastBook 短路）先推进代数，本拍故不复重取（既有闸语义，refactor 未动）；
    // 此处只钉「首载恰一次」，不把这条顺序细节写进断言
    expect(resync).toHaveBeenCalledTimes(1)
    expect(doc.bookName).toBe('书A') // 未切书
    expect(doc.get('d1')).toBeDefined() // 缓存原封（未被 setBook 清）
    w.unmount()
  })

  it('冲突 + dirty → 确认丢弃 → 照常切到目标书（ask 恰一次）', async () => {
    const doc = useDocStore()
    const ui = useUiStore()
    vi.spyOn(ui, 'ask').mockResolvedValue(true)
    const w = mountGuard()
    await flushPromises()

    await seedDirty('d1', { conflict: true })
    bookName.value = '书B'
    await flushPromises()

    expect(doc.bookName).toBe('书B')
    expect(doc.get('d1')).toBeUndefined() // setBook 清缓存（已决断丢弃）
    w.unmount()
  })

  it('R37-1 台账：预检已决断「丢弃」的冲突项在 flush 后复查不二次弹窗', async () => {
    const doc = useDocStore()
    const ui = useUiStore()
    const askSpy = vi.spyOn(ui, 'ask').mockResolvedValue(true)
    const w = mountGuard()
    await flushPromises()

    await seedDirty('d1', { conflict: true })
    bookName.value = '书B'
    await flushPromises()

    // 决断后条目仍是 conflict + dirty（flushDirty 跳过 conflict 项）——复查面命中，
    // 但已在 adjudicated 台账内，不得对同一决断重复提问
    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(doc.bookName).toBe('书B')
    w.unmount()
  })
})

describe('RC B-5: 切书守卫——F1 保存失败段与 R37-1 复查段', () => {
  it('flush 失败（非冲突）+ 拒绝 → 弹「保存失败」窗 + 回退路由，dirty 保留可重试', async () => {
    const doc = useDocStore()
    const ui = useUiStore()
    const askSpy = vi.spyOn(ui, 'ask').mockResolvedValue(false)
    const w = mountGuard()
    await flushPromises()

    await seedDirty('d1')
    mocks.saveContent.mockRejectedValue(new Error('网络断了'))
    bookName.value = '书B'
    await flushPromises()

    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(askSpy.mock.calls[0]![0].title).toContain('保存失败') // 文案区分（非冲突口径）
    expect(mocks.replace).toHaveBeenCalledWith('/book/' + encodeURIComponent('书A'))
    expect(doc.bookName).toBe('书A')
    expect(doc.get('d1')!.dirty).toBe(true) // 留在原书等重试
    w.unmount()
  })

  it('R37-1：flush 等待窗内落成 REVISION_CONFLICT（非预检已决断）→ 复查段再弹冲突窗', async () => {
    const doc = useDocStore()
    const ui = useUiStore()
    const askSpy = vi.spyOn(ui, 'ask').mockResolvedValue(true)
    const w = mountGuard()
    await flushPromises()

    await seedDirty('d1') // 预检无冲突（adjudicated 空）
    // 模拟 flush 等待窗口内在途保存落成冲突：saveContent 回 409 REVISION_CONFLICT
    // → doc.save 置 conflict=true（dirty 保持）→ 既不在 failed 空口径内也不被重扫
    mocks.saveContent.mockRejectedValue(new ApiError('已在其他窗口被修改', 409, 'REVISION_CONFLICT'))
    bookName.value = '书B'
    await flushPromises()

    expect(askSpy).toHaveBeenCalledTimes(2)
    expect(askSpy.mock.calls[0]![0].title).toContain('保存失败')
    expect(askSpy.mock.calls[1]![0].title).toContain('存在未处理的修改冲突')
    expect(doc.bookName).toBe('书B') // 两次均确认丢弃 → 切书完成
    w.unmount()
  })
})

describe('RC B-5: 切书守卫——重入短路、防乱序与链尾 resync', () => {
  it('R26-18 同书重入短路：回退路由重入（n === lastBook）零动作，不重复清态/弹窗', async () => {
    const doc = useDocStore()
    const wb = useWorkbenchStore()
    const ui = useUiStore()
    const askSpy = vi.spyOn(ui, 'ask').mockResolvedValue(false)
    const clearSpy = vi.spyOn(wb, 'clear')
    const w = mountGuard()
    await flushPromises()

    await seedDirty('d1', { conflict: true })
    bookName.value = '书B'
    await flushPromises()
    const clearsAfterAttempt = clearSpy.mock.calls.length

    // replace 桩已把 bookName 拨回原书（等效路由回跳）→ watch 重入，n === lastBook
    await flushPromises()

    expect(clearSpy.mock.calls.length).toBe(clearsAfterAttempt) // 重入零动作
    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(doc.get('d1')).toBeDefined()
    w.unmount()
  })

  it('快速连切防乱序：B 链挂在 flushDirty 时又切 C → B 链作废，只有 C 链收尾（gen 守卫）', async () => {
    const doc = useDocStore()
    const w = mountGuard()
    await flushPromises()

    await seedDirty('d1')
    let releaseSave!: (v: { ok: true; revision: `sha256:${string}` }) => void
    mocks.saveContent.mockImplementationOnce(
      () =>
        new Promise((r) => {
          releaseSave = r
        }),
    )

    bookName.value = '书B'
    await flushPromises() // B 链挂在 flushDirty（save 在途）
    bookName.value = '书C'
    await flushPromises() // C 链接管：B 链 gen 作废
    releaseSave({ ok: true, revision: `sha256:${'c'.repeat(64)}` })
    await flushPromises()

    expect(doc.bookName).toBe('书C') // B 链醒来查代不过，不落 setBook('B')
    w.unmount()
  })

  it('R0916-7-P3-26 迟到结果丢弃：决断弹窗 await 窗内轮回作废 → 迟到的「丢弃并切换」不落态', async () => {
    // 换装 useStaleGuard 后语义锚（原裸计数器 bookGen 逐位等价）：弹窗确认迟到于新轮
    // 之后才 resolve 时，已作废轮不得继续 setBook/清污——否则路由已指向 C，store 落到 B
    const doc = useDocStore()
    const ui = useUiStore()
    const asks: Array<(v: boolean) => void> = []
    vi.spyOn(ui, 'ask').mockImplementation(
      () =>
        new Promise<boolean>((r) => {
          asks.push(r)
        }),
    )
    const w = mountGuard()
    await flushPromises()

    await seedDirty('d1')
    mocks.saveContent.mockRejectedValue(new Error('网络断了'))
    bookName.value = '书B'
    await flushPromises() // B 链挂在 F1 决断弹窗（flush 失败段）
    expect(asks).toHaveLength(1)

    bookName.value = '书C'
    await flushPromises() // C 链接管（B 链代次作废）；C 链同样挂在弹窗
    expect(asks).toHaveLength(2)

    asks[0]!(true) // B 链的迟到确认：丢弃并切换
    await flushPromises()
    expect(doc.bookName).toBe('书A') // 已作废轮不落 setBook('B')（C 链仍在等自己的决断）

    asks[1]!(true) // C 链的确认
    await flushPromises()
    expect(doc.bookName).toBe('书C')
    w.unmount()
  })

  it('链尾 resync 只在 gen 通过且 bookName 仍等于本轮目标时触发', async () => {
    const w = mountGuard()
    await flushPromises()
    expect(resync).toHaveBeenCalledTimes(1)

    bookName.value = '书B'
    await flushPromises()
    expect(resync).toHaveBeenCalledTimes(2) // 切书链尾再取一次快照
    w.unmount()
  })
})
