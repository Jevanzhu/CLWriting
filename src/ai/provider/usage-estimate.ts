/**
 * R73-1（二十一轮 A-1）：网关吞 usage 时的用量估计原语。
 *
 * 背景：部分 OpenAI 兼容网关 / Anthropic 中转在流式正常完成（有 finish_reason /
 * stop_reason）但不回 usage。旧口径按 0/0 入账——预算闸 tokens/cost 两指标对这类
 * 端点永不生效、成本报表系统性偏低（注释自认「0 成本是可得最优估计」的取舍，本轮
 * 升级）：以可得信号估计入账，用量结构带 estimated 标记（见 types.ts TokenUsage）。
 *
 * 折算系数与备料输入预算闸同源（src/process/prepare.ts estimateTokens：按模型查
 * 实测系数表、未命中回落中文 0.6 token/字、码位口径）——不复制第二份系数逻辑，
 * 校准脚本产出新系数后此处自动跟随。依赖方向 src/ai → src/process 与 self-heal
 * 等编排层既有方向一致（process 依赖链不回指 ai/provider，无环）。
 */
import type { GenRequest } from './types.js'
import { estimateTokens } from '../../process/prepare.js'

/** ChatMsg 内容 flatten 为纯文本（估算口径：text 原文 + tool 参数 JSON + tool_result 内容） */
function flattenMsgContent(content: GenRequest['messages'][number]['content']): string {
  if (typeof content === 'string') return content
  let out = ''
  for (const b of content) {
    if (b.type === 'text' || b.type === 'reasoning') out += b.text
    else if (b.type === 'tool_use') out += JSON.stringify(b.input)
    else out += b.content
  }
  return out
}

/** 输入侧估计：systemPrompt + 全部消息字符按库内系数折算（网关不发 message_start /
 *  prompt_tokens 时兜底；有实测值的侧不估，见各适配器兜底点） */
export function estimateInputTokens(req: GenRequest, model?: string): number {
  let text = req.systemPrompt ?? ''
  for (const m of req.messages) text += flattenMsgContent(m.content)
  return estimateTokens(text, model)
}

/** 输出侧估计：累计产出（delta 串联文本 + tool 参数 JSON 串）按同源系数折算 */
export function estimateOutputTokens(text: string, model?: string): number {
  return estimateTokens(text, model)
}
