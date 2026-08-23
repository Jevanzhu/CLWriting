/**
 * E-8（第五十三轮）有界补齐：check store 代表性用例——操作代守卫（切文档后旧
 * run 结果不落）与 clear 全量复位（含 R-1：clear 推代后 loading 不卡死）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const checkMock = vi.hoisted(() => vi.fn())
vi.mock('../../../src/studio/web-next/src/api/check', () => ({
  runCheck: checkMock,
  markFalsePositive: vi.fn(),
}))

import { useCheckStore } from '../../../src/studio/web-next/src/stores/check'

const REPORT = {
  sections: [{ name: 'S1', items: [{ checkId: 'r1', level: 'red' as const, message: 'm' }] }],
}

beforeEach(() => {
  setActivePinia(createPinia())
  checkMock.mockReset()
})

describe('E-8 · check store 代数守卫与 clear 复位', () => {
  it('在途 run 期间 clear（切文档）→ 迟到的旧结果不落新文档', async () => {
    let resolveRun: (v: unknown) => void = () => {}
    checkMock.mockReturnValue(new Promise((r) => (resolveRun = r)))
    const s = useCheckStore()
    const p = s.run('book', 'doc_A')
    s.clear() // 机检在途时切文档
    resolveRun({ ok: true, hasRed: true, report: REPORT })
    await p
    expect(s.report).toBeNull() // A 文档结果不张冠李戴到新文档
    expect(s.lastDocId).toBeNull()
    expect(s.hasRed).toBe(false)
  })

  it('clear 推代后 loading 复位不卡死，可再次触发 run（R-1 回归）', async () => {
    let resolveRun: (v: unknown) => void = () => {}
    checkMock.mockReturnValue(new Promise((r) => (resolveRun = r)))
    const s = useCheckStore()
    const p1 = s.run('book', 'doc_A')
    expect(s.loading).toBe(true)
    s.clear()
    expect(s.loading).toBe(false) // 不等在途 run 的 finally，直接复位
    resolveRun({ ok: true, hasRed: false, report: REPORT })
    await p1
    // 再触发一次 run 正常走完
    checkMock.mockResolvedValue({ ok: true, hasRed: true, report: REPORT })
    await s.run('book', 'doc_B')
    expect(s.loading).toBe(false)
    expect(s.lastDocId).toBe('doc_B')
    expect(s.hasRed).toBe(true)
  })

  it('clear 全量复位：flagging/flagged/flagError 一并清（跨文档灰显不残留）', async () => {
    const s = useCheckStore()
    checkMock.mockResolvedValue({ ok: true, hasRed: true, report: REPORT })
    await s.run('book', 'doc_A')
    s.flagging = 'r1'
    s.flagError = '上次的错误'
    s.clear()
    expect(s.flagging).toBeNull()
    expect(s.flagged.size).toBe(0)
    expect(s.flagError).toBeNull()
    expect(s.report).toBeNull()
    expect(s.error).toBeNull()
  })
})
