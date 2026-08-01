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
 * 三层过滤：
 * 1. URL query param 凭据（api_key= / key= / token= / authorization=）
 * 2. Bearer / x-api-key header 值
 * 3. 裸 key（sk- / xai- / sk_ 前缀 + 长串，防 SDK 把 key 直接放 error body）
 */
export function redactSecret(text: string): string {
  return text
    .replace(/([?&](?:api[_-]?key|key|token|access[_-]?key|authorization)=)[^&\s#]+/gi, '$1***REDACTED***')
    .replace(/((?:Bearer|x-api-key)[:\s]+)[A-Za-z0-9\-._~+/=]+/gi, '$1***REDACTED***')
    .replace(/\b(?:sk-|xai-|sk_)[A-Za-z0-9\-_]{16,}/g, '***REDACTED***')
}
