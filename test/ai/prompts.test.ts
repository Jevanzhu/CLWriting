/**
 * P2-TST-2：prompt builders 单测。
 *
 * 验证：analyst/writer/review/chat 四个 builder 输出含必需段落 + 边界
 * （writerSystem kind 选择、reviewSystem 未知 lens fallback、chat trimHistory 截断）。
 */
import { describe, it, expect } from 'vitest'
import { ANALYST_SYSTEM } from '../../src/ai/prompts/analyst.js'
import { WRITER_SYSTEM_LONG, WRITER_SYSTEM_SHORT, REWRITER_SYSTEM, writerSystem } from '../../src/ai/prompts/writer.js'
import { REVIEW_SYSTEMS, reviewSystem } from '../../src/ai/prompts/review.js'
import { chatSystem, buildChatContext, trimHistory } from '../../src/ai/prompts/chat.js'
import type { ChatMsg } from '../../src/ai/provider/types.js'

describe('analyst.ts', () => {
  it('包含角色定位 + 各分析维度 + 输出方式', () => {
    expect(ANALYST_SYSTEM).toContain('资深')
    for (const dim of ['体验分', '情绪曲线', '钩子密度', '文风总结', '章节标签']) {
      expect(ANALYST_SYSTEM).toContain(dim)
    }
    expect(ANALYST_SYSTEM).toContain('输出方式')
  })

  it('边界：样本不足降级口径存在', () => {
    expect(ANALYST_SYSTEM).toContain('样本不足')
  })
})

describe('writer.ts', () => {
  it('长篇 system 含正文规则 + 钩子情绪 + 输出方式', () => {
    expect(WRITER_SYSTEM_LONG).toContain('资深中文网文写手')
    expect(WRITER_SYSTEM_LONG).toContain('纯叙事文本')
    expect(WRITER_SYSTEM_LONG).toContain('危机钩')
    expect(WRITER_SYSTEM_LONG).toContain('submit_chapter')
  })

  it('短篇 system 含闭环/反转/铺垫', () => {
    expect(WRITER_SYSTEM_SHORT).toContain('资深短篇小说家')
    expect(WRITER_SYSTEM_SHORT).toContain('铺垫→反转→收尾')
    expect(WRITER_SYSTEM_SHORT).toContain('核心反转')
  })

  it('rewriter 保持纯文本改写字面', () => {
    expect(REWRITER_SYSTEM).toContain('只改写选中段落')
    expect(REWRITER_SYSTEM).toContain('submit_text')
  })

  it('writerSystem(kind) 选对 prompt', () => {
    expect(writerSystem('long')).toBe(WRITER_SYSTEM_LONG)
    expect(writerSystem('short')).toBe(WRITER_SYSTEM_SHORT)
  })
})

describe('review.ts', () => {
  it('REVIEW_SYSTEMS 含 reader/editor/continuity/hook/emotion_peak/payoff 六视角', () => {
    for (const lens of ['reader', 'editor', 'continuity', 'hook', 'emotion_peak', 'payoff']) {
      expect(REVIEW_SYSTEMS[lens]).toContain('资深网文审稿员')
      expect(REVIEW_SYSTEMS[lens]).toContain('只报问题')
    }
  })

  it('reviewSystem 已知 lens 返回对应系统 + 未知 lens fallback 通用', () => {
    expect(reviewSystem('reader')).toBe(REVIEW_SYSTEMS['reader']!)
    expect(reviewSystem('continuity')).toContain('账本')
    expect(reviewSystem('not-exist')).toContain('资深网文审稿员')
  })
})

describe('chat.ts', () => {
  it('chatSystem 注入设定 + 职责 + 规则', () => {
    const s = chatSystem({ settings: '境界：练气/筑基/金丹' })
    expect(s).toContain('CLWriting 的写作助手')
    expect(s).toContain('境界：练气/筑基/金丹')
    expect(s).toContain('讨论伙伴')
    // 未指定章节不注入 currentChapter 段
    expect(s).not.toContain('作者指定讨论的章节')
  })

  it('chatSystem 指定章节 → 注入章节段', () => {
    const s = chatSystem({ settings: 'x', currentChapter: '第 3 章\n正文…' })
    expect(s).toContain('作者指定讨论的章节')
    expect(s).toContain('第 3 章')
  })

  it('buildChatContext 未指定章 → 仅设定无 currentChapter', () => {
    const c = buildChatContext('/nonexist', undefined)
    expect(c.currentChapter).toBeUndefined()
    expect(c.settings).toBeTypeOf('string')
  })

  it('buildChatContext chapter<1 → 不读文件', () => {
    const c = buildChatContext('/nonexist', 0)
    expect(c.currentChapter).toBeUndefined()
  })

  it('trimHistory 保留最近 maxTurns 完整回合', () => {
    // 每回合 2 条（user + assistant），12 条 = 6 回合，maxTurns=3 → 保 3 回合（6 条）
    const msgs: ChatMsg[] = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg${i}`,
    }))
    const cut = trimHistory(msgs, 3)
    expect(cut.length).toBe(6)
    expect(cut[0]!.content).toBe('msg6')
  })

  it('trimHistory 短历史不截断', () => {
    const msgs: ChatMsg[] = [{ role: 'user', content: 'hi' }]
    expect(trimHistory(msgs, 10)).toHaveLength(1)
  })

  it('trimHistory 截断点不落在 tool 消息中间（从纯文本 user 切）', () => {
    // 构造带 tool_use/tool_result 的历史：最后 4 条是 tool 循环，回合边界在更早
    const msgs: ChatMsg[] = [
      { role: 'user', content: 'u0' },
      { role: 'assistant', content: 'a0' },
      // tool 循环
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'r' }] },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u1' },
    ]
    // maxTurns=1 → 只保最后 1 回合：应切在最后一个纯文本 user（u1）
    const cut = trimHistory(msgs, 1)
    expect(cut[0]!.content).toBe('u1')
    expect(cut.length).toBe(1)
  })
})
