/**
 * N-6（第十二轮）回归：finalizeHistory 压缩分支的「先算后切」纪律。
 *
 * 背景：msgSeqs 与 msgSeqMap 存的是同一数组引用；recorder.close 的第二笔落库
 * （appendEvents 写 compaction 事件）可半途失败（SQLITE_BUSY / 盘满——flush 已过、
 * 遮蔽段写一半抛出）。修复前 splice 先行突变共享数组而 histories 未换 → 内存头部
 * 位错；重启 restore 的防御对齐只在尾部补 []，前缀错位永久化（误遮蔽活消息 / 幽灵
 * 回归，见 chat-restore-align.test.ts 的口径）。修复后：close 成功才突变，失败时
 * 数组/历史双未动——DB 无 compaction 事件、投影回全量历史，退化为「压缩未发生」。
 *
 * 手法：compactHistory 另有单测（compaction.test.ts），此处 mock 掉以精确控制
 * outcome，专测 finalizeHistory 的突变次序；recorder 用 stub（close 抛错/成功两态）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/ai/prompts/compaction.js', () => ({ compactHistory: vi.fn() }))

import { finalizeHistory } from '../../src/ai/orchestrate/chat/finish.js'
import { compactionSuppressed, histories, msgSeqMap } from '../../src/ai/orchestrate/chat/state.js'
import { compactHistory } from '../../src/ai/prompts/compaction.js'
import type { ChatOpts } from '../../src/ai/orchestrate/chat.js'
import type { ChatRunState } from '../../src/ai/orchestrate/chat/state.js'
import type { SessionRecorder } from '../../src/events/chat-bridge.js'
import type { ChatMsg } from '../../src/ai/provider/types.js'

const compactHistoryMock = vi.mocked(compactHistory)

const book = 'finalize-order-12'
const opts = { bookName: book } as ChatOpts
const state: ChatRunState = {
  ctrl: new AbortController(),
  deadline: Number.MAX_SAFE_INTEGER,
  pending: new Map(),
}

/** 12 条消息（6 回合）+ 对齐 seq 账本；压缩 outcome 裁前 5 条、留 1 条 + 存档 */
const history: ChatMsg[] = Array.from({ length: 12 }, (_, i) =>
  i % 2 === 0 ? { role: 'user', content: `问题${i}` } : { role: 'assistant', content: `回答${i}` },
)
const compacted: ChatMsg[] = [
  { role: 'user', content: '<checkpoint>累计摘要</checkpoint>' },
  ...history.slice(5),
]

function makeRecorder(closeImpl: () => number | null): SessionRecorder {
  return { close: vi.fn(closeImpl) } as unknown as SessionRecorder
}

afterEach(() => {
  histories.delete(book)
  msgSeqMap.delete(book)
  compactionSuppressed.delete(book)
  compactHistoryMock.mockReset()
})

describe('N-6（第十二轮）：finalizeHistory 压缩分支先算后切', () => {
  it('close 半途抛错 → msgSeqs/histories 双未动（账本不错位），R69-10 收编不上抛（chat_done 后不再补发 error）', async () => {
    const seqs = Array.from({ length: 12 }, (_, i) => [100 + i])
    msgSeqMap.set(book, seqs)
    histories.set(book, history)
    compactHistoryMock.mockResolvedValueOnce({ history: compacted, summarizedCount: 5, wasOverLimit: true })
    const recorder = makeRecorder(() => {
      // 模拟 appendEvents 半途失败（flush 已落 session/end，compaction 段写一半抛出）
      throw new Error('E1: appendEvents SQLITE_BUSY')
    })

    // R69-10（十七轮）：close 抛错收编（warn 留痕 + 退化为本轮未压缩）——此前异常
    // 穿 runChatInner（无 catch）→ sendChatMessage 的 catch 发 driver error，chat_done
    // 已发又收 error、压缩存档丢失
    await expect(finalizeHistory(opts, history, seqs, recorder, 'sys', state)).resolves.toBeUndefined()

    // 修复点：close 失败不得缩短共享数组——msgSeqMap 条目（同引用）保持 12 格全量
    expect(seqs.length).toBe(12)
    expect(msgSeqMap.get(book)).toEqual(Array.from({ length: 12 }, (_, i) => [100 + i]))
    expect(histories.get(book)).toBe(history)
    expect(recorder.close).toHaveBeenCalledTimes(1)
    // 遮蔽集合是 cut=5 条的 seq 展平（先算不突变）
    expect(recorder.close).toHaveBeenCalledWith('completed', [100, 101, 102, 103, 104], compacted[0]!.content)
  })

  it('close 成功 → 存档节点入账：msgSeqs = [archiveSeq] + 余量，histories 换压缩历史', async () => {
    const seqs = Array.from({ length: 12 }, (_, i) => [100 + i])
    msgSeqMap.set(book, seqs)
    histories.set(book, history)
    compactHistoryMock.mockResolvedValueOnce({ history: compacted, summarizedCount: 5, wasOverLimit: true })
    const recorder = makeRecorder(() => 900)

    await finalizeHistory(opts, history, seqs, recorder, 'sys', state)

    // 正常路径不受影响：裁 5 条 + 压入存档节点，两图同换
    expect(msgSeqMap.get(book)).toEqual([[900], [105], [106], [107], [108], [109], [110], [111]])
    expect(histories.get(book)).toBe(compacted)
  })

  it('close 成功但无存档 seq（返回 null）→ 压缩位留 [] 占位，余量对齐', async () => {
    const seqs = Array.from({ length: 12 }, (_, i) => [100 + i])
    msgSeqMap.set(book, seqs)
    histories.set(book, history)
    compactHistoryMock.mockResolvedValueOnce({ history: compacted, summarizedCount: 5, wasOverLimit: true })

    await finalizeHistory(opts, history, seqs, makeRecorder(() => null), 'sys', state)

    expect(msgSeqMap.get(book)).toEqual([[], [105], [106], [107], [108], [109], [110], [111]])
    expect(histories.get(book)).toBe(compacted)
  })
})

describe('R65-2（十三轮）：硬截断分支 close 先行（suppress 短路路径）', () => {
  /** 压缩不可用（summarizedCount=0）→ 走 trimAndClose 硬截断：close 先于内存突变。
   *  夹具 24 条消息（12 回合）确保越过窗口：trimHistory 保留最近 10 个纯文本 user 边界 → 截前 4 条（cut>0 真截断）（真截断形态）。 */
  function hardTrimOutcome() {
    return { history: [], summarizedCount: 0, wasOverLimit: true }
  }
  function longFixture() {
    const n = 24
    const h = Array.from({ length: n }, (_, i) =>
      i % 2 === 0 ? { role: 'user' as const, content: `长对话问题${i}` } : { role: 'assistant' as const, content: `长对话回答${i}` },
    )
    const q = Array.from({ length: n }, (_, i) => [100 + i])
    return { h, q }
  }

  it('硬截断 + close 抛错 → msgSeqs/histories 双未动，退化为「截断未发生」', async () => {
    const { h, q } = longFixture()
    msgSeqMap.set(book, q)
    histories.set(book, h)
    compactionSuppressed.add(book) // suppress 短路 → 直接 trimAndClose
    compactHistoryMock.mockResolvedValueOnce(hardTrimOutcome())
    const recorder = makeRecorder(() => {
      throw new Error('E2: close SQLITE_BUSY')
    })

    // R69-10（十七轮）：同上收编——warn 留痕、退化「截断未发生」，不再上抛
    await expect(finalizeHistory(opts, h, q, recorder, 'sys', state)).resolves.toBeUndefined()

    // R65-2 核心：close 抛错时内存/账本双未动——trim 视同未发生（修复前先截后 close，
    // 失败即「内存已截、遮蔽未落库」错位；restore 投影出幽灵历史）
    expect(q.length).toBe(24)
    expect(msgSeqMap.get(book)).toEqual(q.slice())
    expect(histories.get(book)).toBe(h)
    expect(recorder.close).toHaveBeenCalledTimes(1)
  })

  it('硬截断 close 成功 → 账本裁掉前 cut 段 + 历史换余量（close 时点内存仍全量）', async () => {
    const { h, q } = longFixture()
    msgSeqMap.set(book, q)
    histories.set(book, h)
    compactionSuppressed.add(book)
    compactHistoryMock.mockResolvedValueOnce(hardTrimOutcome())

    let atCloseMsgs = -1
    let atCloseSeqs = -1
    const recorder = makeRecorder(() => {
      // N-6 断言时点：close 执行瞬间内存尚未被 splice/set（次序证据）
      atCloseMsgs = histories.get(book)?.length ?? -1
      atCloseSeqs = msgSeqMap.get(book)?.length ?? -1
      return null
    })

    await finalizeHistory(opts, h, q, recorder, 'sys', state)

    expect(atCloseMsgs).toBe(24) // close 时历史仍全量 → close 确实先行
    expect(atCloseSeqs).toBe(24)
    // cutIdx 落在第 10 个倒数的 user 消息（idx=4）→ 截 4 留 20；硬截断无存档节点
    expect(msgSeqMap.get(book)).toHaveLength(20)
    expect(histories.get(book)).toHaveLength(20)
  })
})
