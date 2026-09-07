/**
 * R59 清偿批（R55-B-4）回归：ChainRecorder 缓冲超 256 上限截断丢最旧时 warn 留痕。
 *
 * 缺陷：O-1（十三轮）的「持续落库失败超上限丢最旧」slice 截断是静默的——与同文件
 * 已立的「丢事件必留痕」纪律（R50-A-3 迟到丢弃 / R66-4 flush 失败 / close 残留）
 * 不一致：落库故障期间被丢弃的链路观测事件（llm/call 等）无声蒸发，审计黑洞无从
 * 定位。修复：slice 前 log.warn 丢弃数（观测层留痕，不炸业务流程）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ChainRecorder, llmRetryEvent } from '../../src/events/chain-bridge.js'
import { log } from '../../src/log/index.js'

function badStore(): never {
  return {
    appendEvents: () => {
      throw new Error('disk full')
    },
    close: () => {},
  } as never
}

describe('R59 清偿批（R55-B-4）: 缓冲超限截断丢弃必留痕', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('持续落库失败冲破 256 上限：截断发生时有 warn 留丢弃数（修复前静默蒸发）', () => {
    const warn = vi.spyOn(log, 'warn').mockReturnValue()
    const r = new ChainRecorder(badStore(), 'ws-x')
    for (let i = 0; i < 288; i++) r.add(llmRetryEvent({ attempt: i, delayMs: 1 }))
    // 288 > 256：截断必已发生（每条 add 触发的失败 flush 回塞后超限切片）
    const truncateWarns = warn.mock.calls.filter((c) =>
      c.some((a) => typeof a === 'string' && a.includes('丢弃')),
    )
    expect(truncateWarns.length, '截断丢弃应有 warn 留痕（修复前零留痕）').toBeGreaterThan(0)
    for (const c of truncateWarns) {
      const msg = c.filter((a) => typeof a === 'string').join(' ')
      expect(msg).toContain('丢弃') // 丢弃数留痕（含具体条数）
      expect(msg).toContain('链路事件')
    }
  })

  it('未超上限（64 条持续失败）：只有 flush 失败 warn，无截断丢弃 warn（不扩大 warn 面）', () => {
    const warn = vi.spyOn(log, 'warn').mockReturnValue()
    const r = new ChainRecorder(badStore(), 'ws-x')
    for (let i = 0; i < 64; i++) r.add(llmRetryEvent({ attempt: i, delayMs: 1 }))
    expect(warn.mock.calls.some((c) => c.some((a) => typeof a === 'string' && a.includes('丢弃')))).toBe(false)
    expect(warn.mock.calls.length).toBeGreaterThan(0) // flush 失败 warn 照旧（R66-4）
  })
})
