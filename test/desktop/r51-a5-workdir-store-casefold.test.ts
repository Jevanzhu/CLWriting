/**
 * R51-A-5（五十一轮）回归：workdir-store 路径等值判定收编 samePath。
 *
 * win（NTFS）与 mac（默认 APFS）卷大小写不敏感，路径经启动器/手工输入可 case-only
 * 漂移——parseStore 判重 / setCurrent 三处等值判定（新旧 current、recent 剔除、判重）
 * 此前用字符串全等，同库异形路径劈成两条记录（展示面污染）。修复：单源 samePath
 * （darwin/win32 折叠、linux 全等）。current 落盘仍保留调用方原样字串（不归一改写）。
 */
import { describe, it, expect } from 'vitest'
import { emptyStore, parseStore, setCurrent } from '../../src/desktop/workdir-store.js'
import { samePath } from '../../src/fs/user-data-path.js'

/** 本平台是否折叠大小写（与 samePath 内部 foldFs 同判） */
const FOLDS = process.platform === 'darwin' || process.platform === 'win32'
const LIB = '/books/MyLib'

describe('R51-A-5: setCurrent 等值判定', () => {
  it('case-only 漂移的同库：切回不产生 recent 双条目（折叠平台）', () => {
    if (!FOLDS) return // linux 大小写敏感卷：异形即异库，走下方精确用例
    const s1 = setCurrent(emptyStore(), LIB)
    expect(s1.current).toBe(LIB)
    // case-only 漂移形态切回：旧 current 被视为同库 → 不入 recent
    const s2 = setCurrent(s1, LIB.toLowerCase())
    expect(s2.current).toBe(LIB.toLowerCase()) // current 保留调用方原样字串
    expect(s2.recent).toEqual([]) // 修复前：旧 current 入 recent，与后续同库异形并存
  })

  it('recent 判重：case-only 异形路径不再劈成两条（折叠平台）', () => {
    if (!FOLDS) return
    const store = {
      ...emptyStore(),
      current: '/books/其他库',
      recent: [
        { path: LIB, label: 'MyLib' },
        { path: LIB.toLowerCase(), label: 'mylib（异形重复）' },
      ],
    }
    const s = setCurrent(store, '/books/其他库')
    // oldCurrent=其他库 同值不入 recent；候选里 case-only 双条目判重收一
    expect(s.recent.map((r) => r.path)).toEqual([LIB])
    expect(s.current).toBe('/books/其他库')
  })

  it('linux（大小写敏感卷）：全等语义不变，case-only 视为异库', () => {
    if (FOLDS) return
    const s = setCurrent(setCurrent(emptyStore(), LIB), LIB.toLowerCase())
    expect(s.current).toBe(LIB.toLowerCase())
    expect(s.recent.map((r) => r.path)).toEqual([LIB]) // 异库入 recent（全等口径）
  })
})

describe('R51-A-5: parseStore 判重等值', () => {
  it('case-only 漂移的重复条目去重（折叠平台）；linux 全等保留', () => {
    const raw = JSON.stringify({
      current: LIB,
      recent: [
        { path: LIB, label: 'A' },
        { path: LIB.toLowerCase(), label: 'B' },
      ],
    })
    const s = parseStore(raw)
    if (FOLDS) {
      expect(s.recent).toEqual([{ path: LIB, label: 'A' }]) // 修复前双显
    } else {
      expect(s.recent).toHaveLength(2) // linux：合法异名共存
    }
    expect(samePath(s.recent[0]!.path, LIB)).toBe(true)
  })
})
