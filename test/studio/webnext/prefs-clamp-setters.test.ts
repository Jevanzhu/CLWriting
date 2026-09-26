// @vitest-environment happy-dom
/**
 * R0911（2026-09-11 专项精简批 · prefs 表驱动件）锚测试。R0916-7-P3-25 起 prefs 对外
 * 收为泛型 get/set（键由 PREF_ROWS 经 PrefValueMap 推导）：31 个同构 setter 收进
 * SETTERS 键控映射经 set(key, value) 出口，pageWidth/autosaveInterval 两 bookOnly
 * 双分支经 set 第三参，checkRepeatThreshold 浮点截断收编进行 set（round2）。
 *
 * 本文件钉「表抄录零失手」：全部 clamp 型键逐个五点钉界（下界-1 / 下界 / 中值 /
 * 上界 / 上界+1）+ 取整顺序（先 round 后 clamp）、浮点两位截断、trim、无上界
 * max(0, round)、bookOnly 双分支、防抖落盘 JSON 键名、泛型 set 函数引用传递可用。
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

/** clamp 型键钉界表：name 仅用于用例名，call/read 钉到泛型 set/get 的具体键（表抄录失手即红）。
 *  read 放宽至 number|undefined——机检五键读面为 number|undefined。 */
const CLAMP_ROWS: Array<{
  name: string
  call: (p: Prefs, v: number) => void
  read: (p: Prefs) => number | undefined
  min: number
  mid: number
  max: number
}> = [
  {
    name: 'snapDays 1-365',
    call: (p, v) => p.set('snapDays', v),
    read: (p) => p.get('snapDays'),
    min: 1,
    mid: 30,
    max: 365,
  },
  {
    name: 'snapCount 1-200',
    call: (p, v) => p.set('snapCount', v),
    read: (p) => p.get('snapCount'),
    min: 1,
    mid: 30,
    max: 200,
  },
  {
    name: 'defaultVolumeSize 5-500',
    call: (p, v) => p.set('defaultVolumeSize', v),
    read: (p) => p.get('defaultVolumeSize'),
    min: 5,
    mid: 50,
    max: 500,
  },
  {
    name: 'aiBatchSize 1-20',
    call: (p, v) => p.set('aiBatchSize', v),
    read: (p) => p.get('aiBatchSize'),
    min: 1,
    mid: 8,
    max: 20,
  },
  {
    name: 'callsPerChapter 1-50',
    call: (p, v) => p.set('callsPerChapter', v),
    read: (p) => p.get('callsPerChapter'),
    min: 1,
    mid: 8,
    max: 50,
  },
  {
    name: 'relationMineThreshold 1-20',
    call: (p, v) => p.set('relationMineThreshold', v),
    read: (p) => p.get('relationMineThreshold'),
    min: 1,
    mid: 3,
    max: 20,
  },
  {
    name: 'checkRepeatCharsThreshold 2-1000',
    call: (p, v) => p.set('checkRepeatCharsThreshold', v),
    read: (p) => p.get('checkRepeatCharsThreshold'),
    min: 2,
    mid: 200,
    max: 1000,
  },
  {
    name: 'checkMaxSentenceLen 10-500',
    call: (p, v) => p.set('checkMaxSentenceLen', v),
    read: (p) => p.get('checkMaxSentenceLen'),
    min: 10,
    mid: 60,
    max: 500,
  },
  {
    name: 'checkImageryThreshold 1-100',
    call: (p, v) => p.set('checkImageryThreshold', v),
    read: (p) => p.get('checkImageryThreshold'),
    min: 1,
    mid: 3,
    max: 100,
  },
  {
    name: 'checkWordCountTolerance 1-500',
    call: (p, v) => p.set('checkWordCountTolerance', v),
    read: (p) => p.get('checkWordCountTolerance'),
    min: 1,
    mid: 30,
    max: 500,
  },
  // clamp+apply 双职项一并钉界（uiFontSizeStep：行 set clamp + side apply）
  {
    name: 'uiFontSizeStep -1..2',
    call: (p, v) => p.set('uiFontSizeStep', v),
    read: (p) => p.get('uiFontSizeStep'),
    min: -1,
    mid: 1,
    max: 2,
  },
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
    p.set('snapDays', 0.4)
    expect(p.get('snapDays')).toBe(1)
    p.set('snapDays', 30.6)
    expect(p.get('snapDays')).toBe(31)
    p.set('checkRepeatCharsThreshold', 999.7)
    expect(p.get('checkRepeatCharsThreshold')).toBe(1000)
    p.set('defaultVolumeSize', 4.9)
    expect(p.get('defaultVolumeSize')).toBe(5)
    p.set('uiFontSizeStep', 1.6)
    expect(p.get('uiFontSizeStep')).toBe(2)
    p.set('uiFontSizeStep', -0.6)
    expect(p.get('uiFontSizeStep')).toBe(-1)
  })
})

describe('R0911 prefs 表驱动件：无上界 max(0, round)（表驱动，max 缺省退化）', () => {
  it('setDefaultTargetWords / setDefaultChapterTargetWords：负数归 0、小数取整、无上界不封顶', () => {
    const p = usePrefsStore()
    p.set('defaultTargetWords', -3)
    expect(p.get('defaultTargetWords')).toBe(0)
    p.set('defaultTargetWords', 0)
    expect(p.get('defaultTargetWords')).toBe(0)
    p.set('defaultTargetWords', 1234.4)
    expect(p.get('defaultTargetWords')).toBe(1234)
    p.set('defaultTargetWords', 1234.5)
    expect(p.get('defaultTargetWords')).toBe(1235)
    p.set('defaultTargetWords', 9_999_999)
    expect(p.get('defaultTargetWords')).toBe(9_999_999)
    p.set('defaultChapterTargetWords', -1)
    expect(p.get('defaultChapterTargetWords')).toBe(0)
    p.set('defaultChapterTargetWords', 3000.4)
    expect(p.get('defaultChapterTargetWords')).toBe(3000)
    p.set('defaultChapterTargetWords', 2_000_000)
    expect(p.get('defaultChapterTargetWords')).toBe(2_000_000)
  })
})

describe('R0911 prefs 表驱动件：浮点截断（行 set.round2 收编，R0916-7-P3-25）', () => {
  it('setCheckRepeatThreshold：clamp (0,1] + 两位小数 round 截断', () => {
    const p = usePrefsStore()
    p.set('checkRepeatThreshold', 0.12345)
    expect(p.get('checkRepeatThreshold')).toBe(0.12)
    p.set('checkRepeatThreshold', 0.126)
    expect(p.get('checkRepeatThreshold')).toBe(0.13)
    p.set('checkRepeatThreshold', 0.994)
    expect(p.get('checkRepeatThreshold')).toBe(0.99)
    p.set('checkRepeatThreshold', 0.996)
    expect(p.get('checkRepeatThreshold')).toBe(1)
    p.set('checkRepeatThreshold', 0)
    expect(p.get('checkRepeatThreshold')).toBe(0.01)
    p.set('checkRepeatThreshold', 2)
    expect(p.get('checkRepeatThreshold')).toBe(1)
    p.set('checkRepeatThreshold', 0.55)
    expect(p.get('checkRepeatThreshold')).toBe(0.55)
  })

  it('函数引用传递可用：泛型 set 裸调（不依赖 this）仍按键写 ref', () => {
    const p = usePrefsStore()
    const fn: (key: 'checkRepeatThreshold', v: number) => void = p.set
    fn('checkRepeatThreshold', 0.42)
    expect(p.get('checkRepeatThreshold')).toBe(0.42)
    const fn2: (key: 'checkImageryThreshold', v: number) => void = p.set
    fn2('checkImageryThreshold', 3)
    expect(p.get('checkImageryThreshold')).toBe(3)
  })
})

describe('R0911 prefs 表驱动件：trim 与纯赋值项', () => {
  it('strSetter{trim}：setDefaultGenre / setRagProvider 首尾去空', () => {
    const p = usePrefsStore()
    p.set('defaultGenre', '  都市  ')
    expect(p.get('defaultGenre')).toBe('都市')
    p.set('ragProvider', ' rag-a ')
    expect(p.get('ragProvider')).toBe('rag-a')
  })

  it('boolSetter / 联合枚举 setter：纯赋值不动值', () => {
    const p = usePrefsStore()
    p.set('chatEnabled', true)
    expect(p.get('chatEnabled')).toBe(true)
    p.set('defaultShortStrict', true)
    expect(p.get('defaultShortStrict')).toBe(true)
    p.set('autoConfirmOutline', true)
    expect(p.get('autoConfirmOutline')).toBe(true)
    p.set('relationAutoMine', true)
    expect(p.get('relationAutoMine')).toBe(true)
    p.set('ragEnabled', true)
    expect(p.get('ragEnabled')).toBe(true)
    p.set('shelfView', 'list')
    expect(p.get('shelfView')).toBe('list')
    p.set('styleInjection', 'heavy')
    expect(p.get('styleInjection')).toBe('heavy')
  })
})

describe('R0911 prefs 表驱动件：persist 键名锚（防抖落盘 JSON 键）', () => {
  it('表驱动 setter 合并一次 PUT，键名与 ref 名的异名映射（snapMaxDays/snapMaxCount/autoBatchSize）不丢', async () => {
    const p = usePrefsStore()
    p.set('snapDays', 30)
    p.set('snapCount', 50)
    p.set('aiBatchSize', 6)
    p.set('checkRepeatCharsThreshold', 200)
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

describe('R0911 prefs 表驱动件：bookOnly 双分支特例（泛型 set 第三参）', () => {
  it('setPageWidth：true 只写书级覆盖（全局不动、零全局 PUT）；false 写全局 + 清书级 + PUT', async () => {
    const p = usePrefsStore()
    p.set('pageWidth', 800, true)
    expect(p.bookPageWidth).toBe(800)
    expect(p.get('pageWidth')).toBe(1020) // 全局默认不动
    expect(p.effectivePageWidth).toBe(800) // 书级 > 全局
    p.set('pageWidth', 900, false)
    expect(p.get('pageWidth')).toBe(900)
    expect(p.bookPageWidth).toBeNull() // 覆盖清除
    expect(p.effectivePageWidth).toBe(900)
    await vi.advanceTimersByTimeAsync(600)
    expect(putGlobalPrefsMock).toHaveBeenCalledTimes(1) // 仅 false 分支落全局
    expect(putGlobalPrefsMock).toHaveBeenCalledWith(expect.objectContaining({ pageWidth: 900 }), 0)
  })

  it('setAutosaveInterval：同规则（true 零全局 PUT；false 写全局 + 清书级 + PUT）', async () => {
    const p = usePrefsStore()
    p.set('autosaveInterval', 10, true)
    expect(p.bookAutosaveInterval).toBe(10)
    expect(p.get('autosaveInterval')).toBe(30)
    expect(p.effectiveAutosaveInterval).toBe(10)
    p.set('autosaveInterval', 45, false)
    expect(p.get('autosaveInterval')).toBe(45)
    expect(p.bookAutosaveInterval).toBeNull()
    expect(p.effectiveAutosaveInterval).toBe(45)
    await vi.advanceTimersByTimeAsync(600)
    expect(putGlobalPrefsMock).toHaveBeenCalledTimes(1)
    expect(putGlobalPrefsMock).toHaveBeenCalledWith(expect.objectContaining({ autosaveInterval: 45 }), 0)
  })
})
