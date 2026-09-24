/**
 * 对话工具确认卡的作者可见面（源码锚 src/ai/contract/tool-meta.ts）。
 *
 * 修复前：确认卡只显示英文内部名（15 个工具中 13 个无中文名）且不展示任何参数——
 * 作者放行改名/移动/改写/删除时看不到目标章、新名称或改写指令，关卡形同虚设。
 * 修复后：中文名与参数摘要单源 TOOL_META，章号经注入回调解析为章名，自由文本按码点截断。
 */
import { describe, it, expect } from 'vitest'
import { TOOL_RISK } from '../../src/ai/contract/chat.js'
import { TOOL_META, toolLabel, toolSummary } from '../../src/ai/contract/tool-meta.js'

const names = (chapter: number): string | null => (chapter === 12 ? '第 12 章 北境的雪' : null)

describe('工具确认卡的中文名与参数摘要', () => {
  it('TOOL_META 覆盖 TOOL_RISK 的全部工具，且风险分级一致', () => {
    expect(Object.keys(TOOL_META).sort()).toEqual(Object.keys(TOOL_RISK).sort())
    for (const [name, risk] of Object.entries(TOOL_RISK)) {
      expect(TOOL_META[name]?.risk).toBe(risk)
    }
  })

  it('未登记工具回落英文原名，不显示空白', () => {
    expect(toolLabel('move_chapter')).toBe('移动章节')
    expect(toolLabel('mystery_tool')).toBe('mystery_tool')
  })

  it('章号经回调解析为章名；解析不到回落「第 N 章」', () => {
    expect(toolSummary('delete_chapter', { chapter: 12 }, names)).toBe('第 12 章 北境的雪')
    expect(toolSummary('write_chapter', { chapter: 3 }, names)).toBe('第 3 章')
  })

  it('改名/移动/改写展示新名、目标位置与指令前若干字', () => {
    expect(toolSummary('rename_chapter', { chapter: 12, newTitle: '雪落无声' }, names)).toBe('第 12 章 北境的雪：改为「雪落无声」')
    expect(toolSummary('move_chapter', { chapter: 12, toDir: '写作/正文/第二卷' }, names)).toBe(
      '第 12 章 北境的雪：移到「写作/正文/第二卷」',
    )
    const long = '把战斗场景压缩一半，突出情感变化，并删掉所有环境描写堆砌'.repeat(3)
    const summary = toolSummary('rewrite_chapter', { chapter: 12, instruction: long }, names)
    expect(summary.startsWith('第 12 章 北境的雪：指令：')).toBe(true)
    expect(summary.endsWith('…')).toBe(true)
    // 截断按码点：尾标前不超过 60 个码点
    const shown = summary.slice(summary.indexOf('指令：') + 3, -1)
    expect([...shown].length).toBeLessThanOrEqual(60)
  })

  it('改写选段同时展示原文与指令；缺章号时摘要其余部分照常展示', () => {
    expect(toolSummary('rewrite_selection', { selection: '山门古拙', instruction: '写得更冷' }, names)).toBe(
      '原文：山门古拙；指令：写得更冷',
    )
  })

  it('入参形状异常不抛错：非对象、缺字段、坏章号都给出可读兜底', () => {
    expect(() => toolSummary('rename_chapter', null, names)).not.toThrow()
    expect(toolSummary('rename_chapter', null, names)).toBe('')
    expect(toolSummary('delete_chapter', { chapter: -1 }, names)).toBe('')
    expect(toolSummary('delete_chapter', { chapter: '十二' }, names)).toBe('')
    expect(toolSummary('book_search', { query: '玉佩', scope: '设定' }, names)).toBe('搜索「玉佩」（范围：设定）')
    // 未登记工具：键值短列兜底
    expect(toolSummary('mystery_tool', { foo: '甲', bar: 2 }, names)).toBe('foo=甲，bar=2')
  })

  it('无参工具摘要为空（不凭空造内容）', () => {
    expect(toolSummary('harvest_style', {}, names)).toBe('')
    expect(toolSummary('chapter_status', {}, names)).toBe('')
  })
})
