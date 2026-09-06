// @vitest-environment happy-dom
/**
 * R51-H-4（五十一轮）回归：clearFalsePositiveMarks 前缀取 fpBookPrefix 单源（R50-D2-1 口径）。
 *
 * 原实现在清理处内联重拼 `clw-fp:<书>\u0000`，与 fpKey/fpBookPrefix 构成双源——键格式
 * 再演化（如分隔符调整）时此处必成漏改点。行为不变，测试钉住单源语义契约：
 * 只清「书名 + \\u0000 边界」精确前缀，不长书名误吞、不连带旧式冒号键（R49-27 口径）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// happy-dom localStorage 在 vitest 集成下缺 clear()，提供 Map-backed 替身（prefs-store.test 同款）
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

import { clearFalsePositiveMarks, fpBookPrefix } from '../../../src/studio/web-next/src/stores/check'

beforeEach(() => {
  localStorageMock.clear()
})

describe('R51-H-4: clearFalsePositiveMarks 与 fpBookPrefix 单源', () => {
  it('清该书全部误报键；书名边界（\\u0000）精确匹配——更长书名键不误吞', () => {
    localStorageMock.setItem(fpBookPrefix('书A') + 'd1', '["c1"]')
    localStorageMock.setItem(fpBookPrefix('书A') + 'd2', '["c2"]')
    localStorageMock.setItem(fpBookPrefix('书AB') + 'd1', '["c9"]')

    clearFalsePositiveMarks('书A')

    expect(localStorageMock.getItem(fpBookPrefix('书A') + 'd1')).toBeNull()
    expect(localStorageMock.getItem(fpBookPrefix('书A') + 'd2')).toBeNull()
    expect(localStorageMock.getItem(fpBookPrefix('书AB') + 'd1')).toBe('["c9"]')
  })

  it('书名含冒号：不连带命中他书键（R49-27 改 \\u0000 分隔符的原始动机）', () => {
    localStorageMock.setItem(fpBookPrefix('书A') + 'd1', '["c1"]')
    localStorageMock.setItem(fpBookPrefix('书A:B') + 'd1', '["c8"]')
    // 旧式冒号键（存量不迁移、自然失配即弃）——清理不得顺手吞掉
    localStorageMock.setItem('clw-fp:书A:d1', '["old"]')

    clearFalsePositiveMarks('书A')

    expect(localStorageMock.getItem(fpBookPrefix('书A') + 'd1')).toBeNull()
    expect(localStorageMock.getItem(fpBookPrefix('书A:B') + 'd1')).toBe('["c8"]')
    expect(localStorageMock.getItem('clw-fp:书A:d1')).toBe('["old"]')
  })
})
