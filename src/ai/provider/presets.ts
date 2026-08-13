/**
 * 厂商速填预设（方案 §4.6）——PRESETS 为唯一数据源，前端 AiServicePanel 消费。
 *
 * 排序（已拍板）：Chat 组 → Anthropic 组 → Responses 组（仅协议模板，无速填）。
 * baseUrl 为速填预填值，非运行时归一化（各家 SDK 拼法不同，见 §3.3）：
 * - openai 协议：SDK 不自拼 /v1，基址须自带版本路径
 * - anthropic 协议：SDK 自拼 /v1/messages，基址**不能**含 /v1
 */
import type { AuthStrategy, Protocol } from './types.js'

export interface ProviderPreset {
  label: string
  hint: string
  protocol: Protocol
  auth: AuthStrategy
  /** 速填预填的 baseUrl（可选，不预填则留空让用户填） */
  baseUrl?: string
}

/** OpenAI 两种线格式说明（用户要求标出）——Responses 预设暂缓，注释待启用 */
// const OPENAI_NOTE = 'Chat Completions：兼容格式，绝大多数服务 / 中转 / 自建；Responses：官方新格式，gpt-5 系列专用'

export const PRESETS: ProviderPreset[] = [
  // —— Chat Completions 组（openai 协议，bearer 认证）——
  {
    label: 'DeepSeek',
    hint: 'DeepSeek 官方 API（api.deepseek.com，无 /v1）',
    protocol: 'openai',
    auth: 'bearer',
    baseUrl: 'https://api.deepseek.com',
  },
  {
    label: 'GLM 智谱',
    hint: '智谱官方 API（GLM Coding Plan 用户请改 /api/coding/paas/v4）',
    protocol: 'openai',
    auth: 'bearer',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  },
  {
    label: 'Kimi 月之暗面',
    hint: 'Moonshot 官方 API（国内 / 国际 Key 不通用）',
    protocol: 'openai',
    auth: 'bearer',
    baseUrl: 'https://api.moonshot.cn/v1',
  },
  {
    label: 'Grok xAI',
    hint: 'xAI 官方 API（推理模型不支持 stop / penalty）',
    protocol: 'openai',
    auth: 'bearer',
    baseUrl: 'https://api.x.ai/v1',
  },
  {
    label: 'GPT OpenAI',
    hint: 'OpenAI 官方 API（Chat Completions 格式）',
    protocol: 'openai',
    auth: 'bearer',
    baseUrl: 'https://api.openai.com/v1',
  },
  {
    label: 'OpenAI 兼容通用',
    hint: '中转 / 自建 / 其他厂商（OpenAI 兼容端点）',
    protocol: 'openai',
    auth: 'bearer',
  },

  // —— Anthropic 组（anthropic 协议）——
  {
    label: 'Claude 官方',
    hint: 'Anthropic 官方 API（基址不含 /v1，SDK 自拼）',
    protocol: 'anthropic',
    auth: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
  },
  {
    label: 'DeepSeek Claude 格式',
    hint: 'DeepSeek 的 Anthropic 兼容端点（原生参数面）',
    protocol: 'anthropic',
    auth: 'anthropic',
    baseUrl: 'https://api.deepseek.com/anthropic',
  },
  {
    label: 'GLM Claude 格式',
    hint: '智谱的 Anthropic 兼容端点',
    protocol: 'anthropic',
    auth: 'anthropic',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
  },
  {
    label: 'Kimi Claude 格式',
    hint: 'Moonshot 的 Anthropic 兼容端点（Bearer / AUTH_TOKEN）',
    protocol: 'anthropic',
    auth: 'claudeAuth',
    baseUrl: 'https://api.moonshot.cn/anthropic',
  },
  {
    label: 'Claude 中转 / 网关',
    hint: 'Claude Code 兼容网关，通常只认 Bearer',
    protocol: 'anthropic',
    auth: 'claudeAuth',
  },

  // —— Responses 组 ——
  // Responses 协议暂缓（决策 4）：探测链已知缺陷未补全，入口隐藏防误用。
  // 启用时机到了放开此条即可。
  // {
  //   label: 'OpenAI Responses API',
  //   hint: OPENAI_NOTE,
  //   protocol: 'openai-responses',
  //   auth: 'bearer',
  // },
]
