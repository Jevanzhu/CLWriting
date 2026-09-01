/**
 * 能力探测——把 W0 探针产品化为「测试连接」（方案 §四①）。
 *
 * caps 不能硬编码：分发出去后我们无法预知用户接什么端点。
 * 探测三项核心能力（连通 / 流式 / tool_use / tool_choice），只发无意义 prompt，
 * 绝不含书稿内容。
 *
 * 表驱动重构（方案 §6.3）：模型级能力（tool_use / tool_choice）由 model-quirks
 * 静态表判定（probeModelCaps 已退役——探测结果与生产参数面不一致是 400 源头之一）。
 */
import type { ProviderConf, ProviderCaps, ProbeResult } from './types.js'
import { listModels } from './models.js'
import { redactSecret } from './redact.js'

// createProvider 迁至 registry.ts（批次 D2：声明式注册表 + settings hash 实例缓存）；
// import + re-export（纯 `export {} from` 不建本地绑定，probeCapabilities 引用会 ReferenceError）
import { createProvider } from './registry.js'
export { createProvider }

/**
 * 探测供应商的服务级能力（连通 / 认证 / 流式）。
 *
 * caps 拆两级后服务级在此探测——不需要模型（listModels 即验证连通 + 认证），
 * 流式取列表首个模型发极简请求（流式能力属服务传输层，不依赖具体模型）。
 * 模型级能力（tool_use / tool_choice）由 model-quirks 静态表判定。
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
  // V-P2-11：listModels 步骤也受 30s 超时约束（与流式探测同款）——不传 signal 时
  // SDK 默认超时 10 分钟，网关 TCP 黑洞会让「测试连接」按钮挂死。
  let models: string[] = []
  try {
    const listCtrl = new AbortController()
    const listTimer = setTimeout(() => listCtrl.abort(), 30_000)
    try {
      models = await listModels(conf.protocol, conf.baseUrl, conf.apiKey, conf.auth, listCtrl.signal)
    } finally {
      clearTimeout(listTimer)
    }
    caps.connected = true
    details.push('连通 + 认证通过')
  } catch (e) {
    details.push(`连通失败：${redactSecret(e instanceof Error ? e.message : String(e))}`)
    return { caps, details }
  }
  if (!conf.model && !models.length) {
    details.push('该服务无可用模型')
    return { caps, details }
  }

  // ② 流式：取列表首个模型发极简请求（流式能力属服务级，不依赖具体模型）
  const probeModel = conf.model ?? models[0]!
  try {
    let gotDelta = false
    // R33-21（三十三轮）：bypassCache——探测实例的 model 被换成列表首项，正常生成
    // 永不以此 key 命中；入缓存只会挤占 LRU 容量把正常实例挤出重建。
    const provider = createProvider({ ...conf, model: probeModel }, undefined, undefined, { bypassCache: true })
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
    details.push(`流式探测失败：${redactSecret(e instanceof Error ? e.message : String(e))}`)
  }

  // Responses 线提示（启用批 R4 缺口 17）：参数语义差异提前告知作者
  if (conf.protocol === 'openai-responses') {
    details.push('Responses 线提示：stop 序列被忽略；响应不留存（store:false）；effort 参数名按厂商自动适配')
  }

  return { caps, details }
}
