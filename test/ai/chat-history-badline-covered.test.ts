/**
 * 0918四轮修复批（B403）回归：真尾窗「已触底」判定在坏行降级下不误报。
 *
 * 原缺陷形态：buildChatHistoryView 的 covered 判据 `tail >= totalEvents || events.length < tail`
 * 的副支在窗内含坏行时恒真——listEventsTail 的 SQL LIMIT 消费原始行（坏行占窗口名额），
 * 解析时才被 safeRowToEvent 丢弃，events.length < tail 只说明「窗内有坏行」而非「已触底」。
 * 误判触底 → 跳过翻倍前扩直接按尾窗收尾：窗外旧史被无声隐藏，且 msgs ≤ limit 时
 * truncated 误报 false（前端把尾窗当成完整历史）。
 *
 * 修复：covered 只看 `tail >= totalEvents`（LIMIT 达表头 ⟺ 窗口必全量）；窗内坏行走
 * 安全边界 + 翻倍前扩，tail=min(tail×2, totalEvents) 严格递增保证终止。
 *
 * 本件用原生 sqlite 在表尾插一行坏 JSON（落入初始尾窗内），钉两面：
 * ①坏行不再伪装触底——窗外头部历史被翻倍前扩找回，truncated/total 契约与参照一致；
 * ②截断契约不回归——安全窗截断仍 truncated:true + total=骨架事件行数（含坏行）。
 */
import { describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll } from 'vitest'
import { bookHash, openSessionStore, type NewEvent, type SessionStore } from '../../src/events/store.js'
import {
  turnStartEvent,
  userMessageEvent,
  assistantMessageEvent,
  loadHistoryWithSeqs,
} from '../../src/events/chat-bridge.js'
import { buildChatHistoryView } from '../../src/studio/server/api/chat-history.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** 参照实现（内嵌，pm10 同款口径）：全量投影 + slice；截断态 total = 骨架事件行数 */
function referenceView(store: SessionStore, bookName: string, limit?: number) {
  const all = store.listEvents(bookName)
  const { msgs, seqsPerMsg } = loadHistoryWithSeqs(all)
  if (limit === undefined || !Number.isFinite(limit) || limit < 1 || msgs.length <= limit) {
    return { messages: msgs, seqs: seqsPerMsg, truncated: false, total: msgs.length }
  }
  return {
    messages: msgs.slice(-limit),
    seqs: seqsPerMsg.slice(-limit),
    truncated: true,
    total: store.countEvents(bookName),
  }
}

const uds: string[] = []
afterAll(() => {
  for (const ud of uds.splice(0)) rmSync(ud, { recursive: true, force: true })
})

describe('0918四轮修复批 B403: 坏行降级下「已触底」判定不误报', () => {
  it('表尾插坏 JSON（落入初始尾窗）→ 窗口翻倍至全量，窗外头部历史找回，truncated/total 契约不变', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ud = mkdtempTracked(join(tmpdir(), 'b403-badline-'))
    uds.push(ud)
    try {
      const store = openSessionStore(ud, '/b403/坏行尾窗书')!
      const sid = store.createSession('坏行尾窗书')
      try {
        // 头部历史（seq 1-2，必须可被找回）+ 36 条链路填充（把初始尾窗推离表头）+ 尾部对话
        const batch: NewEvent[] = [userMessageEvent('头部 u1'), assistantMessageEvent('头部 a1')]
        for (let t = 1; t <= 36; t++) batch.push(turnStartEvent(t))
        batch.push(userMessageEvent('尾部 u2'), assistantMessageEvent('尾部 a2'))
        store.appendEvents(sid, batch) // 共 40 行
      } finally {
        store.close() // 唯一 close 点（之后才可外部连库插坏行）
      }
      // 原生 sqlite 插一行坏 JSON（seq 41）——初始尾窗（tail=32 → seq 10..41）恰含它
      const dbPath = join(ud, 'clwriting', 'session', bookHash('/b403/坏行尾窗书') + '.db')
      {
        const raw = new DatabaseSync(dbPath)
        try {
          raw
            .prepare(
              "INSERT INTO events (session_id, type, data, replace_generation, created_at) VALUES (?, 'turn/start', '{oops', 0, 1)",
            )
            .run(sid)
        } finally {
          raw.close()
        }
      }
      const store2 = openSessionStore(ud, '/b403/坏行尾窗书')!
      try {
        expect(store2.countEvents('坏行尾窗书')).toBe(41) // 骨架行数含坏行

        // ① limit=5：初始窗（32 行）内消息 2 条 < 5 → 必须翻倍前扩至触底；
        //   修复前：坏行致 events.length(31) < tail(32) 误判触底 → truncated:false + total:2
        //   （头部两条被无声隐藏）；修复后：头部历史找回，全量 4 条消息与参照一致
        const view5 = buildChatHistoryView(store2, '坏行尾窗书', undefined, 5)
        const ref5 = referenceView(store2, '坏行尾窗书', 5)
        expect(view5.messages.map((m) => (typeof m.content === 'string' ? m.content : ''))).toEqual([
          '头部 u1',
          '头部 a1',
          '尾部 u2',
          '尾部 a2',
        ])
        expect(view5.truncated).toBe(false)
        expect(view5.total).toBe(4)
        expect({
          messages: view5.messages,
          seqs: view5.seqs,
          truncated: view5.truncated,
          total: view5.total,
        }).toStrictEqual({ messages: ref5.messages, seqs: ref5.seqs, truncated: ref5.truncated, total: ref5.total })

        // ② limit=2：安全窗截断契约不回归——truncated:true + total=骨架事件行数 41（含坏行）
        const view2 = buildChatHistoryView(store2, '坏行尾窗书', undefined, 2)
        expect(view2.truncated).toBe(true)
        expect(view2.total).toBe(41)
        expect(view2.messages.map((m) => (typeof m.content === 'string' ? m.content : ''))).toEqual([
          '尾部 u2',
          '尾部 a2',
        ])

        // ③ 全量路径（坏行降级）：4 条消息 + truncated:false，与参照一致
        const full = buildChatHistoryView(store2, '坏行尾窗书')
        expect(full.messages).toHaveLength(4)
        expect(full.truncated).toBe(false)
        expect(full.total).toBe(4)
      } finally {
        store2.close()
      }
    } finally {
      warn.mockRestore()
    }
  })
})
