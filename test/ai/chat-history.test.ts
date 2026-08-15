/**
 * X-P2-24：chat 对话历史 LRU 语义（get 命中重插，非 FIFO）。
 */
import { describe, expect, it } from 'vitest'
import { getHistory, clearChatHistory } from '../../src/ai/orchestrate/chat.js'

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
})
