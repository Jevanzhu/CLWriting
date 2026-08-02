/**
 * AI 可达性探测端点（G4-a，降级体验）。
 *
 * GET /api/ai-status → { available, reason? }
 *
 * 新架构：探 provider 配置（providers.json 是否有已配置且已探测的当前供应商）。
 * mock 模式永可达；CLWRITING_E2E_AI_DOWN=1 模拟不可达。
 *
 * P0-2：不再缓存——每次实时探测。currentProvider 只是一次 providers.json 读，
 * 代价可忽略；缓存会让「供应商刚配置好」落在 10s 旧结果上，按钮仍置灰。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { route } from '../router.js'
import { reply } from '../http.js'
import { currentProvider } from '../../../ai/provider/index.js'

interface ProbeResult {
  available: boolean
  reason?: string
}

interface AiStatusCtx {
  userDataPath: string | null
}

export function registerAiStatusRoutes(ctx: AiStatusCtx): void {
  route('GET', '/api/ai-status', (_req: IncomingMessage, res: ServerResponse) => {
    // e2e AI-DOWN：跳全部逻辑直接判定
    if (process.env.CLWRITING_E2E_AI_DOWN === '1') {
      reply(res, 200, probeAi(null))
      return
    }
    // 每次实时探测（P0-2：无缓存，供应商增改/测试/切换后立即可达）
    reply(res, 200, probeAi(ctx.userDataPath))
  })
}

/** 探测 AI 可达性：有已配置的当前供应商即可达 */
function probeAi(userDataPath: string | null): ProbeResult {
  // e2e 专用短路：模拟 AI 不可达
  if (process.env.CLWRITING_E2E_AI_DOWN === '1') {
    return { available: false, reason: 'e2e: AI 不可达模拟' }
  }
  if (process.env.CLWRITING_DRIVER === 'mock') {
    return { available: true }
  }
  if (!userDataPath) {
    return { available: false, reason: '未定位到应用数据目录' }
  }
  const prov = currentProvider(userDataPath)
  if (!prov) {
    return { available: false, reason: '未配置 AI 服务供应商（请在设置页添加）' }
  }
  if (!prov.caps) {
    return { available: false, reason: `供应商「${prov.name}」尚未测试连接` }
  }
  return { available: true }
}
