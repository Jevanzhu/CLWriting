// @vitest-environment happy-dom
/**
 * R60-D-3（六十轮）回归：clearFalsePositiveMarksForDoc 删键由前缀匹配改精确归属。
 *
 * 原实现 `startsWith(fpKey(book, docId))` 前缀匹配删键——当一个 docId 恰为另一
 * docId 的字符串前缀时（如 `a.md` 与 `a.md2`，键形 `clw-fp:<书>\u0000a.md` 正是
 * `clw-fp:<书>\u0000a.md2` 的前缀），删 A 章会连带误删兄弟 B 章的灰显键（机检
 * 误报标记 best-effort 态丢失、误报按钮复禁用）。修复：解析键的书前缀边界
 * （fpBookPrefix 带 \u0000 分隔）后取 docId 段精确等值比较——只删属于该 doc 的键，
 * 兄弟前缀键存活。行为其余不变（清不到时静默）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// happy-dom localStorage 在 vitest 集成下缺 clear()，提供 Map-backed 替身（r51-h4 同款）
function createLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
}
const localStorageMock = createLocalStorage()
vi.stubGlobal('localStorage', localStorageMock)

import { clearFalsePositiveMarksForDoc, fpBookPrefix } from '../../../src/studio/web-next/src/stores/check'

beforeEach(() => {
  localStorageMock.clear()
})

describe('R60-D-3: clearFalsePositiveMarksForDoc 精确归属删键', () => {
  it('docId 互为字符串前缀（a.md / a.md2）：清 a.md → a.md 全清、a.md2 存活', () => {
    localStorageMock.setItem(fpBookPrefix('书A') + 'a.md', '["ck1"]')
    localStorageMock.setItem(fpBookPrefix('书A') + 'a.md2', '["ck2"]')
    localStorageMock.setItem(fpBookPrefix('书A') + 'b.md', '["ck3"]')

    clearFalsePositiveMarksForDoc('书A', 'a.md')

    expect(localStorageMock.getItem(fpBookPrefix('书A') + 'a.md')).toBeNull() // 目标全清
    expect(localStorageMock.getItem(fpBookPrefix('书A') + 'a.md2')).toBe('["ck2"]') // 前缀兄弟存活
    expect(localStorageMock.getItem(fpBookPrefix('书A') + 'b.md')).toBe('["ck3"]') // 无关章不动
  })

  it('反向清除（清 a.md2）：a.md 不受牵连', () => {
    localStorageMock.setItem(fpBookPrefix('书A') + 'a.md', '["ck1"]')
    localStorageMock.setItem(fpBookPrefix('书A') + 'a.md2', '["ck2"]')

    clearFalsePositiveMarksForDoc('书A', 'a.md2')

    expect(localStorageMock.getItem(fpBookPrefix('书A') + 'a.md2')).toBeNull()
    expect(localStorageMock.getItem(fpBookPrefix('书A') + 'a.md')).toBe('["ck1"]')
  })

  it('书名前缀边界（\\u0000）仍精确：他书同名 docId 的键不动', () => {
    localStorageMock.setItem(fpBookPrefix('书A') + 'a.md', '["ck1"]')
    localStorageMock.setItem(fpBookPrefix('书AB') + 'a.md', '["ck9"]')

    clearFalsePositiveMarksForDoc('书A', 'a.md')

    expect(localStorageMock.getItem(fpBookPrefix('书A') + 'a.md')).toBeNull()
    expect(localStorageMock.getItem(fpBookPrefix('书AB') + 'a.md')).toBe('["ck9"]')
  })

  it('清不到时静默（无匹配键不抛错）——既有 best-effort 口径不变', () => {
    expect(() => clearFalsePositiveMarksForDoc('书C', 'none.md')).not.toThrow()
  })
})
