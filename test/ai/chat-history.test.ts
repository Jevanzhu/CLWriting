/**
 * X-P2-24：chat 对话历史 LRU 语义（get 命中重插，非 FIFO）。
 */
import { describe, expect, it } from 'vitest'
import { getHistory, clearChatHistory } from '../../src/ai/orchestrate/chat.js'
import { compactionSuppressed, histories } from '../../src/ai/orchestrate/chat/state.js'

const BOOKS = ['书1', '书2', '书3', '书4', '书5', '书6', '书7', '书8', '书9', '书A']

describe('X-P2-24 对话历史 LRU', () => {
  it('get 命中重排——热点书历史不被冷书逐出', () => {
    for (const b of BOOKS) clearChatHistory(b)
    // 填满 8 本上限；书A 是最早插入的
    const a = getHistory('书A')
    a.push({ role: 'user', content: 'a1' })
    for (let i = 1; i <= 7; i++) getHistory(`书${i}`)
    // 书A 命中（重插为最新）后再进一本冷书 → 淘汰的应是最旧的书1，而非书A
    getHistory('书A')
    getHistory('书9')
    expect(getHistory('书A').map((m) => m.content)).toEqual(['a1'])
    expect(getHistory('书1')).toEqual([])
  })

  // 低级项（第六轮）：compactionSuppressed 从 finish.ts 挪入 state.ts 后须随
  // histories 同生命周期——清空/逐出都清，删书换书后不留幽灵 suppress 标记
  it('低级项：compactionSuppressed 随 clearChatHistory 清空、随 LRU 逐出清理', () => {
    for (const b of BOOKS) clearChatHistory(b)
    compactionSuppressed.add('书A')
    clearChatHistory('书A')
    expect(compactionSuppressed.has('书A')).toBe(false)

    // LRU 逐出：填满 8 本（书1 最旧），第 9 本进位逐出书1——其 suppress 标记一并清
    compactionSuppressed.add('书1')
    for (let i = 1; i <= 8; i++) getHistory(`书${i}`)
    getHistory('书9')
    expect(histories.size).toBe(8)
    expect(compactionSuppressed.has('书1')).toBe(false)
    expect(compactionSuppressed.has('书9')).toBe(false)
    for (const b of [...BOOKS, '书9']) clearChatHistory(b)
    compactionSuppressed.clear()
  })
})
