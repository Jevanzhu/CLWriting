/**
 * 错误友好化——把未知错误转为面向作者的 toast 消息。
 *
 * 已知技术错误模式（英文/工程术语）映射为中文友好提示；
 * 其余保留原消息（后端校验消息通常已是中文友好，如「名称必填」）。
 * dev 模式额外 console.error 原始错误，便于调试。
 */
import { ApiError } from '../api/client'

/**
 * 已知技术错误模式 → 友好提示。
 *
 * R40-40（四十轮）：子串匹配收窄——原裸子串（/SSE/、/network/、/429/、/invalid.*key/
 * 等）会把邻近词/数字误归类（assess 含 sse 判成「连接中断」、文案里任意位置的 429 判成
 * 「请求过于频繁」、invalid 与 key 相隔全文任意距离判成「认证失败」）。收窄口径：
 * ① 词边界 \b 锁定独立词；② 数字状态码要求 HTTP 语境（status/code/error/api 前缀或
 * 后随英文原因短语）；③ 双词模式（network×error、invalid…key）限定词距。真实上游错误
 * 形态（OpenAI 429 rate limit exceeded / DeepSeek API 502: upstream error /
 * fetch failed: ECONNREFUSED 等）均保持原归类（见 friendly-error 测试）。
 */
const TECH_PATTERNS: ReadonlyArray<{ test: RegExp; tip: string }> = [
  { test: /timeout|timed?\s*out/i, tip: '请求超时，请重试' },
  {
    test: /ECONNREFUSED|ECONNRESET|fetch\s*failed|ERR_NETWORK|\bnetwork\b[^\n]{0,16}(error|fail|unreach|down)|(error|fail|unreach)[^\n]{0,16}\bnetwork\b/i,
    tip: '网络连接失败，请检查网络',
  },
  { test: /\bSSE\b|\bEventSource\b/i, tip: '连接中断，请重试' },
  { test: /\bspawn\b|\bENOENT\b|\bexit\s*code\b/i, tip: '操作失败，请重试' },
  { test: /\bunauthorized\b|api[\s_-]*key|invalid[\s_-]+(?:api[\s_-]+)?key\b/i, tip: 'AI 服务认证失败，请检查设置' },
  {
    test: /rate\s*limit|too\s+many\s+requests|\bquota\b|(?:status|code|http|error|api|openai)[^\n]{0,8}\b429\b|\b429\b[^\w]{0,3}(?:too|rate|error)/i,
    tip: '请求过于频繁，请稍后重试',
  },
  {
    test: /overloaded|(?:status|code|http|error|api|openai|deepseek)[^\n]{0,8}\b(?:502|503)\b|\b(?:502|503)\b[^\w]{0,3}(?:bad|service|gateway|upstream|unavailable|error)/i,
    tip: 'AI 服务繁忙，请稍后重试',
  },
]

export function friendlyError(e: unknown): string {
  // R40-40（四十轮）：结构化优先——ApiError 携带机器码（服务端 {error, code} 信封或
  // 客户端预制超时错）时 message 已是服务端/客户端人话文案，直接透出，不再对信封文案
  // 跑子串猜测：信封里的数字/英文片段（如「第 429 章不存在」的 429、含 model key 名的
  // 校验文案）被子串误归类成 AI 故障类提示，反而掩盖真实原因。无码形态
  // （LOCAL_API_DOWN）与裸 Error（上游 SDK/网络层工程串）保留下方分类链。
  if (e instanceof ApiError && e.code && e.code !== 'LOCAL_API_DOWN') {
    if (import.meta.env.DEV) console.error('[error]', e)
    return e.message
  }
  const raw = e instanceof Error ? e.message : String(e)
  // dv-01：本地 API/网络层的裸 HTTP 状态串（如 dev Vite proxy 未起返回的「HTTP 502」）
  // 不是 AI 提供方故障——先于 TECH_PATTERNS 返回中性文案，避免被 /502/ 误匹配成
  // 「AI 服务繁忙」掩盖「本地服务没起」的真实原因（apiJson 已将空体 5xx 改报
  // 「本地服务未连接…」，此处兜底其余裸 HTTP 形态）。
  const httpStatus = /^HTTP\s*(\d{3})\b/.exec(raw)
  if (httpStatus) {
    if (import.meta.env.DEV) console.error('[error]', e)
    return `请求失败（HTTP ${httpStatus[1]}），请稍后重试`
  }
  for (const { test, tip } of TECH_PATTERNS) {
    if (test.test(raw)) {
      if (import.meta.env.DEV) console.error('[error]', e)
      return tip
    }
  }
  return raw
}
