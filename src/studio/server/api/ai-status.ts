/**
 * AI 可达性探测端点（降级体验）。
 *
 * GET /api/ai-status → { available, reason? }
 *
 * 新架构：探 provider 配置（providers.json 是否有已配置且已探测的当前供应商）。
 * mock 模式永可达；CLWRITING_E2E_AI_DOWN=1 模拟不可达。
 *
 * 不再缓存——每次实时探测。currentProvider 只是一次 providers.json 读，
 * 代价可忽略；缓存会让「供应商刚配置好」落在 10s 旧结果上，按钮仍置灰。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DriverHost } from '../driver-port.js' // driver 经组装根注入
import { defineRoute } from './schema.js'
import { reply } from '../http.js'
import type { ProviderRuntime } from '../../../ai/provider/store.js' // provider 运行时端口（组装根注入）

interface ProbeResult {
  available: boolean
  driver: string // 当前供应商名（供状态栏显示；空 = 未配置）
  reason?: string
}

interface AiStatusCtx {
  userDataPath: string | null
  /** driver 宿主（mock 选择结果）——组装根注入 */
  driver: DriverHost
  /** provider 运行时端口——组装根注入 */
  providers: ProviderRuntime
}

export function registerAiStatusRoutes(ctx: AiStatusCtx): void {
  defineRoute('ai-status', {
    method: 'GET',
    path: '/api/ai-status',
    handler: (_, _req: IncomingMessage, res: ServerResponse) => {
    // e2e AI-DOWN：跳全部逻辑直接判定
    if (process.env.CLWRITING_E2E_AI_DOWN === '1') {
      reply(res, 200, probeAi(ctx, null))
      return
    }
    // 每次实时探测（无缓存，供应商增改/测试/切换后立即可达）
    reply(res, 200, probeAi(ctx, ctx.userDataPath))
  },
  })
}

/** 探测 AI 可达性：有已配置的当前供应商即可达 */
function probeAi(ctx: AiStatusCtx, userDataPath: string | null): ProbeResult {
  // e2e 专用短路：模拟 AI 不可达
  if (process.env.CLWRITING_E2E_AI_DOWN === '1') {
    return { available: false, driver: '', reason: 'e2e: AI 不可达模拟' }
  }
  // mock 判定读注入的 driver.kind（不再读环境变量）
  if (ctx.driver.kind === 'mock') {
    return { available: true, driver: 'mock' }
  }
  if (!userDataPath) {
    return { available: false, driver: '', reason: '未定位到应用数据目录' }
  }
  const prov = ctx.providers.currentProvider(userDataPath)
  if (!prov) {
    return { available: false, driver: '', reason: '未配置 AI 服务供应商（请在设置页添加）' }
  }
  if (!prov.caps) {
    return { available: false, driver: prov.name, reason: `供应商「${prov.name}」尚未测试连接` }
  }
  // D 档：模型从创作档取（含 currentModel 回落），无模型则按钮置灰
  const tier = ctx.providers.resolveTier(userDataPath, 'creative')
  if (!tier.model) {
    return { available: false, driver: prov.name, reason: '尚未配置模型档位（请在设置 → AI 中配置）' }
  }
  return { available: true, driver: prov.name }
}
