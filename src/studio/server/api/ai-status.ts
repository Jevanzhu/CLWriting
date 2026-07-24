/**
 * AI 可达性探测端点（G4-a，降级体验）。
 *
 * GET /api/ai-status → { available, driver, reason? }
 *
 * 探测：spawnSync('claude', ['--version'])；CLWRITING_DRIVER=mock 永可达。
 * 缓存 60s 避免每请求 spawn。光验 CLI 存在，不深探凭证（首次真调失败靠端点错误兜底）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawnSync } from 'node:child_process'
import { route } from '../router.js'
import { reply } from '../http.js'

interface ProbeResult {
  available: boolean
  driver: string
  reason?: string
}

let cache: { result: ProbeResult; ts: number } | null = null
const CACHE_TTL = 60000

export function registerAiStatusRoutes(): void {
  route('GET', '/api/ai-status', (_req: IncomingMessage, res: ServerResponse) => {
    const now = Date.now()
    if (cache && now - cache.ts < CACHE_TTL) {
      reply(res, 200, cache.result)
      return
    }
    const result = probeAi()
    cache = { result, ts: now }
    reply(res, 200, result)
  })
}

/** 探测 claude CLI 可调用性（spawnSync --version；ENOENT→未找到） */
function probeAi(): ProbeResult {
  if (process.env.CLWRITING_DRIVER === 'mock') {
    return { available: true, driver: 'mock' }
  }
  try {
    const r = spawnSync('claude', ['--version'], { timeout: 5000, encoding: 'utf-8' })
    if (r.status === 0) return { available: true, driver: 'cc' }
    if (r.error) {
      return { available: false, driver: 'cc', reason: 'claude CLI 未找到（请确认已安装并在 PATH）' }
    }
    return { available: false, driver: 'cc', reason: `claude CLI 异常（退出码 ${r.status}）` }
  } catch {
    return { available: false, driver: 'cc', reason: 'claude CLI 探测失败' }
  }
}
