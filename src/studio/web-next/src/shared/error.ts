/**
 * 错误友好化——把未知错误转为面向作者的 toast 消息。
 *
 * 已知技术错误模式（英文/工程术语）映射为中文友好提示；
 * 其余保留原消息（后端校验消息通常已是中文友好，如「名称必填」）。
 * dev 模式额外 console.error 原始错误，便于调试。
 */

/** 已知技术错误模式 → 友好提示 */
const TECH_PATTERNS: ReadonlyArray<{ test: RegExp; tip: string }> = [
  { test: /timeout|timed?\s*out/i, tip: '请求超时，请重试' },
  { test: /ECONNREFUSED|ECONNRESET|fetch\s*failed|network/i, tip: '网络连接失败，请检查网络' },
  { test: /SSE|EventSource/i, tip: '连接中断，请重试' },
  { test: /spawn|ENOENT|exit\s*code/i, tip: '操作失败，请重试' },
  { test: /unauthorized|api\s*key|invalid.*key/i, tip: 'AI 服务认证失败，请检查设置' },
  { test: /rate\s*limit|429|quota/i, tip: '请求过于频繁，请稍后重试' },
  { test: /overloaded|503|502/i, tip: 'AI 服务繁忙，请稍后重试' },
]

export function friendlyError(e: unknown): string {
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
