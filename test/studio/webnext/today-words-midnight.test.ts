/**
 * 今日字数跨零点重记基线（store 面，node 环境）。
 * （原 r29-fe-e3-e6-stores 的 E-6 节，按行为单拆。）
 *
 * E-6（二十九轮）：ensureBaseline 比对响应 date 与当前本地日期——慢响应跨零点时响应
 * 里的 delta/baseline 属昨日，跨日须以当前树字数重记今日基线再取新日 delta；同日响应
 * 走原路径（基线直接采用）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  getWordsDiary: vi.fn(),
  postBaseline: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getWordsDiary: mocks.getWordsDiary,
  postBaseline: mocks.postBaseline,
}))

import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useWordsStore } from '../../../src/studio/web-next/src/stores/words'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

/** 与 words store localToday 同格式的本地日期 */
function dateStr(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

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

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.postBaseline.mockResolvedValue({ ok: true })
})

describe('E-6: 今日字数跨零点重记基线', () => {
  it('响应 date 属昨日（慢响应跨日）→ 以当前已写重记基线并重取新日 delta', async () => {
    const tree = useTreeStore()
    const node = makeNode('d1')
    node.wordCount = 300
    tree.raw = [node] // totalWords = 300
    tree.ownerBook = '书A' // R35-10：属主对齐（重记基线的字数口径属本测试书）
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
