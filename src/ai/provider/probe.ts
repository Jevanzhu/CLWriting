/**
 * 能力探测——把 W0 探针产品化为「测试连接」（方案 §四①）。
 *
 * caps 不能硬编码：分发出去后我们无法预知用户接什么端点。
 * 探测四项核心能力（连通 / 流式 / tool_use / tool_choice），只发无意义 prompt，
 * 绝不含书稿内容。
 */
import type { ProviderConf, ProviderCaps, ModelCaps, ProbeResult, ModelProbeResult, ModelProvider } from './types.js'
import { createAnthropicProvider } from './anthropic-adapter.js'
import { createOpenAIProvider } from './openai-adapter.js'
import { listModels } from './models.js'

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

/** 按 ProviderConf 创建适配器（modelCaps 注入模型级能力，供 generateTool 读取） */
export function createProvider(conf: ProviderConf, modelCaps?: ModelCaps | null): ModelProvider {
  return conf.protocol === 'anthropic'
    ? createAnthropicProvider(conf, undefined, modelCaps)
    : createOpenAIProvider(conf, undefined, modelCaps)
}

/**
 * 探测供应商的服务级能力（连通 / 认证 / 流式）。
 *
 * caps 拆两级后服务级在此探测——不需要模型（listModels 即验证连通 + 认证），
 * 流式取列表首个模型发极简请求（流式能力属服务传输层，不依赖具体模型）。
 * 模型级能力（tool_use / tool_choice）由 probeModelCaps 在选定模型后单独探测。
 */
export async function probeCapabilities(conf: ProviderConf): Promise<ProbeResult> {
  // mock 快路：e2e / 前端开发不真探——测试连接按钮在 mock 下可用
  if (process.env['CLWRITING_DRIVER'] === 'mock') {
    return {
      caps: { connected: true, streaming: true },
      details: ['mock 驱动：模拟全能力（未真探）'],
    }
  }
  const details: string[] = []
  const caps: ProviderCaps = { connected: false, streaming: false }

  // ① 连通 + 认证：listModels 能拉到列表即算通过（不需要模型）
  let models: string[] = []
  try {
    models = await listModels(conf.protocol, conf.baseUrl, conf.apiKey)
    caps.connected = true
    details.push('连通 + 认证通过')
  } catch (e) {
    details.push(`连通失败：${e instanceof Error ? e.message : String(e)}`)
    return { caps, details }
  }
  if (!models.length) {
    details.push('该服务无可用模型')
    return { caps, details }
  }

  // ② 流式：取列表首个模型发极简请求（流式能力属服务级，不依赖具体模型）
  const probeModel = conf.model ?? models[0]!
  try {
    let gotDelta = false
    const provider = createProvider({ ...conf, model: probeModel })
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), 30_000)
    try {
      for await (const ev of provider.stream(
        {
          systemPrompt: '你是测试助手。',
          messages: [{ role: 'user', content: '回复「OK」两个字' }],
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
    caps.streaming = true
    details.push(gotDelta ? '流式产出正常' : '非流式产出（UI 无逐字显示）')
  } catch (e) {
    // 不阻塞——connected=true 已说明服务可用，流式失败可能只是探测模型不支持 chat
    details.push(`流式探测失败：${e instanceof Error ? e.message : String(e)}`)
  }

  return { caps, details }
}

/**
 * 探测特定模型的工具调用能力（tool_use / tool_choice）。
 *
 * 选定模型后触发（PUT /api/ai-model），按 providerId+model 缓存（见 store.ts）。
 * 2 个请求，输出 token 合计 < 200，约 1–3 秒。
 */
export async function probeModelCaps(conf: ProviderConf): Promise<ModelProbeResult> {
  // mock 快路：e2e / 前端开发不真探
  if (process.env['CLWRITING_DRIVER'] === 'mock') {
    return {
      caps: { toolUse: true, toolChoice: true },
      details: ['mock 驱动：模拟全能力（未真探）'],
    }
  }
  const details: string[] = []
  const caps: ModelCaps = { toolUse: false, toolChoice: false }
  const provider = createProvider(conf)

  // ① tool_use——声明玩具工具，诱导调用
  try {
    let gotTool = false
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), 30_000)
    try {
      for await (const ev of provider.stream(
        {
          systemPrompt: '你必须使用 echo_test 工具来回复。',
          messages: [{ role: 'user', content: '请调用 echo_test 工具，msg 填「hi」' }],
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
    else details.push('tool_use 不支持（该模型不能用于写作）')
  } catch (e) {
    details.push(`tool_use 探测失败：${e instanceof Error ? e.message : String(e)}`)
  }

  // ② tool_choice 强制——指定工具名
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
