// @vitest-environment happy-dom
/**
 * R43（四十三轮）前端批回归：
 * - R43-11：StartupNoticeBanner localStorage 脏值容错（非数组不炸 + 非 string 元素过滤）。
 * - R43-9：useTheme ViewTransition 被抢占（ready/finished reject）→ 无 unhandledRejection
 *   （win 已瞬切不进 VT〔2026-09-04 拍板〕，抢占面在 mac/浏览器腿）。
 * - R43-15：CmHost 双组合间隙 <1 帧的丢弃分支保留挂起（自愈链：下一次 compositionend
 *   的既有消费路径再触发应用，修复前挂起被清后外部替换永久丢失）。
 * - R43-16：doc store save 成功对齐 treeRev 至当前树版本（dirty 窗口错过的树刷新不再把
 *   自客户端保存当外部变更重拉）。
 * - R43-17：EditorView 切 docId 字数即刻重算（不进 150ms 防抖窗口滞留旧文档字数）。
 * - R43-8 / R43-15 另附静态源码锚（防御 catch / 挂起保留注释在位，防重构无声脱落）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const mocks = vi.hoisted(() => ({
  getStartupNotices: vi.fn(),
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  getConfig: vi.fn(),
  getTree: vi.fn(),
  getWordsDiary: vi.fn(),
  postBaseline: vi.fn(),
  getCompletionNames: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/startup-notices', () => ({
  getStartupNotices: mocks.getStartupNotices,
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: mocks.getContent,
  saveContent: mocks.saveContent,
  finalizeDoc: mocks.finalizeDoc,
  updateChapterMetaDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
  getTree: mocks.getTree,
  getWordsDiary: mocks.getWordsDiary,
  postBaseline: mocks.postBaseline,
}))
vi.mock('../../../src/studio/web-next/src/api/settings', () => ({
  getCompletionNames: mocks.getCompletionNames,
}))
// prefs API mock：useTheme 测试走真 prefs store（applyTheme 语义在测），
// 持久化通道 mock 掉防落盘副作用；getBookPrefs 供 workspace store（EditorView 图内）。
vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getGlobalPrefs: vi.fn(async () => ({ prefs: {}, revision: 'r0' })),
  putGlobalPrefs: vi.fn(async () => ({ revision: 'r1' })),
  getBookPrefs: vi.fn(async () => ({})),
  putBookPrefs: vi.fn(async () => ({})),
}))

import StartupNoticeBanner from '../../../src/studio/web-next/src/components/ui/StartupNoticeBanner.vue'
import CmHost from '../../../src/studio/web-next/src/editor/CmHost.vue'
import EditorView from '../../../src/studio/web-next/src/views/EditorView.vue'
import { useTheme } from '../../../src/studio/web-next/src/composables/useTheme'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const DISMISS_KEY = 'clw-startup-notices-dismissed'
const BOOK = 'r43-book'

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

function makeNode(docId: string, path: string): TreeNode {
  return {
    path,
    name: path.split('/').pop() ?? path,
    isDirectory: false,
    role: 'chapter',
    docId,
    status: 'draft',
    children: [],
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  mocks.getStartupNotices.mockReset().mockResolvedValue([
    { ts: '1', kind: 'k1', message: 'm1' },
    { ts: '2', kind: 'k2', message: 'm2' },
  ])
  mocks.getContent.mockReset().mockResolvedValue('正文')
  mocks.saveContent.mockReset().mockResolvedValue({ revision: 'sha256:new' })
  mocks.finalizeDoc.mockReset()
  mocks.getConfig.mockReset().mockResolvedValue({ kind: 'long' })
  mocks.getWordsDiary.mockReset().mockRejectedValue(new Error('离线降级'))
  mocks.postBaseline.mockReset()
  mocks.getCompletionNames.mockReset().mockResolvedValue({ characters: [], items: [] })
})

// ── R43-11：StartupNoticeBanner localStorage 容错 ─────────────────────────────

describe('R43-11: StartupNoticeBanner localStorage 脏值容错', () => {
  it('非数组 JSON（对象）→ 不炸，按无已读处理（通告全可见）', async () => {
    localStorage.setItem(DISMISS_KEY, '{"k1@1":true}')
    const w = mount(StartupNoticeBanner, { attachTo: document.body })
    await flushPromises()
    expect(w.findAll('.sn-list li')).toHaveLength(2) // 修复前：对象被 as string[] 透传（不炸但比对失真）
    w.unmount()
  })

  it('数组含非 string 元素 → 过滤，指纹命中照常生效；dismiss 回写全 string', async () => {
    localStorage.setItem(DISMISS_KEY, JSON.stringify(['k1@1', 42, null, true]))
    const w = mount(StartupNoticeBanner, { attachTo: document.body })
    await flushPromises()
    // k1@1 被指纹命中隐藏；脏元素被过滤不参与比对（k2@2 照常可见）
    expect(w.findAll('.sn-list li')).toHaveLength(1)
    expect(w.find('.sn-list li').text()).toContain('m2')

    // dismiss 回写：已读列表只含 string（脏值不随回写固化）
    await w.find('.sn-close').trigger('click')
    const stored = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '[]') as unknown[]
    expect(stored).toEqual(['k1@1', 'k2@2'])
    expect(stored.every((x) => typeof x === 'string')).toBe(true)
    w.unmount()
  })
})

// ── R43-9：useTheme ViewTransition 抢占防御 ────────────────────────────────────

describe('R43-9: useTheme ViewTransition 被抢占（ready/finished reject）', () => {
  it('无 unhandledRejection 逃逸（win 已瞬切不走 VT，抢占面在 mac/浏览器腿）', async () => {
    vi.useFakeTimers()
    // happy-dom 缺 matchMedia 时补最小替身（只读 .matches）
    if (typeof window.matchMedia !== 'function') {
      ;(window as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia = () => ({ matches: false })
    }
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown) => unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    const overlay = vi.fn()
    const docEl = document.documentElement as unknown as Record<string, unknown>
    const vtDoc = document as unknown as Record<string, unknown>
    const win = window as unknown as Record<string, unknown>
    const prevAnimate = docEl.animate
    try {
      win.clwritingDesktop = {
        platform: 'darwin', // win 已瞬切不进 VT（2026-09-04 拍板）；抢占防御在 mac/浏览器腿
        setTitleBarOverlay: overlay,
      }
      docEl.animate = vi.fn() // happy-dom 无 Element.animate
      // 抢占语义：回调执行（fn 生效）但 ready/finished 均以 reject 收场
      vtDoc.startViewTransition = (cb: () => void) => {
        cb()
        return {
          ready: Promise.reject(new Error('ready 抢占')),
          finished: Promise.reject(new Error('finished 抢占')),
        }
      }

      const { toggle } = useTheme()
      toggle()
      // 微任务冲排：ready.catch / finished.catch 执行
      await vi.advanceTimersByTimeAsync(0)
      // R43-9 核心：浮空 ready.then / 无 catch 的 finished 链不产生 unhandledRejection
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      vtDoc.startViewTransition = undefined
      win.clwritingDesktop = undefined
      if (prevAnimate === undefined) docEl.animate = undefined
      else docEl.animate = prevAnimate
      vi.useRealTimers()
    }
  })
})

// ── R43-15：CmHost 双组合间隙挂起保留（自愈链） ────────────────────────────────

describe('R43-15: CmHost 双组合间隙 <1 帧丢弃分支保留挂起', () => {
  function mountHost(): ReturnType<typeof mount> {
    return mount(CmHost, {
      props: { modelValue: '初文', mode: 'text', historyKey: 'd1' },
      attachTo: document.body,
    })
  }
  function contentEl(w: ReturnType<typeof mount>): HTMLElement {
    const el = w.element.querySelector('.cm-content')
    expect(el).not.toBeNull()
    return el as HTMLElement
  }
  function docText(w: ReturnType<typeof mount>): string {
    return contentEl(w).textContent ?? ''
  }

  it('组合1挂起 → 间隙丢入组合2 → 组合2结束后自愈应用（修复前：挂起被清，永久丢失）', async () => {
    const w = mountHost()
    expect(docText(w)).toBe('初文')

    // 组合 1：外部全量替换到达 → 挂起
    contentEl(w).dispatchEvent(new Event('compositionstart', { bubbles: true }))
    await w.setProps({ modelValue: '外部全量新文' })
    expect(docText(w)).toBe('初文')

    // 组合 1 结束 → 消费挂起（排定 setTimeout 0）
    contentEl(w).dispatchEvent(new Event('compositionend', { bubbles: true }))
    // 间隙 <1 帧：排定回调 fire 前新组合已开始 → 丢弃分支（修复后：保留挂起）
    contentEl(w).dispatchEvent(new Event('compositionstart', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0)) // 上段排定回调 fire：组合中 → 不打断新组合
    expect(docText(w)).toBe('初文')

    // 组合 2 结束 → 既有消费路径再触发 → 应用（自愈链闭合）
    contentEl(w).dispatchEvent(new Event('compositionend', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    expect(docText(w)).toBe('外部全量新文')
    w.unmount()
  })
})

// ── R43-16：doc store save 成功对齐 treeRev ──────────────────────────────────

describe('R43-16: doc store save 成功对齐 treeRev 至当前树版本', () => {
  it('open 记 r1 → dirty 窗口树推进 r2 → save 成功 → treeRev === r2（不再被判外部变更）', async () => {
    const doc = useDocStore()
    const tree = useTreeStore()
    doc.setBook(BOOK)
    tree.revision = 'r1'
    await doc.open(makeNode('d1', '写作/正文/第1章-标题.md'))
    expect(doc.get('d1')!.treeRev).toBe('r1')

    // dirty 窗口期间树版本推进（syncCleanWithTree 跳过 dirty 项，不回填 treeRev）
    tree.revision = 'r2'
    doc.patch('d1', '正文改')
    await expect(doc.save('d1')).resolves.toBe(true)
    // 修复前：treeRev 滞留 r1，下一次树刷新（curRev=r2）把自客户端保存当外部变更重拉
    expect(doc.get('d1')!.treeRev).toBe('r2')
  })
})

// ── R43-17：EditorView 切文档字数即切 ─────────────────────────────────────────

describe('R43-17: EditorView 切 docId 字数即刻重算', () => {
  it('d1（5 字）→ d2（9 字）：切换即显示 9 字，不滞留 150ms 防抖窗口', async () => {
    const doc = useDocStore()
    const tree = useTreeStore()
    doc.setBook(BOOK)
    tree.raw = [makeNode('d1', '写作/正文/第1章-标题.md'), makeNode('d2', '写作/正文/第2章-标题.md')]
    mocks.getContent.mockImplementation(async (_book: string, path: string) =>
      path.includes('第1章') ? '甲甲甲甲甲' : '乙乙乙乙乙乙乙乙乙',
    )
    // 两文档预开入缓存：切 docId 时 body computed 同步就位（纯测防抖窗口行为）
    await doc.open(tree.byDocId.get('d1')!)
    await doc.open(tree.byDocId.get('d2')!)

    const w = mount(EditorView, { props: { docId: 'd1' }, attachTo: document.body })
    await flushPromises()
    expect(w.get('.word-count').text()).toBe('5 字')

    await w.setProps({ docId: 'd2' })
    await flushPromises() // 只冲微任务/渲染，不推进 150ms 定时器
    // 修复前：防抖窗口内仍显示旧文档「5 字」；修复后即刻重算
    expect(w.get('.word-count').text()).toBe('9 字')
    w.unmount()
  })
})

// ── 静态源码锚（防御性修法防无声脱落） ─────────────────────────────────────────

describe('R43-8/R43-15 静态源码锚', () => {
  it('R43-8: useSse 浮空 doConnect 均走 safeDoConnect 防御 catch（退避定时器不裸引）', () => {
    const src = readFileSync(
      join(ROOT, 'src/studio/web-next/src/composables/useSse.ts'),
      'utf-8',
    )
    expect(src).toContain('R43-8（四十三轮）')
    expect(src).toMatch(/void doConnect\(\)\.catch\(\(\) => \{\}\)/)
    expect(src).toContain('setTimeout(safeDoConnect, delay)')
    expect(src).not.toMatch(/setTimeout\(doConnect,/)
  })

  it('R43-15: CmHost 丢弃分支保留挂起（pendingExternal = latest）注释锚在位', () => {
    const src = readFileSync(
      join(ROOT, 'src/studio/web-next/src/editor/CmHost.vue'),
      'utf-8',
    )
    expect(src).toContain('R43-15（四十三轮）')
    expect(src).toContain('pendingExternal = latest')
  })
})
