/**
 * P2-TST-2：prompt builders 单测。
 *
 * 验证：analyst/writer/review/chat 四个 builder 输出含必需段落 + 边界
 * （writerSystem kind 选择、reviewSystem 未知 lens fallback、chat trimHistory 截断）。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { resolveDraftPath } from '../../src/format/draft.js'
import { ANALYST_SYSTEM } from '../../src/ai/prompts/analyst.js'
import { WRITER_SYSTEM_LONG, WRITER_SYSTEM_SHORT, REWRITER_SYSTEM, writerSystem } from '../../src/ai/prompts/writer.js'
import { REVIEW_SYSTEMS, reviewSystem } from '../../src/ai/prompts/review.js'
import { chatSystem, buildChatContext, trimHistory, sanitizeHistory } from '../../src/ai/prompts/chat.js'
import type { ChatMsg, ContentBlock } from '../../src/ai/provider/types.js'

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

  it('P-6（第十四轮）无 fm 但正文含 --- 字样的手写稿 → 预览不吞段（bodyOf 同源剥 fm）', () => {
    const root = mkdtempSync(join(tmpdir(), 'clw-p6-'))
    try {
      const rel = resolveDraftPath(root, 3).relPath
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      // 无 fm：正文里的 --- 均非「整行独立 ---」（表格分隔行 |---|---| / 场景分隔线后接文字）。
      // 修复前宽松正则 /^---[\s\S]*?---\n?/ 的闭合 --- 不锚定行首尾——从首行 --- 一路
      // 吞到表格分隔行里的 ---，开场段与表头全丢
      writeFileSync(
        join(root, rel),
        '---\n雨夜开场，主角登场。\n\n| 场景 | 人物 |\n|---|---|\n| 破庙 | 主角 |\n\n结尾钩子。',
      )
      const c = buildChatContext(root, 3)
      expect(c.currentChapter).toContain('雨夜开场')
      expect(c.currentChapter).toContain('破庙')
      expect(c.currentChapter).toContain('结尾钩子')
      // 对照 1：合法 fm 章（首行 --- + 独立 --- 闭合行）——fm 剥离、正文进预览
      writeFileSync(join(root, rel), '---\n章号: 3\n标题: 测试\n---\n正文本体。')
      const c2 = buildChatContext(root, 3)
      expect(c2.currentChapter).toContain('正文本体。')
      expect(c2.currentChapter).not.toContain('标题: 测试')
      // 对照 2：裸 md 无任何 --- → 原样进预览
      writeFileSync(join(root, rel), '普通开场没有任何分隔线。')
      const c3 = buildChatContext(root, 3)
      expect(c3.currentChapter).toContain('普通开场没有任何分隔线。')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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

  // ── sanitizeHistory（§6.4，治 #3a/#3b）──

  it('sanitizeHistory 剔除空 content 消息（#3a：reasoning-only 被过滤后）', () => {
    const msgs: ChatMsg[] = [
      { role: 'user', content: 'u0' },
      { role: 'assistant', content: 'a0' },
      { role: 'assistant', content: '' },           // 空文本 → 剔除
      { role: 'assistant', content: [] },           // 空块数组 → 剔除
      { role: 'user', content: 'u1' },
    ]
    const out = sanitizeHistory(msgs)
    expect(out).toHaveLength(3)
    expect(out.map((m) => m.content)).toEqual(['u0', 'a0', 'u1'])
  })

  it('sanitizeHistory 连续同 role → 插互补角色占位保持交替（#3b 兜底）', () => {
    const msgs: ChatMsg[] = [
      { role: 'user', content: 'u0' },
      { role: 'user', content: 'u1' },              // 连续 user
      { role: 'assistant', content: 'a0' },
      { role: 'assistant', content: 'a1' },         // 连续 assistant
    ]
    const out = sanitizeHistory(msgs)
    // u0/u1 之间插 assistant 占位、a0/a1 之间插 user 占位 → 共 6 条且严格交替
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
    // 插入的是占位消息，不是原消息
    expect(out[1]).toMatchObject({ role: 'assistant', content: '[收到]' })
    expect(out[4]).toMatchObject({ role: 'user', content: '[对话继续]' })
  })

  it('sanitizeHistory reasoning-only assistant 消息 → 剔除（anthropic 适配器丢块成空 content）', () => {
    const msgs: ChatMsg[] = [
      { role: 'user', content: 'u0' },
      { role: 'assistant', content: [{ type: 'reasoning', text: '思考中' }] },
      { role: 'user', content: 'u1' },
    ]
    const out = sanitizeHistory(msgs)
    // reasoning-only 被剔 → u0/u1 连续 → 互补插 assistant 占位
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(out[1]).toMatchObject({ role: 'assistant', content: '[收到]' })
  })

  it('sanitizeHistory assistant 混合消息保留 reasoning 块（openai echoReasoning 回传硬要求）', () => {
    const msgs: ChatMsg[] = [
      { role: 'user', content: 'u0' },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'r' }, { type: 'text', text: 'a0' }] },
      { role: 'user', content: 'u1' },
    ]
    const out = sanitizeHistory(msgs)
    expect(out).toHaveLength(3)
    // reasoning 块本体不剔除（DeepSeek/Kimi 多轮带 tools 须回传 reasoning_content）
    expect((out[1] as { content: ContentBlock[] }).content).toEqual([
      { type: 'reasoning', text: 'r' },
      { type: 'text', text: 'a0' },
    ])
  })

  it('sanitizeHistory 尾部孤儿 tool_use（中断残留无 tool_result 回应）→ 从块中剔除', () => {
    const msgs: ChatMsg[] = [
      { role: 'user', content: 'u0' },
      { role: 'assistant', content: [{ type: 'text', text: 'a0' }, { type: 'tool_use', id: 't1', name: 'x', input: {} }] },
      { role: 'user', content: 'u1' },
    ]
    const out = sanitizeHistory(msgs)
    // t1 无回应 → 剔块；assistant 剩 text 仍有效保留
    expect((out[1] as { content: ContentBlock[] }).content).toEqual([{ type: 'text', text: 'a0' }])
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('sanitizeHistory reasoning + 孤儿 tool_use 且无 text → 整条剔除', () => {
    const msgs: ChatMsg[] = [
      { role: 'user', content: 'u0' },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'r' }, { type: 'tool_use', id: 't1', name: 'x', input: {} }] },
      { role: 'user', content: 'u1' },
    ]
    const out = sanitizeHistory(msgs)
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(out[1]).toMatchObject({ role: 'assistant', content: '[收到]' })
  })

  it('sanitizeHistory 孤儿 tool_result（无对应 tool_use）→ 删除', () => {
    const msgs: ChatMsg[] = [
      { role: 'user', content: 'u0' },
      { role: 'assistant', content: 'a0' },
      // 孤儿 tool_result：前面没有任何 tool_use 声明过 t1
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'r' }] },
      { role: 'user', content: 'u1' },
    ]
    const out = sanitizeHistory(msgs)
    expect(out.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.length > 0)).toBe(false)
    // 只剩 u0/a0/u1 三条
    expect(out.map((m) => m.content)).toEqual(['u0', 'a0', 'u1'])
  })

  it('sanitizeHistory 保留合法 tool 往返（tool_use → tool_result 配对）', () => {
    const msgs: ChatMsg[] = [
      { role: 'user', content: 'u0' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'r' }] },
      { role: 'assistant', content: 'a0' },
    ]
    const out = sanitizeHistory(msgs)
    expect(out).toHaveLength(4)
  })

  it('sanitizeHistory 首条非 user（悬空 assistant）→ 剔除', () => {
    const msgs: ChatMsg[] = [
      { role: 'assistant', content: 'a0' },         // 首条悬空
      { role: 'assistant', content: 'a1' },         // 连续 assistant（也会被占位）
      { role: 'user', content: 'u0' },
    ]
    const out = sanitizeHistory(msgs)
    // 悬空 assistant 被剔除，最终首条是 user
    expect(out[0]!.role).toBe('user')
    expect(out[0]!.content).toBe('u0')
  })

  it('sanitizeHistory 纯函数：不修改入参', () => {
    const msgs: ChatMsg[] = [
      { role: 'assistant', content: '' },
      { role: 'user', content: 'u1' },
    ]
    const snapshot = JSON.stringify(msgs)
    sanitizeHistory(msgs)
    expect(JSON.stringify(msgs)).toBe(snapshot)
  })
})
