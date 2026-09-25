// @vitest-environment happy-dom
/**
 * R0916-7-P3-20（评审 P3-20）回归③：迟到结果被 AbortError 统一吸收
 * （useChapterTreeActions 的 stillIn/failScoped 各点）。
 *
 * 端到端形态（不 mock api 层）：真实 api/documents + 真实 api/client + 桩 fetch。
 * 旧书动作在途 → 切书（begin 新会话 = abort 旧会话）→ 在途请求被中止 → 动作侧
 * failScoped 顶部静默吸收：不刷树、不落 openError、不弹 toast。旧写法要在每个动作的
 * catch 里手写「先查书名再落错」，现在由会话信号 + isAbortError 单源接管。
 * 另两条对照钉住「守卫不误伤」：未切书的真实失败仍落 openError；已切书的非 Abort
 * 迟到错误仍按 R34D-21 静默（会话取不到 → 回落书名复检）。还有一条 A→B→A 快速连切：
 * 迟到 AbortError 的判据只剩「是否为 abort」，是 isAbortError 吸收不可被书名复检替代的面。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { beginBookSession, endBookSession } from '../../../src/studio/web-next/src/composables/useBookSession'

// ── 网络面：真实 api 模块 + 桩 fetch（可放行/可被 abort 打断）──
const fetchMock = vi.fn()
let pending: { resolve: (r: Response) => void } | null = null
const response = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** 默认真实语义：请求挂起，signal abort 时 reject AbortError。 */
function fetchHonoringAbort(): void {
  fetchMock.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
    const signal = init?.signal
    return new Promise<Response>((resolve, reject) => {
      pending = { resolve }
      signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), { once: true })
    })
  })
}

// ── store 面：树/doc/ui/workspace 桩（本文件主题是动作侧守卫，非 store）──
const treeMock = {
  byPath: new Map<string, { docId: string }>(),
  byDocId: new Map<string, { path: string }>(),
  load: vi.fn(async () => {}),
  updateWordCount: vi.fn(),
  grouped: [] as unknown[],
  raw: [] as unknown[],
}
const docMock = {
  get: vi.fn(() => undefined),
  open: vi.fn(),
  refresh: vi.fn(async () => {}),
  save: vi.fn(async () => true),
  patch: vi.fn(),
  clearDirtyMirror: vi.fn(),
}
const toastMock = vi.fn()
vi.mock('../../../src/studio/web-next/src/stores/tree', () => ({ useTreeStore: vi.fn(() => treeMock) }))
vi.mock('../../../src/studio/web-next/src/stores/doc', () => ({ useDocStore: vi.fn(() => docMock) }))
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({ useUiStore: vi.fn(() => ({ toast: toastMock, ask: vi.fn(async () => true) })) }))
vi.mock('../../../src/studio/web-next/src/stores/workspace', () => ({ useWorkspaceStore: vi.fn(() => ({ openTab: vi.fn(), activeDocId: ref(null) })) }))

import { useChapterTreeActions } from '../../../src/studio/web-next/src/composables/useChapterTreeActions'

let currentBook = '书A'

function setup(): { actions: ReturnType<typeof useChapterTreeActions>; openError: ReturnType<typeof ref<string | null>> } {
  const openError = ref<string | null>(null)
  const actions = useChapterTreeActions({ bookName: () => currentBook, openError })
  return { actions, openError }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  pending = null
  currentBook = '书A'
  fetchHonoringAbort()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  endBookSession()
  vi.unstubAllGlobals()
})

describe('R0916-7-P3-20: 迟到结果被 AbortError 吸收（切书即 abort 旧会话）', () => {
  it('doMove 在途切书 → 旧书迟到请求以 AbortError 收口：不刷树、不落 openError、不弹 toast', async () => {
    beginBookSession('书A')
    const { actions, openError } = setup()
    const p = actions.doMove('doc_1', '写作/正文/第二卷')
    expect(fetchMock).toHaveBeenCalledTimes(1) // 真实请求已发出（本书结构写 → 接会话信号）

    // 切书：进新书 = begin 新会话（abort 旧会话）
    beginBookSession('书B')
    currentBook = '书B'
    await p

    expect(treeMock.load).not.toHaveBeenCalled() // 迟到结果未把旧书树刷进新书工作台
    expect(openError.value).toBeNull() // AbortError 被静默吸收（旧写法这里要手写书名复检才不落错）
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('对照：未切书的真实失败仍落 openError（守卫不误伤）', async () => {
    beginBookSession('书A')
    const { actions, openError } = setup()
    const p = actions.doMove('doc_1', '写作/正文/第二卷')
    pending!.resolve(response(500, { error: '磁盘写入失败' }))
    await p

    expect(openError.value).toBe('磁盘写入失败')
    expect(treeMock.load).not.toHaveBeenCalled()
  })

  it('对照：未切书成功 → 照常刷树（行为不变）', async () => {
    beginBookSession('书A')
    const { actions, openError } = setup()
    const p = actions.doMove('doc_1', '写作/正文/第二卷')
    pending!.resolve(response(200, { ok: true }))
    await p

    expect(openError.value).toBeNull()
    expect(treeMock.load).toHaveBeenCalledWith('书A')
  })

  it('已切书的非 Abort 迟到错误：会话取不到 → 回落书名复检，依旧静默（R34D-21 语义保持）', async () => {
    // 形态：响应赶在 abort 生效前落定（本桩不挂 abort 监听，模拟「未被取消但已迟到」）
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => { pending = { resolve } }),
    )
    beginBookSession('书A')
    const { actions, openError } = setup()
    const p = actions.doMove('doc_1', '写作/正文/第二卷')

    beginBookSession('书B')
    currentBook = '书B'
    pending!.resolve(response(500, { error: '旧书报错' }))
    await p

    expect(openError.value).toBeNull() // 旧书报错不写新书界面
    expect(treeMock.load).not.toHaveBeenCalled()
  })

  it('快速连切回原书（A→B→A）：旧 A 会话被 abort 的迟到错误不再弹在（同为 A 的）新界面', async () => {
    // 这条是「AbortError 吸收」不可被书名复检替代的面：回到 A 后 stillIn('书A') 为真
    //（新 A 会话在册），唯一可用的判据只剩「这个错误是 abort 造成的」——不吸收就会把
    //「操作已取消」当失败报给作者。
    beginBookSession('书A')
    const { actions, openError } = setup()
    const p = actions.doMove('doc_1', '写作/正文/第二卷')

    beginBookSession('书B') // 离开 A：abort A 会话 → 在途请求 reject AbortError
    currentBook = '书B'
    beginBookSession('书A') // 又切回 A（新会话，名字同为书A）
    currentBook = '书A'
    await p

    expect(openError.value).toBeNull() // 静默：作者不该看到「请求已中止」这类字样
    expect(treeMock.load).not.toHaveBeenCalled()
    expect(toastMock).not.toHaveBeenCalled()
  })
})
