/**
 * rewrite-prompt 单测（第十一轮 P1-TST-2）：
 * 改写提示词构建 / 续写拼稿 / 行级 diff。
 *
 * 纯函数模块，覆盖模式分支 + 边界。
 */
import { describe, it, expect } from 'vitest'
import { buildRewritePrompt, buildAppendPrompt, appendRewritten, lineDiff } from '../../src/process/rewrite-prompt.js'

describe('buildRewritePrompt', () => {
  it('local 模式 → 含选中段落 + 指令', () => {
    const p = buildRewritePrompt('local', '原文全文', '选中的段落', '改得更紧凑', [], 3, 'long')
    expect(p).toContain('选中的段落')
    expect(p).toContain('改得更紧凑')
    expect(p).toContain('只改写选中段落')
    expect(p).not.toContain('原章正文') // local 不含全文
  })

  it('whole 模式 → 含原章正文 + 指令', () => {
    const p = buildRewritePrompt('whole', '章正文内容', '', '加强冲突', [], 5, 'long')
    expect(p).toContain('章正文内容')
    expect(p).toContain('加强冲突')
    expect(p).toContain('重写第 5 章')
    expect(p).toContain('2000-4000 字') // 长篇字数要求
  })

  it('whole 模式短篇 → 含短篇字数要求', () => {
    const p = buildRewritePrompt('whole', '原文', '', '指令', [], 1, 'short')
    expect(p).toContain('8000-20000 字')
  })

  it('whole 模式带审稿意见 → 含编号列表', () => {
    const p = buildRewritePrompt('whole', '原文', '', '指令', ['意见A', '意见B'], 2, 'long')
    expect(p).toContain('1. 意见A')
    expect(p).toContain('2. 意见B')
    expect(p).toContain('审稿意见')
  })

  it('whole 模式无审稿意见 → 不含审稿段', () => {
    const p = buildRewritePrompt('whole', '原文', '', '指令', [], 2, 'long')
    expect(p).not.toContain('审稿意见')
  })
})

describe('buildAppendPrompt', () => {
  it('有原文 → 含正文全文 + 续写指令', () => {
    const p = buildAppendPrompt('已有正文', '接着写高潮')
    expect(p).toContain('已有正文')
    expect(p).toContain('接着写高潮')
    expect(p).toContain('只输出续写部分')
  })

  it('空原文 → 含"(本章尚无正文)"', () => {
    const p = buildAppendPrompt('   ', '从头开始')
    expect(p).toContain('本章尚无正文')
  })
})

describe('appendRewritten', () => {
  it('原文 + 续写 → 空行分隔', () => {
    expect(appendRewritten('原文', '续写')).toBe('原文\n\n续写')
  })

  it('原文尾部多换行 → trim 后拼接', () => {
    expect(appendRewritten('原文\n\n\n', '续写')).toBe('原文\n\n续写')
  })

  it('空原文 → 直接用续写', () => {
    expect(appendRewritten('', '从头写')).toBe('从头写')
  })
})

describe('lineDiff', () => {
  it('完全相同 → 全 same', () => {
    const d = lineDiff('a\nb\nc', 'a\nb\nc')
    expect(d.every((l) => l.type === 'same')).toBe(true)
    expect(d).toHaveLength(3)
  })

  it('新增行 → 含 add', () => {
    const d = lineDiff('a\nc', 'a\nb\nc')
    expect(d.some((l) => l.type === 'add' && l.text === 'b')).toBe(true)
  })

  it('删除行 → 含 del', () => {
    const d = lineDiff('a\nb\nc', 'a\nc')
    expect(d.some((l) => l.type === 'del' && l.text === 'b')).toBe(true)
  })

  it('空串对比新内容 → 含 add（空行被视作一行）', () => {
    const d = lineDiff('', '新内容')
    expect(d.some((l) => l.type === 'add' && l.text === '新内容')).toBe(true)
  })
})
