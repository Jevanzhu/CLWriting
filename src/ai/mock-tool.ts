/**
 * mock generateTool 响应（CLWRITING_DRIVER=mock 时用）。
 *
 * 复刻 mock driver 的载荷，适配 tool_use 结构化格式：
 * emotion 包一层 { segments: [...] }（tool schema 要求）。
 * 非 mock 环境返回 null（调用方走真实 provider 路径）。
 */
import type { TokenUsage } from './provider/types.js'

const MOCK_USAGE: TokenUsage = { inputTokens: 100, outputTokens: 50 }

/** 各 tool 的 mock input（按 toolName 分发） */
const MOCK_TOOL_INPUT: Record<string, unknown> = {
  submit_score: { score: 8, verdict: 'mock 体验：节奏稳健', dims: { 爽点: 8, 节奏感: 7, 拖沓: 3 } },
  submit_emotion: { segments: [{ seg: '开头', emotion: 0, label: 'mock 平稳' }, { seg: '高潮', emotion: 2, label: 'mock 高点' }] },
  submit_hooks: { hooks: [{ pos: '章尾', type: '悬念钩', strength: 4, note: 'mock 悬念' }], density: '中' },
  submit_style: { drift: 'mock 稳定', 口癖: ['mock 口癖'], 重复度评价: 'mock 正常', 建议: ['mock 建议'] },
  submit_tags: { 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '转折', 场景: '对话' },
  submit_infer_meta: { 目标情绪: 'mock 从压抑到释然的救赎', 核心反转: 'mock 真相藏在细节里' },
  submit_issues: { issues: [{ category: 'pacing', severity: 'S3', evidence: '正文原句', issue: 'mock 问题', fix: 'mock 修复' }] },
  submit_text: { 正文: '这是 mock 改写后的正文文本，保持了原有的叙事风格。' },
  // 写稿契约（self-heal mock 快路，审查 §六 self-heal 独缺 → runTask 补齐）
  submit_chapter: {
    标题: 'mock 章节标题',
    钩子类型: '悬念钩',
    钩子强弱: '中',
    情绪定位: '转折',
    场景: '对话',
    目标情绪: '惊悚',
    核心反转: '一切都藏在细节里',
    正文: '这是 mock 自动写章产出的章节正文，段落与空行，保持了叙事节奏。',
  },
}

/**
 * mock 快路：CLWRITING_DRIVER=mock 时返回结构化 mock 产出。
 * 非 mock 环境返回 null（调用方走真实 provider 路径）。
 */
export function tryMockTool(
  toolName: string,
): { input: unknown; text: string; usage: TokenUsage } | null {
  if (process.env['CLWRITING_DRIVER'] !== 'mock') return null
  const input = MOCK_TOOL_INPUT[toolName] ?? null
  if (!input) return null
  return { input, text: JSON.stringify(input), usage: MOCK_USAGE }
}
