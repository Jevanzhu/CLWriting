/**
 * R0911（2026-09-11 专项精简批 · prefs 表驱动件）锚测试。R0916-7-P3-25 起 prefs 对外
 * 收为泛型 get/set（键由 PREF_ROWS 经 PrefValueMap 推导）：31 个同构 setter 收进
 * SETTERS 键控映射经 set(key, value) 出口，pageWidth/autosaveInterval 两 bookOnly
 * 双分支经 set 第三参，checkRepeatThreshold 浮点截断收编进行 win.clamp（round2）。
 *
 * 本文件钉「表抄录零失手」：全部 clamp 型键逐个五点钉界（下界-1 / 下界 / 中值 /
 * 上界 / 上界+1）+ 取整顺序（先 round 后 clamp）、浮点两位截断、trim、无上界
 * max(0, round)、bookOnly 双分支、防抖落盘 JSON 键名、泛型 set 函数引用传递可用；
 * 行窗口（win）守卫侧再逐键对拍（接受/拒绝 + 落 ref 是否取整）——守卫窗与夹取窗同源
 * 于行 win，两侧都有自己的行为锚才防得住单源被改坏。
 * 语义正本（应用/迁移/守卫/409）见 prefs-store.test.ts 等既有文件，不在此重复。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../../src/studio/web-next/src/api/prefs', () => ({
  getGlobalPrefs: vi.fn(),
  putGlobalPrefs: vi.fn(),
}))

import { getGlobalPrefs, putGlobalPrefs } from '../../../../src/studio/web-next/src/api/prefs'
import { usePrefsStore, type PrefKey } from '../../../../src/studio/web-next/src/stores/prefs'

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

// ── 行窗口（win）逐键对拍：守卫窗与夹取窗同源，读面口径（收/拒 + 是否取整）逐键钉死 ──
// 守卫既有「越界拒收 = 保持现值」的一半，也有「收下后取整与否」的一半——两半都从行 win
// 单源派生，本组用例是它的行为锚：任何一行的守卫窗被改动（越界值漏收/多收、取整改动）
// 即红。夹取窗一半已由上方五点钉界覆盖。

/** 接受侧：脏值落 ref 的结果（取整逐键不同是历史口径的显式部分） */
const GUARD_ACCEPT: Array<{ key: PrefKey; jsonKey: string; raw: number; applied: number }> = [
  { key: 'proseSize', jsonKey: 'proseSize', raw: 20.5, applied: 20.5 }, // 字号族不取整
  { key: 'proseLh', jsonKey: 'proseLh', raw: 1.75, applied: 1.75 },
  { key: 'uiFontSizeStep', jsonKey: 'uiFontSizeStep', raw: 2, applied: 2 }, // 上界含等于
  { key: 'uiFontSizeStep', jsonKey: 'uiFontSizeStep', raw: 1.6, applied: 1.6 }, // 守卫不取整
  { key: 'pageWidth', jsonKey: 'pageWidth', raw: 800.5, applied: 800.5 },
  { key: 'autosaveInterval', jsonKey: 'autosaveInterval', raw: 12.5, applied: 12.5 },
  { key: 'snapDays', jsonKey: 'snapMaxDays', raw: 30.4, applied: 30.4 }, // 守卫不取整（写入才取整）
  { key: 'snapCount', jsonKey: 'snapMaxCount', raw: 20.4, applied: 20.4 },
  { key: 'defaultVolumeSize', jsonKey: 'defaultVolumeSize', raw: 5, applied: 5 }, // 下界含等于
  { key: 'defaultVolumeSize', jsonKey: 'defaultVolumeSize', raw: 30.4, applied: 30 }, // 守卫取整
  { key: 'defaultTargetWords', jsonKey: 'defaultTargetWords', raw: 1000.6, applied: 1001 },
  { key: 'defaultChapterTargetWords', jsonKey: 'defaultChapterTargetWords', raw: 2000.4, applied: 2000 },
  { key: 'aiBatchSize', jsonKey: 'autoBatchSize', raw: 1, applied: 1 },
  { key: 'aiBatchSize', jsonKey: 'autoBatchSize', raw: 5.6, applied: 6 },
  { key: 'callsPerChapter', jsonKey: 'callsPerChapter', raw: 7.4, applied: 7 },
  { key: 'relationMineThreshold', jsonKey: 'relationMineThreshold', raw: 3.6, applied: 4 },
  { key: 'checkRepeatThreshold', jsonKey: 'checkRepeatThreshold', raw: 1, applied: 1 }, // 上界含等于
  { key: 'checkRepeatThreshold', jsonKey: 'checkRepeatThreshold', raw: 0.126, applied: 0.126 }, // 守卫不 round2
  { key: 'checkRepeatCharsThreshold', jsonKey: 'checkRepeatCharsThreshold', raw: 200.6, applied: 201 },
  { key: 'checkMaxSentenceLen', jsonKey: 'checkMaxSentenceLen', raw: 60.4, applied: 60 },
  { key: 'checkImageryThreshold', jsonKey: 'checkImageryThreshold', raw: 3.6, applied: 4 },
  { key: 'checkWordCountTolerance', jsonKey: 'checkWordCountTolerance', raw: 30.6, applied: 30.6 }, // 不取整
]

/** 拒绝侧：越界脏值不落 ref（保持 ref 初值 = 硬编码回落） */
const GUARD_REJECT: Array<{ key: PrefKey; jsonKey: string; raw: number; kept: number | undefined }> = [
  { key: 'proseSize', jsonKey: 'proseSize', raw: 0, kept: 17 },
  { key: 'proseLh', jsonKey: 'proseLh', raw: 0, kept: 1.5 },
  { key: 'uiFontSizeStep', jsonKey: 'uiFontSizeStep', raw: 3, kept: 0 }, // 越上界
  { key: 'uiFontSizeStep', jsonKey: 'uiFontSizeStep', raw: -2, kept: 0 }, // 越下界
  { key: 'pageWidth', jsonKey: 'pageWidth', raw: -5, kept: 1020 },
  { key: 'autosaveInterval', jsonKey: 'autosaveInterval', raw: 0, kept: 30 },
  { key: 'snapDays', jsonKey: 'snapMaxDays', raw: 0, kept: 14 }, // 脏值只收正数（写入才收紧到 1）
  { key: 'snapCount', jsonKey: 'snapMaxCount', raw: 0, kept: 30 },
  { key: 'defaultVolumeSize', jsonKey: 'defaultVolumeSize', raw: 4, kept: 50 }, // 4 < 夹取下界 5
  { key: 'defaultTargetWords', jsonKey: 'defaultTargetWords', raw: -5, kept: 0 },
  { key: 'defaultChapterTargetWords', jsonKey: 'defaultChapterTargetWords', raw: 0, kept: 0 },
  { key: 'aiBatchSize', jsonKey: 'autoBatchSize', raw: 0, kept: 8 },
  { key: 'callsPerChapter', jsonKey: 'callsPerChapter', raw: -1, kept: 8 },
  { key: 'relationMineThreshold', jsonKey: 'relationMineThreshold', raw: 0, kept: 3 },
  { key: 'checkRepeatThreshold', jsonKey: 'checkRepeatThreshold', raw: 1.5, kept: undefined }, // >1 全书判复读
  { key: 'checkRepeatCharsThreshold', jsonKey: 'checkRepeatCharsThreshold', raw: 0, kept: undefined },
  { key: 'checkMaxSentenceLen', jsonKey: 'checkMaxSentenceLen', raw: 0, kept: undefined },
  { key: 'checkImageryThreshold', jsonKey: 'checkImageryThreshold', raw: 0, kept: undefined },
  { key: 'checkWordCountTolerance', jsonKey: 'checkWordCountTolerance', raw: 0, kept: undefined },
]

describe('prefs 行窗口逐键对拍：守卫窗接受侧（收下即落 ref，取整逐键）', () => {
  for (const c of GUARD_ACCEPT) {
    it(`${c.jsonKey}=${c.raw} → ${c.applied}`, async () => {
      getGlobalPrefsMock.mockResolvedValue({ prefs: { [c.jsonKey]: c.raw }, revision: 0 })
      const p = usePrefsStore()
      await p.init()
      expect(p.get(c.key)).toBe(c.applied)
    })
  }
})

describe('prefs 行窗口逐键对拍：守卫窗拒绝侧（越界保持 ref 初值）', () => {
  for (const c of GUARD_REJECT) {
    it(`${c.jsonKey}=${c.raw} → 保持初值 ${String(c.kept)}`, async () => {
      getGlobalPrefsMock.mockResolvedValue({ prefs: { [c.jsonKey]: c.raw }, revision: 0 })
      const p = usePrefsStore()
      await p.init()
      expect(p.get(c.key)).toBe(c.kept)
    })
  }
})
