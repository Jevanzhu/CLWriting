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
  // R35-10：ensureBaseline 取树总字数前过属主校验（ownerBook === 目标书）——本文件
  // 用例均为 bookA 口径，属主钉 bookA；属主不匹配分支由 r35-tree-load-fail-baseline 专测
  useTreeStore: () => ({ totalWords: 100, ownerBook: 'bookA' }),
}))

import { getWordsDiary, postBaseline } from '../../../src/studio/web-next/src/api/books'
import { useWordsStore } from '../../../src/studio/web-next/src/stores/words'

const diaryMock = getWordsDiary as ReturnType<typeof vi.fn>
const postMock = postBaseline as ReturnType<typeof vi.fn>

// E-6（二十九轮）：ensureBaseline 会比对响应 date 与「今天」（跨日重取基线）——mock
// 统一改用动态今天保证走正常分支；跨日分支由 r29-fe 回归专测
const TODAY = (() => {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
})()

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('words: ensureBaseline 基线', () => {
  it('diary 带 baseline → 直接采用，不 post', async () => {
    diaryMock.mockResolvedValueOnce({ date: TODAY, delta: 12, baseline: 80 })
    const s = useWordsStore()
    await s.ensureBaseline('bookA')
    expect(s.baseline).toBe(80)
    expect(s.todayDelta).toBe(12)
    expect(s.ready).toBe(true)
    expect(postMock).not.toHaveBeenCalled()
  })

  it('diary 无 baseline → 记当前已写为基线并 POST 落盘', async () => {
    diaryMock.mockResolvedValueOnce({ date: TODAY, delta: null, baseline: null })
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
    diaryMock.mockResolvedValueOnce({ date: TODAY, delta: null, baseline: null })
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
    diaryMock.mockResolvedValueOnce({ date: TODAY, delta: 3, baseline: 50 })
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

describe('words: R65-49（E-1）切书清态 + 失败降级清 delta', () => {
  it('切书入口清态：B 书响应在途时旧书的 delta/baseline 不再参与今日字数（不互减）', async () => {
    // A 书先成功载入（delta=12, baseline=80）
    diaryMock.mockResolvedValueOnce({ date: TODAY, delta: 12, baseline: 80 })
    const s = useWordsStore()
    await s.ensureBaseline('bookA')
    expect(s.todayWords).toBe(12)

    // 切 B：B 的 diary 挂起——入口清态须同步生效（todayWords 回 0，而非拿 A 的 delta）
    let releaseB!: (v: { date: string; delta: number | null; baseline: number | null }) => void
    diaryMock.mockImplementationOnce(
      () => new Promise((r) => { releaseB = r }),
    )
    const pB = s.ensureBaseline('bookB')
    expect(s.todayDelta).toBe(null)
    expect(s.baseline).toBe(null)
    expect(s.ready).toBe(false)
    expect(s.todayWords).toBe(0)

    releaseB({ date: TODAY, delta: 5, baseline: 60 })
    await pB
    expect(s.todayDelta).toBe(5)
    expect(s.todayWords).toBe(5)

    // 同书 save 刷新（B 重调）不清态：刷新在途仍显示上次结果，不闪 0
    diaryMock.mockImplementationOnce(
      () => new Promise((r) => { releaseB = r }),
    )
    const pB2 = s.ensureBaseline('bookB')
    expect(s.todayWords).toBe(5)
    releaseB({ date: TODAY, delta: 9, baseline: 60 })
    await pB2
    expect(s.todayWords).toBe(9)
  })

  it('同书刷新失败（diary GET 报错）→ delta 一并清空走 baseline 回退，不残留旧 delta', async () => {
    diaryMock.mockResolvedValueOnce({ date: TODAY, delta: 12, baseline: 80 })
    const s = useWordsStore()
    await s.ensureBaseline('bookA')
    expect(s.todayDelta).toBe(12)

    diaryMock.mockRejectedValueOnce(new Error('net down'))
    await s.ensureBaseline('bookA')
    // 修复前：todayDelta=12 残留且优先级高于 baseline 回退 → 今日字数仍是 12（旧值）
    expect(s.todayDelta).toBe(null)
    expect(s.date).toBe(null)
    expect(s.baseline).toBe(100) // 降级：记当前已写为基线 → 今日 0
    expect(s.todayWords).toBe(0)
  })
})
