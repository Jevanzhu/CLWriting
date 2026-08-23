/**
 * words store 单测（R-23 第十六轮）：ensureBaseline 的 postBaseline 前后代守卫——
 * 旧书在途 postBaseline settle 后不落盘/不污染新书基线（对齐同库其他 store 的 gen 模式）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getWordsDiary: vi.fn(),
  postBaseline: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/stores/tree', () => ({
  useTreeStore: () => ({ totalWords: 100 }),
}))

import { getWordsDiary, postBaseline } from '../../../src/studio/web-next/src/api/books'
import { useWordsStore } from '../../../src/studio/web-next/src/stores/words'

const diaryMock = getWordsDiary as ReturnType<typeof vi.fn>
const postMock = postBaseline as ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('words: ensureBaseline 基线', () => {
  it('diary 带 baseline → 直接采用，不 post', async () => {
    diaryMock.mockResolvedValueOnce({ date: '2026-08-23', delta: 12, baseline: 80 })
    const s = useWordsStore()
    await s.ensureBaseline('bookA')
    expect(s.baseline).toBe(80)
    expect(s.todayDelta).toBe(12)
    expect(s.ready).toBe(true)
    expect(postMock).not.toHaveBeenCalled()
  })

  it('diary 无 baseline → 记当前已写为基线并 POST 落盘', async () => {
    diaryMock.mockResolvedValueOnce({ date: '2026-08-23', delta: null, baseline: null })
    postMock.mockResolvedValueOnce({ ok: true })
    const s = useWordsStore()
    await s.ensureBaseline('bookA')
    expect(s.baseline).toBe(100)
    expect(postMock).toHaveBeenCalledWith('bookA', 100)
    expect(s.ready).toBe(true)
  })
})

describe('words: R-23 postBaseline 前后代守卫', () => {
  it('A 书在途 postBaseline 期间切 B 书 → A 迟到 settle 不污染 B 的基线/就绪态', async () => {
    // A 书：无基线 → 需 post（挂起留竞态窗口；posted 信号确认 A 已走到 postBaseline）
    diaryMock.mockResolvedValueOnce({ date: '2026-08-23', delta: null, baseline: null })
    let releaseA!: (v: { ok: boolean }) => void
    let markPosted!: () => void
    const posted = new Promise<void>((r) => { markPosted = r })
    postMock.mockImplementationOnce(() => {
      markPosted()
      return new Promise<{ ok: boolean }>((r) => { releaseA = r })
    })
    const s = useWordsStore()
    const pA = s.ensureBaseline('bookA')
    await posted // A 挂起在 postBaseline（此后再切书，代数才在 post 在途期间推进）

    // 切 B 书（reqGen 推进）：B 有基线，直接回填
    diaryMock.mockResolvedValueOnce({ date: '2026-08-23', delta: 3, baseline: 50 })
    await s.ensureBaseline('bookB')
    expect(s.baseline).toBe(50)
    expect(s.todayDelta).toBe(3)
    expect(s.ready).toBe(true)

    releaseA({ ok: true }) // A 的迟到 postBaseline settle
    await pA
    expect(s.baseline).toBe(50) // 未被 A 书的 totalWords 基线覆盖
    expect(s.todayDelta).toBe(3)
    expect(s.ready).toBe(true)
  })
})
