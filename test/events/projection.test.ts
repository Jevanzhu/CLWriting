/**
 * F1-P1 surface 投影纯函数单测：deriveMessages / foldSurface / 校验链。
 */
import { describe, expect, it } from 'vitest'
import { foldSurface, deriveMessages, validateEventStream, sortEvents } from '../../src/events/projection.js'
import type { ChatEvent } from '../../src/events/types.js'

function ev(seq: number, type: ChatEvent['type'], data: Record<string, unknown>, extra: Partial<ChatEvent> = {}): ChatEvent {
  return { seq, sessionId: 's1', type, data, createdAt: 1, replaceGeneration: 0, ...extra }
}

describe('F1-P1 deriveMessages', () => {
  it('还原纯文本往返（user + assistant 字符串）', () => {
    const events: ChatEvent[] = [
      ev(1, 'user/message', { message: '你好' }, { surfaceOp: 'append' }),
      ev(2, 'assistant/message', { message: '你好！有什么可以帮你？' }, { surfaceOp: 'append' }),
    ]
    expect(deriveMessages(events)).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！有什么可以帮你？' },
    ])
  })

  it('连续 tool/result 合并为一条 user(tool_result blocks) 消息', () => {
    const events: ChatEvent[] = [
      ev(1, 'user/message', { message: '检查第三章' }, { surfaceOp: 'append' }),
      ev(2, 'assistant/message', {
        message: [{ type: 'text', text: '我来检查' }, { type: 'tool_use', id: 't1', name: 'check_chapter', input: { chapter: 3 } }],
      }, { surfaceOp: 'append' }),
      ev(3, 'tool/result', { callId: 't1', content: '机检全绿', isError: false }, { surfaceOp: 'append' }),
      ev(4, 'tool/result', { callId: 't2', content: '有 2 个红项', isError: true }, { surfaceOp: 'append' }),
      ev(5, 'assistant/message', { message: '检查完毕' }, { surfaceOp: 'append' }),
    ]
    const msgs = deriveMessages(events)
    expect(msgs).toHaveLength(4)
    expect(msgs[0]).toEqual({ role: 'user', content: '检查第三章' })
    expect(msgs[1]!.content).toEqual([
      { type: 'text', text: '我来检查' },
      { type: 'tool_use', id: 't1', name: 'check_chapter', input: { chapter: 3 } },
    ])
    expect(msgs[2]).toEqual({ role: 'user', content: [
      { type: 'tool_result', toolUseId: 't1', content: '机检全绿', isError: false },
      { type: 'tool_result', toolUseId: 't2', content: '有 2 个红项', isError: true },
    ] })
    expect(msgs[3]).toEqual({ role: 'assistant', content: '检查完毕' })
  })

  it('assistant 空 content（usage 壳）跳过，不进抄本', () => {
    const events: ChatEvent[] = [
      ev(1, 'user/message', { message: 'hi' }, { surfaceOp: 'append' }),
      ev(2, 'assistant/message', { message: '', usage: { inputTokens: 1, outputTokens: 2 } }, { surfaceOp: 'append' }),
    ]
    expect(deriveMessages(events)).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('reasoning-only assistant（剔 reasoning 无 payload）跳过', () => {
    const events: ChatEvent[] = [
      ev(1, 'assistant/message', { message: [{ type: 'reasoning', text: '思考中' }] }, { surfaceOp: 'append' }),
    ]
    expect(deriveMessages(events)).toEqual([])
  })
})

describe('F1-P1 replace 遮蔽（压缩走遮蔽）', () => {
  it('compaction/end 遮蔽闭区间后 derive 只含未遮蔽节点', () => {
    const events: ChatEvent[] = [
      ev(1, 'user/message', { message: '旧1' }, { surfaceOp: 'append' }),
      ev(2, 'assistant/message', { message: '旧回复1' }, { surfaceOp: 'append' }),
      ev(3, 'user/message', { message: '旧2' }, { surfaceOp: 'append' }),
      ev(4, 'assistant/message', { message: '旧回复2' }, { surfaceOp: 'append' }),
      ev(5, 'user/message', { message: '新问题' }, { surfaceOp: 'append' }),
      ev(6, 'compaction/end', { reason: 'completed' }, { surfaceOp: 'replace', shadowStart: 1, shadowEnd: 4, sourceSeqs: [1, 2, 3, 4] }),
    ]
    // 遮蔽后投影只留新消息
    expect(deriveMessages(events)).toEqual([{ role: 'user', content: '新问题' }])
    // foldSurface 保留被遮蔽节点（shadowed=true），人类抄本可审计
    const nodes = foldSurface(events)
    expect(nodes.filter((n) => n.shadowed).map((n) => n.seq)).toEqual([1, 2, 3, 4])
    expect(nodes.filter((n) => !n.shadowed).map((n) => n.seq)).toEqual([5])
  })

  it('prefixSeq 任意前缀重建——遮蔽前的前缀恢复被压缩前的完整历史', () => {
    const events: ChatEvent[] = [
      ev(1, 'user/message', { message: '旧1' }, { surfaceOp: 'append' }),
      ev(2, 'user/message', { message: '新' }, { surfaceOp: 'append' }),
      ev(3, 'compaction/end', { reason: 'completed' }, { surfaceOp: 'replace', shadowStart: 1, shadowEnd: 1, sourceSeqs: [1] }),
    ]
    expect(deriveMessages(events, 2)).toEqual([
      { role: 'user', content: '旧1' },
      { role: 'user', content: '新' },
    ])
    expect(deriveMessages(events)).toEqual([{ role: 'user', content: '新' }])
  })
})

describe('F1-P1 校验链', () => {
  it('非 surface 事件禁带 surfaceOp；surface 事件必须带', () => {
    const bad1 = [ev(1, 'turn/start', {}, { surfaceOp: 'append' })]
    expect(validateEventStream(bad1).some((i) => i.message.includes('禁带'))).toBe(true)
    const bad2 = [ev(1, 'user/message', { message: 'x' })]
    expect(validateEventStream(bad2).some((i) => i.message.includes('必须带'))).toBe(true)
    const good = [ev(1, 'user/message', { message: 'x' }, { surfaceOp: 'append' })]
    expect(validateEventStream(good)).toEqual([])
  })

  it('replace 遮蔽未可见节点 / start>end / sourceSeqs 不完整 → 报问题', () => {
    // 遮蔽未可见 seq（5 未出现）
    const r1 = [
      ev(1, 'user/message', { message: 'a' }, { surfaceOp: 'append' }),
      ev(2, 'compaction/end', { reason: 'x' }, { surfaceOp: 'replace', shadowStart: 1, shadowEnd: 5, sourceSeqs: [1, 2, 3, 4, 5] }),
    ]
    expect(validateEventStream(r1).some((i) => i.message.includes('未可见'))).toBe(true)
    // start > end
    const r2 = [
      ev(1, 'user/message', { message: 'a' }, { surfaceOp: 'append' }),
      ev(2, 'compaction/end', { reason: 'x' }, { surfaceOp: 'replace', shadowStart: 2, shadowEnd: 1, sourceSeqs: [1] }),
    ]
    expect(validateEventStream(r2).some((i) => i.message.includes('shadowStart > shadowEnd'))).toBe(true)
    // sourceSeqs 未覆盖被遮蔽节点
    const r3 = [
      ev(1, 'user/message', { message: 'a' }, { surfaceOp: 'append' }),
      ev(2, 'user/message', { message: 'b' }, { surfaceOp: 'append' }),
      ev(3, 'compaction/end', { reason: 'x' }, { surfaceOp: 'replace', shadowStart: 1, shadowEnd: 2, sourceSeqs: [1] }),
    ]
    expect(validateEventStream(r3).some((i) => i.message.includes('未覆盖'))).toBe(true)
  })

  it('F2：turn/end、step/end、session/end 的 reason 必须在受控词表', () => {
    // 合法 reason 通过
    const good = [
      ev(1, 'session/end', { reason: 'completed' }),
      ev(2, 'turn/end', { reason: 'max-turns' }),
      ev(3, 'step/end', { reason: 'aborted' }),
    ]
    expect(validateEventStream(good)).toEqual([])
    // 非法 reason 报问题（自由字符串被拒绝）
    const bad = [
      ev(1, 'session/end', { reason: 'failed' }), // 'failed' 非受控词（应为 error）
      ev(2, 'turn/end', { reason: 'timeout' }), // 'timeout' 非受控词（应为 aborted）
      ev(3, 'step/end', { reason: 'whatever' }),
    ]
    expect(validateEventStream(bad).some((i) => i.message.includes('session/end 非法终止原因'))).toBe(true)
    expect(validateEventStream(bad).some((i) => i.message.includes('turn/end 非法终止原因'))).toBe(true)
    expect(validateEventStream(bad).some((i) => i.message.includes('step/end 非法终止原因'))).toBe(true)
  })

  it('seq 重复 / sourceSeqs 含未来 seq → 报问题', () => {
    const dup = [ev(1, 'user/message', { message: 'a' }, { surfaceOp: 'append' }), ev(1, 'user/message', { message: 'b' }, { surfaceOp: 'append' })]
    expect(validateEventStream(dup).some((i) => i.message.includes('重复'))).toBe(true)
    const future = [
      ev(1, 'user/message', { message: 'a' }, { surfaceOp: 'append' }),
      ev(2, 'compaction/end', { reason: 'x' }, { surfaceOp: 'replace', shadowStart: 1, shadowEnd: 1, sourceSeqs: [3] }),
    ]
    expect(validateEventStream(future).some((i) => i.message.includes('不小于当前 seq'))).toBe(true)
  })

  it('乱序事件排序后重放正确', () => {
    const events = [
      ev(2, 'assistant/message', { message: 'B' }, { surfaceOp: 'append' }),
      ev(1, 'user/message', { message: 'A' }, { surfaceOp: 'append' }),
    ]
    expect(sortEvents(events).map((e) => e.seq)).toEqual([1, 2])
    expect(deriveMessages(events)).toEqual([
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'B' },
    ])
  })
})

