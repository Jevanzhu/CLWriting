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
  book_search: 'readonly',
  chapter_status: 'readonly',
  write_chapter: 'write',
  move_chapter: 'write',
  rename_chapter: 'write',
  copy_chapter: 'write',
  delete_chapter: 'write',
  rewrite_chapter: 'write',
  rewrite_selection: 'write',
  lead_update: 'write',
  harvest_style: 'write',
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
  {
    name: 'book_search',
    description: '全书关键词搜索（写作/正文、设定、大纲、布线、工作区）。返回命中文件与行号。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        scope: { type: 'string', description: '搜索范围：all / 定稿 / 正文 / 设定 / 大纲 / 工作区（缺省 all）' },
      },
      required: ['query'],
    },
  },
  {
    name: 'chapter_status',
    description: '全书近况快照：已写到第几章/第几卷、近 3 章节奏、进行中与超时账本。',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'move_chapter',
    description: '把指定章移动到目标目录（如移动到卷）。会改动书树结构，执行前作者需确认。',
    input_schema: {
      type: 'object',
      properties: {
        chapter: { type: 'number', description: '章号' },
        toDir: { type: 'string', description: '目标目录（相对书根，如 写作/正文/第二卷）' },
      },
      required: ['chapter', 'toDir'],
    },
  },
  {
    name: 'rename_chapter',
    description: '重命名指定章（改标题，章号不变）。会改动文件名与书树，执行前作者需确认。',
    input_schema: {
      type: 'object',
      properties: {
        chapter: { type: 'number', description: '章号' },
        newTitle: { type: 'string', description: '新标题' },
      },
      required: ['chapter', 'newTitle'],
    },
  },
  {
    name: 'copy_chapter',
    description: '复制指定章为副本（同目录，标题加「副本」）。会新增文件与书树节点，执行前作者需确认。',
    input_schema: {
      type: 'object',
      properties: {
        chapter: { type: 'number', description: '章号' },
      },
      required: ['chapter'],
    },
  },
  {
    name: 'delete_chapter',
    description: '软删指定章（移入回收站，可还原）。执行前作者需确认。',
    input_schema: {
      type: 'object',
      properties: {
        chapter: { type: 'number', description: '章号' },
      },
      required: ['chapter'],
    },
  },
  {
    name: 'rewrite_chapter',
    description: '按指令改写整章（AI 产出改写稿，不直接落盘；作者确认后再保存）。',
    input_schema: {
      type: 'object',
      properties: {
        chapter: { type: 'number', description: '章号' },
        instruction: { type: 'string', description: '改写指令（如：把战斗场景压缩一半，突出情感变化）' },
      },
      required: ['chapter', 'instruction'],
    },
  },
  {
    name: 'rewrite_selection',
    description: '按指令改写指定章的某段原文（AI 产出改写选段，不直接落盘；作者确认后再保存）。',
    input_schema: {
      type: 'object',
      properties: {
        chapter: { type: 'number', description: '章号' },
        selection: { type: 'string', description: '待改写选段（须与正文中原文一致）' },
        instruction: { type: 'string', description: '改写指令' },
      },
      required: ['chapter', 'selection', 'instruction'],
    },
  },
  {
    name: 'lead_update',
    description: '生成指定章的账本推进（AI 草拟履历行，写入 工作区/账本推进.md）。执行前作者需确认。',
    input_schema: {
      type: 'object',
      properties: {
        chapter: { type: 'number', description: '章号' },
      },
      required: ['chapter'],
    },
  },
  {
    name: 'harvest_style',
    description: '从定稿正文收割文风候选（样章/金句），写入 工作区/learn候选。执行前作者需确认。',
    input_schema: { type: 'object', properties: {} },
  },
]
