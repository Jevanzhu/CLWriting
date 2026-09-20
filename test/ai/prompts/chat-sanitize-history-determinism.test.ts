/**
 * RC 全项目重审（GLM-5.3，2026-09-20）P3：sanitizeHistory 确定性直测。
 *
 * R69-12 显式声明的事件口径：消毒层占位消息（[收到]/[对话继续]）与块级剔除是
 * 「模型可见、无独立事件」的确定性合成——铁律①（模型可见 ⟺ 已记录）的合法例外
 * 依赖「重放按同函数重建即得同值」这一不变量，此前只有注释声明、无机器锁（函数若
 * 引入非确定性输入即静默破重放）。本文件钉住三件事：
 *   ① 同输入多次消毒逐位相等（占位可由同函数精确重建）；
 *   ② 入参零变异（纯函数——消毒副作用若外溢会污染内存历史二次消毒）；
 *   ③ 占位文案与插入位置稳定（连续同 role 互补插入，首条非 user 剔除）。
 */
import { describe, it, expect } from 'vitest'
import { sanitizeHistory } from '../../../src/ai/prompts/chat.js'
import type { ChatMsg } from '../../../src/ai/provider/types.js'

function fixture(): ChatMsg[] {
  return [
    // 首条悬空 assistant（应被剔除）
    { role: 'assistant', content: '悬空开场' },
    { role: 'user', content: '第一问' },
    // 空 content 消息（应被剔除）
    { role: 'assistant', content: '' },
    // 连续同 role：assistant ×2（中间应插 user 占位 [对话继续]）
    { role: 'assistant', content: [{ type: 'text', text: '带工具轮' }, { type: 'reasoning', text: '思考' }, { type: 'tool_use', id: 'tu-1', name: 'lookup', input: { q: '设定' } }] },
    { role: 'assistant', content: '没有夹 user 的第二条' },
    // 正常 tool_result 回应（tu-1）
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu-1', content: '结果' }] },
    // 孤儿 tool_result（无对应 tool_use，应被剔除）
    { role: 'user', content: [{ type: 'text', text: '孤儿容器' }, { type: 'tool_result', toolUseId: 'tu-x', content: '孤儿' }] },
    // 连续 user（应插 assistant 占位 [收到]）+ 尾部孤儿 tool_use（无回应，应剔除）
    { role: 'user', content: '第二问' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-2', name: 'write', input: {} }] },
  ]
}

describe('sanitizeHistory 确定性（R69-12 占位重放不变量的机器锁）', () => {
  it('同输入多次消毒逐位相等——占位/剔除可由同函数精确重建（铁律①例外的前提）', () => {
    const runs = [sanitizeHistory(structuredClone(fixture())), sanitizeHistory(structuredClone(fixture())), sanitizeHistory(structuredClone(fixture()))]
    expect(runs[1]).toEqual(runs[0])
    expect(runs[2]).toEqual(runs[0])
  })

  it('入参零变异（纯函数）——消毒副作用不外溢内存历史', () => {
    const before = fixture()
    const snapshot = structuredClone(before)
    sanitizeHistory(before)
    expect(before).toEqual(snapshot)
  })

  it('占位文案与结构稳定：连续同 role 互补插入 [收到]/[对话继续]，悬空首条与孤儿块剔除', () => {
    const out = sanitizeHistory(fixture())
    const texts = out.flatMap((m) => (typeof m.content === 'string' ? [m.content] : []))
    expect(out[0]).toEqual({ role: 'user', content: '第一问' })
    expect(texts).toContain('[对话继续]')
    expect(texts).toContain('[收到]')
    // 相邻消息恒交替（占位使命达成）
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.role).not.toBe(out[i - 1]!.role)
    }
    // 孤儿 tool_use（tu-2）与孤儿 tool_result（tu-x）不存活
    const blockDump = JSON.stringify(out)
    expect(blockDump).not.toContain('tu-2')
    expect(blockDump).not.toContain('tu-x')
    // 有回应的 tu-1 往返完整存活
    expect(blockDump).toContain('tu-1')
  })
})
