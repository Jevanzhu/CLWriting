/**
 * R71-5（七十一轮）回归：flagFalsePositive 在途时 run() 推代，flagging 不复位 →
 * 误报按钮永久禁用直到切文档。
 *
 * 修复双点：finally 归属制清除（if (flagging === checkId)，不依赖代数）+
 * run 成功回填前复位 flagging（双保险，对齐 R-1 修 loading 的思路）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const checkMock = vi.hoisted(() => vi.fn())
const flagMock = vi.hoisted(() => vi.fn())
vi.mock('../../../src/studio/web-next/src/api/check', () => ({
  runCheck: checkMock,
  markFalsePositive: flagMock,
}))

import { useCheckStore } from '../../../src/studio/web-next/src/stores/check'

const REPORT = {
  sections: [{ name: 'S1', items: [{ checkId: 'r1', level: 'red' as const, message: 'm' }] }],
}

beforeEach(() => {
  setActivePinia(createPinia())
  checkMock.mockReset()
  flagMock.mockReset()
})

describe('R71-5: flag 在途 + run 推代 → flagging 复位', () => {
  it('run 成功回填路径：迟到 flag 响应 settle 后 flagging 为 null（按钮可再触发）', async () => {
    // run 立即返回：flag 发起在 run 之前，run 推代发生在 flag 在途期间
    let resolveFlag!: (v: unknown) => void
    flagMock.mockReturnValue(new Promise((r) => (resolveFlag = r)))
    checkMock.mockResolvedValue({ ok: true, hasRed: true, report: REPORT })
    const s = useCheckStore()
    await s.run('book', 'doc_A') // 先有报告（flagged 空集）
    const p = s.flagFalsePositive('book', 'doc_A', 'r1') // flag 在途（flagging='r1'）
    expect(s.flagging).toBe('r1')
    const pRun = s.run('book', 'doc_A') // run 推代：flag 的 gen 快照已过期
    await pRun
    expect(s.flagging).toBeNull() // 修复点：新报告落位即在途标记态复位（修复前停留 'r1'）
    resolveFlag({ ok: true })
    await p
    expect(s.flagging).toBeNull() // finally 归属制清除兜底（迟到响应不再卡死）
  })

  it('run 回填前迟到 flag 响应先 settle：finally 归属制清除同样复位（不依赖代数）', async () => {
    let resolveFlag!: (v: unknown) => void
    flagMock.mockReturnValue(new Promise((r) => (resolveFlag = r)))
    checkMock
      .mockResolvedValueOnce({ ok: true, hasRed: true, report: REPORT }) // 第一笔 run 正常完成（报告前提）
      .mockReturnValue(new Promise(() => {})) // 第二笔 run 挂起（推代但未回填复位）
    const s = useCheckStore()
    await s.run('book', 'doc_A')
    const pFlag = s.flagFalsePositive('book', 'doc_A', 'r1') // flag 在途
    const pRun = s.run('book', 'doc_A') // 推代（run 挂起中，尚未走到回填复位）
    resolveFlag({ ok: true }) // 迟到 flag 响应先于 run 回填 settle
    await pFlag
    expect(s.flagging).toBeNull() // 修复点：finally 归属制清除（修复前查代制永不清）
  })

  it('flagging 复位后 flagFalsePositive 可再发起（误报按钮不再永久禁用）', async () => {
    let resolveFlag!: (v: unknown) => void
    flagMock.mockReturnValue(new Promise((r) => (resolveFlag = r)))
    checkMock.mockResolvedValue({ ok: true, hasRed: true, report: REPORT })
    const s = useCheckStore()
    await s.run('book', 'doc_A')
    const p1 = s.flagFalsePositive('book', 'doc_A', 'r1')
    await s.run('book', 'doc_A') // 推代 + 回填复位
    resolveFlag({ ok: true })
    await p1
    expect(s.flagging).toBeNull()
    // 迟到的 flag 成功被查代挡住不落 flagged → 再发起不被幂等守卫挡
    flagMock.mockResolvedValue({ ok: true })
    const before = flagMock.mock.calls.length
    await s.flagFalsePositive('book', 'doc_A', 'r1')
    expect(flagMock.mock.calls.length).toBe(before + 1) // 修复点：可再发起（修复前入口 return）
  })

  it('迟到 flag 响应仍不落 flagError/flagged（守卫不回退，只修 flagging 卡死）', async () => {
    let rejectFlag!: (e: Error) => void
    flagMock.mockReturnValue(new Promise((_r, rej) => (rejectFlag = rej)))
    checkMock.mockResolvedValue({ ok: true, hasRed: true, report: REPORT })
    const s = useCheckStore()
    await s.run('book', 'doc_A')
    const p = s.flagFalsePositive('book', 'doc_A', 'r1')
    await s.run('book', 'doc_A') // 推代
    rejectFlag(new Error('标记失败'))
    await p
    expect(s.flagError).toBeNull() // 查代挡住：旧错误不落新报告
    expect(s.flagged.size).toBe(0)
  })
})
