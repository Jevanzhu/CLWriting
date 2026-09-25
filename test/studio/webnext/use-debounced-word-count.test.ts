// @vitest-environment happy-dom
/**
 * 字数派生（useDebouncedWordCount / useDebouncedFmFields）行为族——按行为合并两散落
 * 文件（原 r1010c-fe2-debounced-word-count + word-count-shared-derivation）+ R43-17
 * 组件面用例（原 r43-frontend-batch R43-17 节，随族落位）。
 *
 * - R1010c-FE2-P3-6（2026-09-10 全量独立复审修复批）：useDebouncedWordCount /
 *   useDebouncedFmFields 直测（此前 75 行、7 组件消费、零直测）。语义锚（头注 +
 *   R43-17 纪律）：① 初值当拍（首屏/挂载即时，无防抖窗口）；② 同 key 内容变化 150ms
 *   防抖、窗口内多次变化只取末值；③ key 变化（切文档）即刻重算并作废在途定时器（防抖
 *   窗不滞留旧文档值）；④ flush() 同步取当拍（关键时点先 flush 防低估）；⑤ 卸载清
 *   定时器（无孤儿回调）；⑥ 缺省剥 front matter、stripFm=false 对裸生成文本；
 *   ⑦ undefined 内容 → 0 / 空表。
 * - R0916-7-P3-26（0916-7 批）：字数派生跨组件只算一次。病灶：同一份正文被四个消费点
 *   各算一遍（EditorView 顶栏手写副本 + FocusStatsBar / WritingInfoPanel / HistoryPanel
 *   各持 useDebouncedWordCount），MB 级长章每个 150ms 窗口四趟全文码点展开 O(n)。收敛后：
 *   顶栏换装 useDebouncedWordCount（内容源改 entry.content，与右栏同源同参），共享件内
 *   单槽记忆使同一份正文每窗口只算一遍。
 * - R43-17（四十三轮）：EditorView 切 docId 字数即刻重算（不进 150ms 防抖窗口滞留
 *   旧文档字数）。
 *
 * 假时钟对齐 r47-debounced-source 先例；字数期望值用同源 countWords 计算（不复制口径）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, h, render, nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import {
  useDebouncedWordCount,
  useDebouncedFmFields,
} from '../../../src/studio/web-next/src/composables/useDebouncedWordCount'
import { countWords } from '../../../src/studio/web-next/src/shared/words'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

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

const BOOK = 'words-shared-book'

/** 组件作用域挂载（composable 内 onUnmounted 需组件实例）；返回卸载函数（r47 同款）。 */
function mountWith(setup: () => void): () => void {
  const el = document.createElement('div')
  const Comp = { setup } as unknown as Parameters<typeof h>[0]
  render(h(Comp), el)
  return () => render(null, el)
}

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

function makeNodeAt(docId: string, path: string): TreeNode {
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

// ── R1010c-FE2-P3-6：composable 直测 ────────────────────────

describe('R1010c-FE2-P3-6: useDebouncedWordCount', () => {
  it('初值当拍（挂载即正确，无防抖窗口）', () => {
    const src = ref('正文一二三')
    let r: ReturnType<typeof useDebouncedWordCount> | undefined
    mountWith(() => {
      r = useDebouncedWordCount(() => src.value)
    })
    expect(r!.count.value).toBe(countWords('正文一二三'))
  })

  it('同 key 内容变化 150ms 防抖——窗口内不更新、多次变化只取末值', async () => {
    const src = ref('一二三')
    let r: ReturnType<typeof useDebouncedWordCount> | undefined
    mountWith(() => {
      r = useDebouncedWordCount(() => src.value)
    })
    src.value = '一二三四'
    await nextTick()
    expect(r!.count.value).toBe(3) // 防抖窗口内不更新
    src.value = '一二三四五六七'
    await nextTick()
    vi.advanceTimersByTime(149)
    expect(r!.count.value).toBe(3) // 差 1ms 仍不更新
    vi.advanceTimersByTime(1)
    expect(r!.count.value).toBe(7) // 只取末值
  })

  it('key 变化（切文档）即刻取新文档值——在途防抖定时器作废，不回灌旧文档值', async () => {
    const src = ref('甲文档')
    const key = ref('doc-a')
    let r: ReturnType<typeof useDebouncedWordCount> | undefined
    mountWith(() => {
      r = useDebouncedWordCount(() => src.value, () => key.value)
    })
    src.value = '甲文档改'
    await nextTick()
    vi.advanceTimersByTime(100) // 旧文档的防抖窗口走了一半
    // 未到 150ms 即切文档：key 变化当拍取新文档内容（R43-17：窗口不滞留旧文档值）
    key.value = 'doc-b'
    src.value = '乙文档内容长一些'
    await nextTick()
    expect(r!.count.value).toBe(countWords('乙文档内容长一些'))
    vi.advanceTimersByTime(300) // 旧定时器（携带 甲文档改）已被取消——过期触发也不回灌
    expect(r!.count.value).toBe(countWords('乙文档内容长一些'))
  })

  it('flush() 同步取当拍（关键时点防 150ms 窗内低估）', async () => {
    const src = ref('一二三')
    let r: ReturnType<typeof useDebouncedWordCount> | undefined
    mountWith(() => {
      r = useDebouncedWordCount(() => src.value)
    })
    src.value = '一二三四五六'
    await nextTick()
    expect(r!.count.value).toBe(3) // 窗口内仍旧值
    r!.flush()
    expect(r!.count.value).toBe(6) // flush 即刻取当拍
  })

  it('卸载清定时器——防抖回调不再更新输出', async () => {
    const src = ref('一二三')
    let r: ReturnType<typeof useDebouncedWordCount> | undefined
    const unmount = mountWith(() => {
      r = useDebouncedWordCount(() => src.value)
    })
    src.value = '一二三四五'
    await nextTick()
    unmount()
    vi.advanceTimersByTime(500)
    expect(r!.count.value).toBe(3) // 卸载后在途定时器已清，不更新
  })

  it('undefined 内容 → 0（初始与防抖后一致）', async () => {
    const src = ref<string | undefined>(undefined)
    let r: ReturnType<typeof useDebouncedWordCount> | undefined
    mountWith(() => {
      r = useDebouncedWordCount(() => src.value)
    })
    expect(r!.count.value).toBe(0)
    src.value = '一二'
    await nextTick()
    vi.advanceTimersByTime(150)
    expect(r!.count.value).toBe(2)
  })

  it('缺省剥 front matter；stripFm=false 对裸生成文本不剥', () => {
    const withFm = '---\ntitle: 测试\n---\n\n正文一二三'
    const src = ref(withFm)
    let stripped: ReturnType<typeof useDebouncedWordCount> | undefined
    let raw: ReturnType<typeof useDebouncedWordCount> | undefined
    mountWith(() => {
      stripped = useDebouncedWordCount(() => src.value)
      raw = useDebouncedWordCount(() => src.value, () => undefined, { stripFm: false })
    })
    // 期望值用同源 countWords 计算（不复制剥 fm 口径）
    expect(stripped!.count.value).toBe(countWords('正文一二三'))
    expect(raw!.count.value).toBe(countWords(withFm))
    expect(raw!.count.value).toBeGreaterThan(stripped!.count.value) // fm 头计入与不计入可区分
  })
})

describe('R1010c-FE2-P3-6: useDebouncedFmFields', () => {
  it('初值当拍解析 fm 字段表', () => {
    const src = ref('---\ntitle: 上卷\npov: 甲人\n---\n\n正文')
    let r: ReturnType<typeof useDebouncedFmFields> | undefined
    mountWith(() => {
      r = useDebouncedFmFields(() => src.value)
    })
    expect(r!.fields.value).toEqual({ title: '上卷', pov: '甲人' })
  })

  it('undefined 内容 → 空表', () => {
    const src = ref<string | undefined>(undefined)
    let r: ReturnType<typeof useDebouncedFmFields> | undefined
    mountWith(() => {
      r = useDebouncedFmFields(() => src.value)
    })
    expect(r!.fields.value).toEqual({})
  })

  it('同 key 内容变化走 150ms 防抖；key 变化（切文档）即刻取新表', async () => {
    const src = ref('---\ntitle: 上卷\n---\n\n正文')
    const key = ref('doc-a')
    let r: ReturnType<typeof useDebouncedFmFields> | undefined
    mountWith(() => {
      r = useDebouncedFmFields(() => src.value, () => key.value)
    })
    src.value = '---\ntitle: 上卷改\n---\n\n正文'
    await nextTick()
    vi.advanceTimersByTime(149)
    expect(r!.fields.value).toEqual({ title: '上卷' }) // 防抖窗口内不更新
    vi.advanceTimersByTime(1)
    expect(r!.fields.value).toEqual({ title: '上卷改' })
    // 切文档：即刻取新文档的表，不滞留旧文档值
    key.value = 'doc-b'
    src.value = '---\nview: 乙视角\n---\n\n正文B'
    await nextTick()
    expect(r!.fields.value).toEqual({ view: '乙视角' })
  })
})

// ── R0916-7-P3-26：跨组件只算一次 ────────────────────────

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

// ── R43-17：EditorView 切文档字数即刻重算 ────────────────────────

describe('R43-17: EditorView 切 docId 字数即刻重算', () => {
  it('d1（5 字）→ d2（9 字）：切换即显示 9 字，不滞留 150ms 防抖窗口', async () => {
    const doc = useDocStore()
    const tree = useTreeStore()
    doc.setBook(BOOK)
    tree.raw = [makeNodeAt('d1', '写作/正文/第1章-标题.md'), makeNodeAt('d2', '写作/正文/第2章-标题.md')]
    mocks.getContent.mockImplementation(async (_book: string, path: string) =>
      path.includes('第1章') ? '甲甲甲甲甲' : '乙乙乙乙乙乙乙乙乙',
    )
    // 两文档预开入缓存：切 docId 时 body computed 同步就位（纯测防抖窗口行为）
    await doc.open(tree.byDocId.get('d1')!)
    await doc.open(tree.byDocId.get('d2')!)

    const w = mount(EditorView, { props: { docId: 'd1' }, attachTo: document.body })
    mounted.push(w)
    await flushPromises()
    expect(w.get('.word-count').text()).toBe('5 字')

    await w.setProps({ docId: 'd2' })
    await flushPromises() // 只冲微任务/渲染，不推进 150ms 定时器
    // 修复前：防抖窗口内仍显示旧文档「5 字」；修复后即刻重算
    expect(w.get('.word-count').text()).toBe('9 字')
  })
})
