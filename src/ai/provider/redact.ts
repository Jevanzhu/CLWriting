/**
 * 凭据脱敏——泄漏面收敛（凭据存储设计 §6.2 D9）。
 *
 * 上游 SDK 报错 message 可能含完整 URL（部分网关把 key 放 query param），
 * 或含 Authorization header 原文。redactSecret 在错误返回前清洗这些痕迹。
 *
 * 思路参照 cc-switch 的 redact_url_for_log_with_secrets（lib.rs:159）。
 */

/**
 * 脱敏文本中可能泄漏的 API Key / token 痕迹。
 *
 * 多层过滤：
 * 1. URL query param 凭据（api_key= / key= / token= / authorization=）
 * 2. Bearer / x-api-key header 值
 * 3. 裸 key（P3 补全常见厂商前缀：sk- / sk-ant- / xai- / sk_ / gsk_ / hf_ /
 *    glpat- / ghp_ + 长串，防 SDK 把 key 直接放 error body）
 * 4. R73-6（二十一轮 A-6）：无前缀特征的两类裸 key——
 *    - 智谱（Zhipu）：`<id32 hex>.<secret32 hex>` 形态（id 与 secret 间以点分隔）
 *    - Google Gemini：`AIza` + 35 位 [A-Za-z0-9_-]（固定前缀，总长 39）
 */
export function redactSecret(text: string): string {
  return text
    .replace(/([?&](?:api[_-]?key|key|token|access[_-]?key|authorization)=)[^&\s#]+/gi, '$1***REDACTED***')
    .replace(/((?:Bearer|x-api-key)[:\s]+)[A-Za-z0-9\-._~+/=]+/gi, '$1***REDACTED***')
    .replace(/\b(?:sk-|sk-ant-|xai-|sk_|gsk_|hf_|glpat-|ghp_)[A-Za-z0-9\-_]{16,}/g, '***REDACTED***')
    // R30-11（三十轮）登记维持：智谱 key 形态无前缀特征，本正则会误伤正文中同形的
    // 「32 位 hex.32 位 hex」hash 对——过度脱敏是保守方向（宁多勿漏），维持不修。
    .replace(/\b[0-9a-fA-F]{32}\.[0-9a-fA-F]{32}\b/g, '***REDACTED***')
    .replace(/\bAIza[A-Za-z0-9_\-]{35}\b/g, '***REDACTED***')
}
