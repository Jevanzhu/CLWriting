/**
 * 协议模板——不是厂商清单（方案 §四①）。
 *
 * CLWriting 是分发产品，别人接他们自己的服务。模板只承担一件事：
 * 把「协议 + 认证」这对技术选择翻译成人话。它是表单预填数据，运行时不依赖。
 */
import type { AuthStrategy, Protocol } from './types.js'

export interface ProviderPreset {
  label: string
  hint: string
  protocol: Protocol
  auth: AuthStrategy
}

/**
 * OpenAI 两种线格式（用户要求标出）：
 * - Responses API（/v1/responses）——官方新格式，gpt-5 系列专用，`o` 开头模型自动走
 * - Chat Completions（/v1/chat/completions）——兼容格式，绝大多数服务（gpt-4o/DeepSeek/通义等）
 */
export const PRESETS: ProviderPreset[] = [
  {
    label: 'Anthropic 官方格式',
    hint: 'Anthropic 官方 API，或声明兼容其格式的服务',
    protocol: 'anthropic',
    auth: 'anthropic',
  },
  {
    label: 'Claude 中转 / 网关',
    hint: 'Claude Code 兼容网关，通常只认 Bearer',
    protocol: 'anthropic',
    auth: 'claudeAuth',
  },
  {
    label: 'OpenAI 官方格式（Responses API）',
    hint: 'OpenAI 官方新格式，gpt-5 系列专用（api.openai.com）',
    protocol: 'openai',
    auth: 'bearer',
  },
  {
    label: 'OpenAI 兼容格式（Chat Completions）',
    hint: '绝大多数服务：中转 / 自建 / 厂商原生端点（DeepSeek、通义等）',
    protocol: 'openai',
    auth: 'bearer',
  },
]
