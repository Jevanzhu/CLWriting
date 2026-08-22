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
  it('close 半途抛错 → msgSeqs/histories 双未动（账本不错位），异常向上传播', async () => {
    const seqs = Array.from({ length: 12 }, (_, i) => [100 + i])
    msgSeqMap.set(book, seqs)
    histories.set(book, history)
    compactHistoryMock.mockResolvedValueOnce({ history: compacted, summarizedCount: 5, wasOverLimit: true })
    const recorder = makeRecorder(() => {
      // 模拟 appendEvents 半途失败（flush 已落 session/end，compaction 段写一半抛出）
      throw new Error('E1: appendEvents SQLITE_BUSY')
    })

    await expect(finalizeHistory(opts, history, seqs, recorder, 'sys', state)).rejects.toThrow('SQLITE_BUSY')

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
