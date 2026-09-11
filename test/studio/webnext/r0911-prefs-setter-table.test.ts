// @vitest-environment happy-dom
/**
 * R0911（2026-09-11 专项精简批 · prefs 表驱动件）锚测试：prefs.ts 33 个同构 setter
 * 中 21 个收拢为工厂产出（numSetter/boolSetter/strSetter/setter），12 个异形手写保留
 * （applyTheme/apply/applyCompact 三副作用族、setUiFontSizeStep、setPageWidth/
 * setAutosaveInterval 两 bookOnly 双分支、setCheckRepeatThreshold 浮点截断）。
 *
 * 本文件钉「表抄录零失手」：全部 clamp 型 setter 逐个五点钉界（下界-1 / 下界 / 中值 /
 * 上界 / 上界+1）+ 取整顺序（先 round 后 clamp）、浮点两位截断、trim、无上界
 * max(0, round)、bookOnly 双分支、防抖落盘 JSON 键名、函数引用传递可用。
 * 语义正本（应用/迁移/守卫/409）见 prefs-store.test.ts 等既有文件，不在此重复。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getGlobalPrefs: vi.fn(),
  putGlobalPrefs: vi.fn(),
}))

import { getGlobalPrefs, putGlobalPrefs } from '../../../src/studio/web-next/src/api/prefs'
import { usePrefsStore } from '../../../src/studio/web-next/src/stores/prefs'

const getGlobalPrefsMock = getGlobalPrefs as ReturnType<typeof vi.fn>
const putGlobalPrefsMock = putGlobalPrefs as ReturnType<typeof vi.fn>

type Prefs = ReturnType<typeof usePrefsStore>

/** clamp 型 setter 钉界表：name 仅用于用例名，call/read 钉到具体 setter（表抄录失手即红）。
 *  read 放宽至 number|undefined——机检四键 ref 为 Ref<number|undefined>。 */
const CLAMP_ROWS: Array<{
  name: string
  call: (p: Prefs, v: number) => void
  read: (p: Prefs) => number | undefined
  min: number
  mid: number
  max: number
}> = [
  { name: 'setSnapDays snapDays 1-365', call: (p, v) => p.setSnapDays(v), read: (p) => p.snapDays, min: 1, mid: 30, max: 365 },
  { name: 'setSnapCount snapCount 1-200', call: (p, v) => p.setSnapCount(v), read: (p) => p.snapCount, min: 1, mid: 30, max: 200 },
  { name: 'setDefaultVolumeSize defaultVolumeSize 5-500', call: (p, v) => p.setDefaultVolumeSize(v), read: (p) => p.defaultVolumeSize, min: 5, mid: 50, max: 500 },
  { name: 'setAiBatchSize aiBatchSize 1-20', call: (p, v) => p.setAiBatchSize(v), read: (p) => p.aiBatchSize, min: 1, mid: 8, max: 20 },
  { name: 'setCallsPerChapter callsPerChapter 1-50', call: (p, v) => p.setCallsPerChapter(v), read: (p) => p.callsPerChapter, min: 1, mid: 8, max: 50 },
  { name: 'setRelationMineThreshold relationMineThreshold 1-20', call: (p, v) => p.setRelationMineThreshold(v), read: (p) => p.relationMineThreshold, min: 1, mid: 3, max: 20 },
  { name: 'setCheckRepeatCharsThreshold 2-1000', call: (p, v) => p.setCheckRepeatCharsThreshold(v), read: (p) => p.checkRepeatCharsThreshold, min: 2, mid: 200, max: 1000 },
  { name: 'setCheckMaxSentenceLen 10-500', call: (p, v) => p.setCheckMaxSentenceLen(v), read: (p) => p.checkMaxSentenceLen, min: 10, mid: 60, max: 500 },
  { name: 'setCheckImageryThreshold 1-100', call: (p, v) => p.setCheckImageryThreshold(v), read: (p) => p.checkImageryThreshold, min: 1, mid: 3, max: 100 },
  { name: 'setCheckWordCountTolerance 1-500', call: (p, v) => p.setCheckWordCountTolerance(v), read: (p) => p.checkWordCountTolerance, min: 1, mid: 30, max: 500 },
  // 手写保留的 clamp 项一并钉界（setUiFontSizeStep：clamp+apply 双职）
  { name: 'setUiFontSizeStep uiFontSizeStep -1..2（手写）', call: (p, v) => p.setUiFontSizeStep(v), read: (p) => p.uiFontSizeStep, min: -1, mid: 1, max: 2 },
]

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  getGlobalPrefsMock.mockReset()
  putGlobalPrefsMock.mockReset()
  getGlobalPrefsMock.mockResolvedValue({ prefs: {}, revision: 0 })
  putGlobalPrefsMock.mockResolvedValue({ ok: true as const, revision: 1 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('R0911 prefs 表驱动件：clamp 型 setter 五点钉界', () => {
  for (const row of CLAMP_ROWS) {
    it(`${row.name}：${row.min - 1}→${row.min} / ${row.min}→${row.min} / ${row.mid}→${row.mid} / ${row.max}→${row.max} / ${row.max + 1}→${row.max}`, () => {
      const p = usePrefsStore()
      const points: Array<[number, number]> = [
        [row.min - 1, row.min],
        [row.min, row.min],
        [row.mid, row.mid],
        [row.max, row.max],
        [row.max + 1, row.max],
      ]
      for (const [input, expected] of points) {
        row.call(p, input)
        expect(row.read(p), `input ${input}`).toBe(expected)
      }
    })
  }

  it('取整顺序：先 round 后 clamp（0.4 → 0 → clamp 下界；999.7 → 1000 → clamp 上界）', () => {
    const p = usePrefsStore()
    p.setSnapDays(0.4)
    expect(p.snapDays).toBe(1)
    p.setSnapDays(30.6)
    expect(p.snapDays).toBe(31)
    p.setCheckRepeatCharsThreshold(999.7)
    expect(p.checkRepeatCharsThreshold).toBe(1000)
    p.setDefaultVolumeSize(4.9)
    expect(p.defaultVolumeSize).toBe(5)
    p.setUiFontSizeStep(1.6)
    expect(p.uiFontSizeStep).toBe(2)
    p.setUiFontSizeStep(-0.6)
    expect(p.uiFontSizeStep).toBe(-1)
  })
})

describe('R0911 prefs 表驱动件：无上界 max(0, round)（表驱动，max 缺省退化）', () => {
  it('setDefaultTargetWords / setDefaultChapterTargetWords：负数归 0、小数取整、无上界不封顶', () => {
    const p = usePrefsStore()
    p.setDefaultTargetWords(-3)
    expect(p.defaultTargetWords).toBe(0)
    p.setDefaultTargetWords(0)
    expect(p.defaultTargetWords).toBe(0)
    p.setDefaultTargetWords(1234.4)
    expect(p.defaultTargetWords).toBe(1234)
    p.setDefaultTargetWords(1234.5)
    expect(p.defaultTargetWords).toBe(1235)
    p.setDefaultTargetWords(9_999_999)
    expect(p.defaultTargetWords).toBe(9_999_999)
    p.setDefaultChapterTargetWords(-1)
    expect(p.defaultChapterTargetWords).toBe(0)
    p.setDefaultChapterTargetWords(3000.4)
    expect(p.defaultChapterTargetWords).toBe(3000)
    p.setDefaultChapterTargetWords(2_000_000)
    expect(p.defaultChapterTargetWords).toBe(2_000_000)
  })
})

describe('R0911 prefs 表驱动件：浮点截断（手写保留项）', () => {
  it('setCheckRepeatThreshold：clamp (0,1] + 两位小数 round 截断', () => {
    const p = usePrefsStore()
    p.setCheckRepeatThreshold(0.12345)
    expect(p.checkRepeatThreshold).toBe(0.12)
    p.setCheckRepeatThreshold(0.126)
    expect(p.checkRepeatThreshold).toBe(0.13)
    p.setCheckRepeatThreshold(0.994)
    expect(p.checkRepeatThreshold).toBe(0.99)
    p.setCheckRepeatThreshold(0.996)
    expect(p.checkRepeatThreshold).toBe(1)
    p.setCheckRepeatThreshold(0)
    expect(p.checkRepeatThreshold).toBe(0.01)
    p.setCheckRepeatThreshold(2)
    expect(p.checkRepeatThreshold).toBe(1)
    p.setCheckRepeatThreshold(0.55)
    expect(p.checkRepeatThreshold).toBe(0.55)
  })

  it('函数引用传递可用（SettingsAnalysis.vue 消费面）：解构后裸调仍写 ref', () => {
    const p = usePrefsStore()
    const fn: (v: number) => void = p.setCheckRepeatThreshold
    fn(0.42)
    expect(p.checkRepeatThreshold).toBe(0.42)
    const fn2: (v: number) => void = p.setCheckImageryThreshold
    fn2(3)
    expect(p.checkImageryThreshold).toBe(3)
  })
})

describe('R0911 prefs 表驱动件：trim 与纯赋值项', () => {
  it('strSetter{trim}：setDefaultGenre / setRagProvider 首尾去空', () => {
    const p = usePrefsStore()
    p.setDefaultGenre('  都市  ')
    expect(p.defaultGenre).toBe('都市')
    p.setRagProvider(' rag-a ')
    expect(p.ragProvider).toBe('rag-a')
  })

  it('boolSetter / 联合枚举 setter：纯赋值不动值', () => {
    const p = usePrefsStore()
    p.setChatEnabled(true)
    expect(p.chatEnabled).toBe(true)
    p.setDefaultShortStrict(true)
    expect(p.defaultShortStrict).toBe(true)
    p.setAutoConfirmOutline(true)
    expect(p.autoConfirmOutline).toBe(true)
    p.setRelationAutoMine(true)
    expect(p.relationAutoMine).toBe(true)
    p.setRagEnabled(true)
    expect(p.ragEnabled).toBe(true)
    p.setShelfView('list')
    expect(p.shelfView).toBe('list')
    p.setStyleInjection('heavy')
    expect(p.styleInjection).toBe('heavy')
  })
})

describe('R0911 prefs 表驱动件：persist 键名锚（防抖落盘 JSON 键）', () => {
  it('表驱动 setter 合并一次 PUT，键名与 ref 名的异名映射（snapMaxDays/snapMaxCount/autoBatchSize）不丢', async () => {
    const p = usePrefsStore()
    p.setSnapDays(30)
    p.setSnapCount(50)
    p.setAiBatchSize(6)
    p.setCheckRepeatCharsThreshold(200)
    expect(putGlobalPrefsMock).not.toHaveBeenCalled() // 未到 500ms 防抖
    await vi.advanceTimersByTimeAsync(600)
    expect(putGlobalPrefsMock).toHaveBeenCalledTimes(1)
    expect(putGlobalPrefsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        snapMaxDays: 30,
        snapMaxCount: 50,
        autoBatchSize: 6,
        checkRepeatCharsThreshold: 200,
      }),
      0,
    )
  })
})

describe('R0911 prefs 表驱动件：bookOnly 双分支特例（手写保留项）', () => {
  it('setPageWidth：true 只写书级覆盖（全局不动、零全局 PUT）；false 写全局 + 清书级 + PUT', async () => {
    const p = usePrefsStore()
    p.setPageWidth(800, true)
    expect(p.bookPageWidth).toBe(800)
    expect(p.pageWidth).toBe(1020) // 全局默认不动
    expect(p.effectivePageWidth).toBe(800) // 书级 > 全局
    p.setPageWidth(900, false)
    expect(p.pageWidth).toBe(900)
    expect(p.bookPageWidth).toBeNull() // 覆盖清除
    expect(p.effectivePageWidth).toBe(900)
    await vi.advanceTimersByTimeAsync(600)
    expect(putGlobalPrefsMock).toHaveBeenCalledTimes(1) // 仅 false 分支落全局
    expect(putGlobalPrefsMock).toHaveBeenCalledWith(expect.objectContaining({ pageWidth: 900 }), 0)
  })

  it('setAutosaveInterval：同规则（true 零全局 PUT；false 写全局 + 清书级 + PUT）', async () => {
    const p = usePrefsStore()
    p.setAutosaveInterval(10, true)
    expect(p.bookAutosaveInterval).toBe(10)
    expect(p.autosaveInterval).toBe(30)
    expect(p.effectiveAutosaveInterval).toBe(10)
    p.setAutosaveInterval(45, false)
    expect(p.autosaveInterval).toBe(45)
    expect(p.bookAutosaveInterval).toBeNull()
    expect(p.effectiveAutosaveInterval).toBe(45)
    await vi.advanceTimersByTimeAsync(600)
    expect(putGlobalPrefsMock).toHaveBeenCalledTimes(1)
    expect(putGlobalPrefsMock).toHaveBeenCalledWith(expect.objectContaining({ autosaveInterval: 45 }), 0)
  })
})
