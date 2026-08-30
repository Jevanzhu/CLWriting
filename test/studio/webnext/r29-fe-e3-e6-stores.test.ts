/**
 * R29 二十九轮批 E 前端回归（E-3 / E-4 / E-5 / E-6 store 面，node 环境）。
 *
 * E-3：loadBookPrefs 回填 treeExpanded 增加用户已操作守卫（比照 activeDocId 的 R72-11）。
 * E-4：clean 文档缓存新鲜度对账——tree store load 成功后按树版本对打开时记录旧版本的
 *      clean 缓存项静默重拉；dirty/conflict/saving 不动；LRU 迭代序不扰动。
 * E-5：AI 可达性探测改指数退避（5s 起 ×2 封顶 60s），available:true 复位。
 * E-6：今日字数跨零点——ensureBaseline 比对响应 date 与当前本地日期，跨日重记基线再取。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ── 公共 API mock（各用例按需置行为）──────────────────────────
const mocks = vi.hoisted(() => ({
  getContent: vi.fn(),
  getTree: vi.fn(),
  getAiStatus: vi.fn(),
  getWordsDiary: vi.fn(),
  postBaseline: vi.fn(),
  getBookPrefs: vi.fn(),
  putBookPrefs: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: mocks.getContent,
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getTree: mocks.getTree,
  getWordsDiary: mocks.getWordsDiary,
  postBaseline: mocks.postBaseline,
}))
vi.mock('../../../src/studio/web-next/src/api/ai-status', () => ({ getAiStatus: mocks.getAiStatus }))
vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getBookPrefs: mocks.getBookPrefs,
  putBookPrefs: mocks.putBookPrefs,
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  ApiError: class ApiError extends Error {
    status = 0
    code?: string
  },
  getToken: vi.fn(() => 'test-token'),
  rebootstrap: vi.fn(async () => {}),
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
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import { useWordsStore } from '../../../src/studio/web-next/src/stores/words'
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

/** 与 words store localToday 同格式的本地日期 */
function dateStr(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.getBookPrefs.mockResolvedValue({})
  mocks.putBookPrefs.mockResolvedValue(undefined)
  mocks.postBaseline.mockResolvedValue({ ok: true })
})

// ── E-3 ──────────────────────────────────────────────────────
describe('E-3: loadBookPrefs 回填 treeExpanded 的用户已操作守卫', () => {
  it('用户已展开/折叠 → 迟到的 prefs 回填不覆盖；未操作 → 照常回填', async () => {
    const ws = useWorkspaceStore()
    // 书A：getBookPrefs 挂起 → 用户先动展开态 → prefs 迟到
    let releaseA!: (v: { treeExpanded?: string[] }) => void
    mocks.getBookPrefs.mockImplementationOnce(
      () => new Promise((r) => { releaseA = r }),
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

// ── E-4 ──────────────────────────────────────────────────────
describe('E-4: 树刷新后 clean 缓存新鲜度对账', () => {
  it('树版本推进 → 打开时记录旧版本的 clean 项静默重拉对齐磁盘', async () => {
    mocks.getTree.mockResolvedValue({ nodes: [makeNode('d1')], revision: 'r1' })
    const doc = useDocStore()
    const tree = useTreeStore()
    doc.setBook('书A')
    await tree.load('书A', true)
    mocks.getContent.mockResolvedValueOnce('v1')
    await doc.open(makeNode('d1'))
    expect(doc.get('d1')!.content).toBe('v1')
    expect(doc.get('d1')!.treeRev).toBe('r1')

    // 盘上被外部改掉 + 树重扫推进版本
    mocks.getContent.mockResolvedValue('v2')
    mocks.getTree.mockResolvedValue({ nodes: [makeNode('d1')], revision: 'r2' })
    await tree.load('书A', true)
    await vi.waitFor(() => expect(doc.get('d1')!.content).toBe('v2')) // 静默重拉到位
    expect(doc.get('d1')!.treeRev).toBe('r2')
    expect(doc.get('d1')!.dirty).toBe(false)
  })

  it('dirty/conflict 缓存项不对账（本地编辑优先），同版本树不重拉', async () => {
    mocks.getTree.mockResolvedValue({ nodes: [makeNode('d1')], revision: 'r1' })
    const doc = useDocStore()
    const tree = useTreeStore()
    doc.setBook('书A')
    await tree.load('书A', true)
    mocks.getContent.mockResolvedValueOnce('v1')
    await doc.open(makeNode('d1'))
    doc.patch('d1', '本地未保存编辑')

    mocks.getContent.mockClear()
    mocks.getContent.mockResolvedValue('盘上新版')
    mocks.getTree.mockResolvedValue({ nodes: [makeNode('d1')], revision: 'r2' })
    await tree.load('书A', true)
    await Promise.resolve()
    await Promise.resolve()
    expect(doc.get('d1')!.content).toBe('本地未保存编辑') // dirty 不被静默覆盖
    expect(mocks.getContent).not.toHaveBeenCalled() // dirty 项不发起重拉

    // 同版本树再 load → clean 项也不重拉（无版本差）
    doc.get('d1')!.dirty = false
    doc.get('d1')!.treeRev = 'r2'
    mocks.getContent.mockClear()
    await tree.load('书A', true)
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.getContent).not.toHaveBeenCalled()
  })
})

// ── E-5 ──────────────────────────────────────────────────────
describe('E-5: AI 可达性探测指数退避', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('连续失败 → 间隔 5s→10s→20s→…封顶 60s；成功复位后再次失败从 5s 起步', async () => {
    mocks.getAiStatus.mockRejectedValue(new Error('down'))
    const ui = useUiStore()
    await ui.probeAiStatus()
    expect(mocks.getAiStatus).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.getAiStatus).toHaveBeenCalledTimes(2) // 5s
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.getAiStatus).toHaveBeenCalledTimes(3) // 10s
    await vi.advanceTimersByTimeAsync(20_000)
    expect(mocks.getAiStatus).toHaveBeenCalledTimes(4) // 20s

    // 推到封顶：退避阶足够大后间隔钉在 60s（累计推进 60s 恰好多一次调用）
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(60_000)
    const capped = mocks.getAiStatus.mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.getAiStatus.mock.calls.length).toBe(capped) // 30s 内不再触发（间隔 > 30s）
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.getAiStatus.mock.calls.length).toBe(capped + 1) // 恰在 60s 边界触发

    // 成功 → 停止 + 退避阶复位
    mocks.getAiStatus.mockResolvedValue({ available: true, driver: 'x' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ui.aiAvailable).toBe(true)
    const afterOk = mocks.getAiStatus.mock.calls.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(mocks.getAiStatus.mock.calls.length).toBe(afterOk)

    // 再次失败 → 从 5s 重新起步（复位生效）
    mocks.getAiStatus.mockRejectedValue(new Error('down again'))
    await ui.probeAiStatus()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.getAiStatus.mock.calls.length).toBe(afterOk + 2)
  })
})

// ── E-6 ──────────────────────────────────────────────────────
describe('E-6: 今日字数跨零点重记基线', () => {
  it('响应 date 属昨日（慢响应跨日）→ 以当前已写重记基线并重取新日 delta', async () => {
    const tree = useTreeStore()
    const node = makeNode('d1')
    node.wordCount = 300
    tree.raw = [node] // totalWords = 300
    const yesterday = dateStr(new Date(Date.now() - 86_400_000))
    const today = dateStr(new Date())
    mocks.getWordsDiary
      .mockResolvedValueOnce({ date: yesterday, delta: 7, baseline: 50 }) // 零点前生成的响应
      .mockResolvedValueOnce({ date: today, delta: null, baseline: 300 }) // 重取：新日基线已记
    const words = useWordsStore()
    await words.ensureBaseline('书A')

    expect(mocks.postBaseline).toHaveBeenCalledWith('书A', 300) // 修复点：重记今日基线
    expect(words.baseline).toBe(300)
    expect(words.todayDelta).toBeNull() // 新日无 settled 记录 → 回退 baseline（今日 0）
    expect(words.date).toBe(today)
    expect(words.todayWords).toBe(0) // 昨日的 7 字不再算进今日
  })

  it('同日响应走原路径（基线直接采用，不 post）', async () => {
    mocks.getWordsDiary.mockResolvedValueOnce({ date: dateStr(new Date()), delta: 9, baseline: 80 })
    const words = useWordsStore()
    await words.ensureBaseline('书A')
    expect(mocks.postBaseline).not.toHaveBeenCalled()
    expect(words.baseline).toBe(80)
    expect(words.todayDelta).toBe(9)
  })
})
