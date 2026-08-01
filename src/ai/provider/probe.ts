/**
 * 能力探测——把 W0 探针产品化为「测试连接」（方案 §四①）。
 *
 * caps 不能硬编码：分发出去后我们无法预知用户接什么端点。
 * 探测四项核心能力（连通 / 流式 / tool_use / tool_choice），只发无意义 prompt，
 * 绝不含书稿内容。
 */
import type { ProviderConf, ProviderCaps, ProbeResult, ModelProvider, GenEvent } from './types.js'
import { createAnthropicProvider } from './anthropic-adapter.js'
import { createOpenAIProvider } from './openai-adapter.js'

/** 玩具工具——诱导模型调用以探测 tool_use 支持 */
const TOY_TOOL = {
  name: 'echo_test',
  description: '回显测试工具',
  input_schema: {
    type: 'object',
    properties: {
      msg: { type: 'string', description: '随便说一句话' },
    },
    required: ['msg'],
  },
}

/** 按 ProviderConf 创建适配器 */
export function createProvider(conf: ProviderConf): ModelProvider {
  return conf.protocol === 'anthropic'
    ? createAnthropicProvider(conf)
    : createOpenAIProvider(conf)
}

/**
 * 探测一个供应商的四项能力。
 * 4 个请求，输出 token 合计 < 100，单轮 1–3 秒。
 */
export async function probeCapabilities(conf: ProviderConf): Promise<ProbeResult> {
  const provider = createProvider(conf)
  const details: string[] = []
  const caps: ProviderCaps = {
    toolUse: false,
    toolChoice: false,
    streaming: false,
  }

  // ① 连通 + 认证 + ② 流式（合并为一个请求）
  try {
    let gotDelta = false
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), 30_000)
    try {
      for await (const ev of provider.stream(
        {
          systemPrompt: '你是测试助手。',
          messages: [{ role: 'user', content: '回复「OK」两个字' }],
          maxTokens: 10,
        },
        ctrl.signal,
      )) {
        if (ev.type === 'text') gotDelta = true
        else if (ev.type === 'error') throw new Error(ev.message)
        else if (ev.type === 'done') break
      }
    } finally {
      clearTimeout(timeout)
    }
    caps.streaming = gotDelta
    details.push('连通 + 认证通过')
    if (gotDelta) details.push('流式产出正常')
    else details.push('非流式产出（UI 无逐字显示）')
  } catch (e) {
    details.push(`连通失败：${e instanceof Error ? e.message : String(e)}`)
    return { caps, details }
  }

  // ③ tool_use——声明玩具工具，诱导调用
  try {
    let gotTool = false
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), 30_000)
    try {
      for await (const ev of provider.stream(
        {
          systemPrompt: '你必须使用 echo_test 工具来回复。',
          messages: [{ role: 'user', content: '请调用 echo_test 工具，msg 填「hi」' }],
          maxTokens: 100,
          tools: [TOY_TOOL],
          toolChoice: 'any',
        },
        ctrl.signal,
      )) {
        if (ev.type === 'tool' && ev.name === 'echo_test') gotTool = true
        else if (ev.type === 'error') throw new Error(ev.message)
        else if (ev.type === 'done') break
      }
    } finally {
      clearTimeout(timeout)
    }
    caps.toolUse = gotTool
    if (gotTool) details.push('tool_use 支持')
    else details.push('tool_use 不支持（该供应商不能用于写作）')
  } catch (e) {
    details.push(`tool_use 探测失败：${e instanceof Error ? e.message : String(e)}`)
  }

  // ④ tool_choice 强制——指定工具名
  if (caps.toolUse) {
    try {
      let gotTool = false
      const ctrl = new AbortController()
      const timeout = setTimeout(() => ctrl.abort(), 30_000)
      try {
        for await (const ev of provider.stream(
          {
            systemPrompt: '你是测试助手。',
            messages: [{ role: 'user', content: '测试' }],
            maxTokens: 100,
            tools: [TOY_TOOL],
            toolChoice: 'tool',
            toolName: 'echo_test',
          },
          ctrl.signal,
        )) {
          if (ev.type === 'tool' && ev.name === 'echo_test') gotTool = true
          else if (ev.type === 'error') throw new Error(ev.message)
          else if (ev.type === 'done') break
        }
      } finally {
        clearTimeout(timeout)
      }
      caps.toolChoice = gotTool
      if (gotTool) details.push('tool_choice 强制调用支持')
      else details.push('tool_choice 不可靠（将退 prompt 引导 + 校验重试）')
    } catch (e) {
      details.push(`tool_choice 探测失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return { caps, details }
}
