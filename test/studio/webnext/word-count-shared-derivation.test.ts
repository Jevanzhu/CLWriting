// @vitest-environment happy-dom
/**
 * R0916-7-P3-26（0916-7 批）回归：字数派生跨组件只算一次。
 *
 * 病灶：同一份正文被四个消费点各算一遍（EditorView 顶栏手写副本 + FocusStatsBar /
 * WritingInfoPanel / HistoryPanel 各持 useDebouncedWordCount），MB 级长章每个 150ms
 * 窗口四趟全文码点展开 O(n)。收敛后：顶栏换装 useDebouncedWordCount（内容源改
 * entry.content，与右栏同源同参），共享件内单槽记忆使同一份正文每窗口只算一遍。
 *
 * 断言面：①countWords 调用计数（携新正文的那一次恰为 1——四消费点同窗同文）；②顶栏与
 * 右栏信息面板显示同一读数（份额共享的值确实抵达各消费点）。口径不变由既有
 * r1010c-fe2-debounced-word-count.test.ts 钉住（150ms 窗、切档即刻重算、flush、卸载清理）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  getConfig: vi.fn(),
  listSnapshots: vi.fn(),
  countWords: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: mocks.getContent,
  getContentPayload: vi.fn(
    async (...a: Parameters<typeof mocks.getContent>) => ({ content: await mocks.getContent(...a) }),
  ),
  saveContent: mocks.saveContent,
  finalizeDoc: mocks.finalizeDoc,
  updateChapterMetaDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
  getTree: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/snapshots', () => ({
  listSnapshots: mocks.listSnapshots,
  restoreSnapshot: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getGlobalPrefs: vi.fn(async () => ({ prefs: {}, revision: 'r0' })),
  putGlobalPrefs: vi.fn(async () => ({ revision: 'r1' })),
  getBookPrefs: vi.fn(async () => ({})),
  putBookPrefs: vi.fn(async () => ({})),
}))
// 计数闸挂在 shared/words 的 countWords 出口（useDebouncedWordCount 与 doc store 同经此处）；
// 展开真模块保其余导出（formKindOf/mergeFm/CHAPTER_STATUS…）行为不变
vi.mock('../../../src/studio/web-next/src/shared/words', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/shared/words')>()
  return {
    ...actual,
    countWords: (s: string) => {
      mocks.countWords(s)
      return actual.countWords(s)
    },
  }
})
// 本测试不碰编辑器交互：CmHost 桩（真实 CM6 的挂载成本与字数派生无关）
vi.mock('../../../src/studio/web-next/src/editor/CmHost.vue', () => ({
  default: {
    name: 'CmHost',
    setup(_props: unknown, { expose }: { expose: (o: Record<string, unknown>) => void }) {
      expose({ insertText: vi.fn(), getSelection: () => '', getCursorOffset: () => null, hasSelection: () => false })
      return () => null
    },
  },
}))

import EditorView from '../../../src/studio/web-next/src/views/EditorView.vue'
import FocusStatsBar from '../../../src/studio/web-next/src/components/shell/FocusStatsBar.vue'
import WritingInfoPanel from '../../../src/studio/web-next/src/components/panels/WritingInfoPanel.vue'
import HistoryPanel from '../../../src/studio/web-next/src/components/panels/HistoryPanel.vue'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import { countWords } from '../../../src/studio/web-next/src/shared/words'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const BOOK = 'words-shared-book'

function makeNode(docId: string): TreeNode {
  return {
    path: '写作/正文/第1章-甲.md',
    name: '第1章-甲.md',
    isDirectory: false,
    role: 'chapter',
    docId,
    status: 'draft',
    children: [],
  }
}

/** 携某段正文的 countWords 调用次数（剥 fm 后正文串含 marker 即命中）。 */
const callsWith = (marker: string): number =>
  mocks.countWords.mock.calls.filter((c) => String(c[0]).includes(marker)).length

const mounted: Array<ReturnType<typeof mount>> = []

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  mocks.getContent.mockReset().mockResolvedValue('---\n标题: 第1章\n---\n\n甲文')
  mocks.saveContent.mockReset()
  mocks.finalizeDoc.mockReset()
  mocks.getConfig.mockReset().mockResolvedValue({ kind: 'long', book: { chapter_target_words: 1000 } })
  mocks.listSnapshots.mockReset().mockResolvedValue([])
  mocks.countWords.mockClear()
})

afterEach(async () => {
  for (const w of mounted.splice(0)) w.unmount()
  vi.useRealTimers()
  await flushPromises()
})

/** 四消费点齐挂：顶栏（EditorView）+ 专注条 + 右栏信息面板 + 本章历史。 */
async function mountFourConsumers(): Promise<void> {
  const doc = useDocStore()
  const tree = useTreeStore()
  const ws = useWorkspaceStore()
  ws.activeView = 'editor'
  ws.activeDocId = 'd1'
  ws.bookName = BOOK
  doc.setBook(BOOK)
  tree.raw = [makeNode('d1')]
  await doc.open(tree.byDocId.get('d1')!)
  mounted.push(mount(EditorView, { props: { docId: 'd1' } }))
  mounted.push(mount(FocusStatsBar))
  mounted.push(mount(WritingInfoPanel, { props: { bookName: BOOK } }))
  mounted.push(mount(HistoryPanel, { props: { bookName: BOOK } }))
  await flushPromises()
}

describe('R0916-7-P3-26: 字数派生四消费点只算一次', () => {
  it('正文改动过一窗：携新正文的 countWords 恰一次，顶栏与右栏读数同值', async () => {
    const doc = useDocStore()
    await mountFourConsumers()
    const wrapperTop = mounted[0]!
    const wrapperInfo = mounted[2]!
    // 挂载期（初值当拍）各算一遍：清计数后只观察「一次正文改动」这一个窗口
    mocks.countWords.mockClear()

    // 一次正文改动（marker 独有，避开模块级单槽记忆里挂载期的旧内容）
    doc.patch('d1', '---\n标题: 第1章\n---\n\n甲文乙丙丁戊己庚')
    await flushPromises()
    vi.advanceTimersByTime(150)
    await flushPromises()

    // 四个消费点同窗同文 → 共享件单槽命中 → 实际计算一次（收敛前：4 次）
    expect(callsWith('甲文乙丙丁戊己庚')).toBe(1)
    const expected = countWords('甲文乙丙丁戊己庚')
    expect(wrapperTop.find('.word-count').text()).toBe(`${expected.toLocaleString()} 字`)
    expect(wrapperInfo.find('.words-num').text()).toBe(expected.toLocaleString())
  })

  it('窗口内多次改动只取末值：仍只算一遍（防抖语义不变）', async () => {
    const doc = useDocStore()
    await mountFourConsumers()
    mocks.countWords.mockClear()

    doc.patch('d1', '---\n标题: 第1章\n---\n\n辛未申')
    await flushPromises()
    vi.advanceTimersByTime(100) // 窗口未到
    doc.patch('d1', '---\n标题: 第1章\n---\n\n子丑寅卯')
    await flushPromises()
    vi.advanceTimersByTime(150)
    await flushPromises()

    expect(callsWith('子丑寅卯')).toBe(1) // 末值一算
    expect(callsWith('辛未申')).toBe(0) // 中间值从未进入计算（防抖只在窗末取末值）
    expect(mounted[0]!.find('.word-count').text()).toBe(`${countWords('子丑寅卯').toLocaleString()} 字`)
  })
})
