/**
 * 网关吞 usage 时的用量估计原语。
 *
 * 背景：部分 OpenAI 兼容网关 / Anthropic 中转在流式正常完成（有 finish_reason /
 * stop_reason）但不回 usage。旧口径按 0/0 入账——预算闸 tokens/cost 两指标对这类
 * 端点永不生效、成本报表系统性偏低（注释自认「0 成本是可得最优估计」的取舍，本轮
 * 升级）：以可得信号估计入账，用量结构带 estimated 标记（见 types.ts TokenUsage）。
 *
 * 折算系数与备料输入预算闸同源（src/shared/tokens.ts estimateTokens：按模型查
 * 实测系数表、未命中回落中文 0.6 token/字、码位口径）——不复制第二份系数逻辑，
 * 校准脚本产出新系数后此处自动跟随。estimateTokens 已自
 * src/process/prepare.ts 下沉 src/shared/tokens.ts（原 provider→process 反向依赖
 * 是 ai 侧强连通的一条环边；现适配器族只依赖 shared，不再引编排层）。
 *
 * 输入侧误差上界与方向（本文件的折算口径声明，tokens.ts 头注同源）：
 * - 估计覆盖**请求文本 + 工具 schema + 消息结构包装**三项之和（见 estimateInputTokens）。
 *   三项缺任一都是单向低估：工具 schema 是本仓输入侧最大单项（chat 工具集 15 个，
 *   JSON 序列化约 3.5k 码位 ≈ 2k token @0.6），此前整项不计。
 * - 拼接结构项后仍有已知低估残差：各协议线的工具外壳键（openai 线每工具的
 *   `type/function` 前缀、anthropic 线 `messages[].content[]` 的块结构）与请求级
 *   定界 / 回复引导不计——量级为（工具数 + 消息数）× 数十码位，相对主体是小项。
 * - 与上一条反向的误差同时存在：系数表空 → 全按中文率 0.6 token/码位折算，而结构字符
 *   是 ASCII（约 0.25–0.35 token/码位），这部分被高估约 2 倍，抵消一部分低估。
 * - 净方向：中文正文占主体的请求以**低估**为主（中文真值率 0.6–1.0 的上沿侧还会再低估
 *   至多约 40%），但无严格双向上界——分词器边界效应无法由码位线性式包络。
 * - 结论：估算入账是与预算闸**同一近似口径**的估计值（带 estimated 标记），
 *   不作计费真值；系数表待真实事件库样本校准（表空为登记在案的待校准状态）。
 */
import type { GenRequest } from './types.js'
import { estimateTokens } from '../../shared/tokens.js'

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

/**
 * 每条消息的协议线固定外壳（码位计）——取适配器 `toOpenAIMessages` 纯文本分支的
 * 最小出站形态 `{ role, content }` 的 JSON 骨架：`{"role":"","content":""}` = 24 码位。
 * 依据：请求体的结构字符（键名、引号、括号）同样是模型输入、同样计费，而本仓
 * 三条协议线（openai chat / anthropic messages / responses input）对纯文本消息恒发
 * 这两个键（anthropic 线另加 `content` 数组与 `text` 块键，是**更长**的外壳，故取
 * openai 线是保守下界）。量级：24 码位 × 兜底系数 0.6 ≈ 15 token/条，单轮 chat
 * （数十条历史）合计数百 token，相对工具 schema（数千）是小项但非零——按「低估侧
 * 至少要看见结构项」的口径计入，不追求逐协议精确（精确值随线格式与 SDK 版本漂移）。
 */
const MESSAGE_ENVELOPE = '{"role":"","content":""}'

/**
 * 工具 schema 的请求侧计长口径：`req.tools` 整体 JSON 序列化。
 * 依据：ToolDef 结构即 `{ name, description?, input_schema }`（provider/types.ts），
 * JSON.stringify 一次覆盖函数名 / 描述 / 参数 schema 三项，与三条协议线的出站形态
 * 同构（适配器 toOpenAITool / toAnthropicTool / toResponsesTool 只是换外层键，
 * 内层 name/description/parameters 逐字来自同一 ToolDef）；序列化助手不必新造，
 * 三适配器各自的私有 mapper 是**协议专属包装**、非通用序列化，且均为模块内私有。
 * 尾部键前缀（如 `{"type":"function","function":` 与 `parameters`）不计——
 * 属上文声明的已知低估残差项。
 */
function toolsSchemaText(tools: GenRequest['tools']): string {
  return tools && tools.length > 0 ? JSON.stringify(tools) : ''
}

/** 输入侧估计：systemPrompt + 全部消息字符 + 消息外壳 + 工具 schema，按库内系数折算
 * （网关不发 message_start / prompt_tokens 时兜底；有实测值的侧不估，见各适配器兜底点）。
 * 结构项增量只在本入口叠加，估计函数本身仍是纯文本折算——备料预算闸（process/prepare
 * 直接调 estimateTokens）与入账共用同一系数表，不存在第二份折算逻辑。 */
export function estimateInputTokens(req: GenRequest, model?: string): number {
  let text = req.systemPrompt ?? ''
  for (const m of req.messages) text += flattenMsgContent(m.content)
  text += MESSAGE_ENVELOPE.repeat(req.messages.length)
  text += toolsSchemaText(req.tools)
  return estimateTokens(text, model)
}

/** 输出侧估计：累计产出（delta 串联文本 + tool 参数 JSON 串）按同源系数折算 */
export function estimateOutputTokens(text: string, model?: string): number {
  return estimateTokens(text, model)
}
