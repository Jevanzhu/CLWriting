/**
 * 对话助手工具集 + 风险分级（方案 §3.4.4 / D6）。
 *
 * chat 的 toolChoice='auto'——AI 自主决定是否调工具。
 * 禁用并行工具调用（W0 disable_parallel_tool_use），一轮最多一个工具调用。
 *
 * 分级：
 * - readonly：自动执行，不打断对话流
 * - write：弹确认卡片，作者点确认才跑（write_chapter 会覆写草稿）
 */
import type { ToolDef } from '../provider/types.js'

/** 工具风险分级 */
export type ToolRisk = 'readonly' | 'write'

/** 工具名 → 风险级别（未知工具按 write 从严） */
export const TOOL_RISK: Record<string, ToolRisk> = {
  check_chapter: 'readonly',
  read_chapter: 'readonly',
  read_skill: 'readonly',
  write_chapter: 'write',
}

/** 工具集 */
export const chatTools: ToolDef[] = [
  {
    name: 'check_chapter',
    description: '对指定章节执行机检，返回红项/黄项列表。',
    input_schema: {
      type: 'object',
      properties: {
        chapter: { type: 'number', description: '章号（省略则用作者当前选定章节）' },
      },
    },
  },
  {
    name: 'read_chapter',
    description:
      '读取指定章节的完整正文。当对话上下文中的章节内容显示「已省略」时，用它取回全文（B3 spill 取回通道）。',
    input_schema: {
      type: 'object',
      properties: {
        chapter: { type: 'number', description: '章号（省略则用作者当前选定章节）' },
      },
    },
  },
  {
    name: 'read_skill',
    description:
      '按名读取写作技巧包全文（场景/对话/开篇等实操清单）。可用技巧包名见 system prompt 的「写作技巧包」索引。',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技巧包名（如「场景描写」，见 system prompt 索引）' },
      },
      required: ['name'],
    },
  },
  {
    name: 'write_chapter',
    description: '触发自动写章（AI 写稿→机检→红则重写闭环）。会覆写工作区草稿，执行前作者需确认。',
    input_schema: {
      type: 'object',
      properties: {
        chapter: { type: 'number', description: '章号' },
      },
      required: ['chapter'],
    },
  },
]
