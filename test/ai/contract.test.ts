/**
 * contract/chapter.ts 契约层单测（审查 §七：ai/contract 零单测）。
 *
 * assembleChapter：AI 结构化字段 → 宿主拼装 front matter + 正文。
 * 重点守卫：fm 由宿主拼装（章号宿主填）、正文纯文本透传、空正文拒收。
 */
import { describe, expect, it } from 'vitest'
import {
  assembleChapter,
  chapterTool,
  chapterToolName,
  submitText,
} from '../../src/ai/contract/chapter.js'

describe('assembleChapter 长篇', () => {
  it('结构化字段 → 宿主拼装 fm + 正文', () => {
    const r = assembleChapter(
      { 标题: '矿井深处', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '压抑', 场景: '战斗', 正文: '正文段落。\n\n第二段。' },
      7,
      'long',
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.content.startsWith('---\n章号: 7\n标题: 矿井深处')).toBe(true)
      expect(r.content).toContain('钩子类型: 悬念钩')
      expect(r.content).toContain('情绪定位: 压抑')
      expect(r.content.endsWith('---\n正文段落。\n\n第二段。')).toBe(true)
    }
  })

  it('章号宿主填（AI 不产出）；可空字段缺失时跳过', () => {
    const r = assembleChapter({ 标题: 'x', 正文: '正文' }, 3, 'long')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.content).toContain('章号: 3')
  })

  it('空正文 → ok:false', () => {
    const r = assembleChapter({ 标题: 'x', 正文: '  ' }, 3, 'long')
    expect(r).toMatchObject({ ok: false, error: '正文字段为空' })
  })

  it('产出非对象 / 缺失 → ok:false', () => {
    expect(assembleChapter(null, 1, 'long')).toMatchObject({ ok: false })
    expect(assembleChapter('string', 1, 'long')).toMatchObject({ ok: false })
  })

  it('标题含换行 → sanitize 为单行（P2-8：fm 按行解析不被截断）', () => {
    const r = assembleChapter({ 标题: '第一行\n第二行', 正文: '正文' }, 1, 'long')
    expect(r.ok).toBe(true)
    if (r.ok) {
      // 换行转空格，fm 仍按行解析：标题行 = "标题: 第一行 第二行"
      expect(r.content).toContain('标题: 第一行 第二行')
      expect(r.content).not.toContain('标题: 第一行\n')
    }
  })
})

describe('assembleChapter 短篇', () => {
  it('章号宿主填 + 目标情绪/核心反转', () => {
    const r = assembleChapter({ 标题: '雨夜', 目标情绪: '温暖', 核心反转: '一切都在细节里', 正文: '短文正文' }, 2, 'short')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.content.startsWith('---\n章号: 2')).toBe(true)
      expect(r.content).toContain('目标情绪: 温暖')
      expect(r.content).toContain('核心反转: 一切都在细节里')
    }
  })
})

describe('写稿工具契约', () => {
  it('chapterTool 按 kind 选长短篇工具，名称与 tool_choice 一致', () => {
    expect(chapterToolName('long')).toBe('submit_chapter')
    expect(chapterToolName('short')).toBe('submit_piece')
    expect(chapterTool('long').name).toBe('submit_chapter')
    expect(chapterTool('short').name).toBe('submit_piece')
  })

  it('submit_text 只要求正文字段（改写契约）', () => {
    const t = submitText()
    expect(t.name).toBe('submit_text')
    const required = t.input_schema.required as string[]
    expect(required).toContain('正文')
    expect(required).not.toContain('标题')
  })

  it('章号/钩子类型等字段由宿主拼装——schema 不要求章号（AI 不产出）', () => {
    const t = chapterTool('long')
    const props = t.input_schema.properties as Record<string, unknown>
    expect('章号' in props).toBe(false)
    expect('钩子强弱' in props).toBe(true)
  })
})