/**
 * 凭据脱敏——兼容转发（R31-27，三十一轮）：实现单源下沉 `src/log/redact.ts`
 * （log 层零依赖，API 出口与日志层共用同一词表；此前智谱/Gemini 两形态只在前者
 * 被掩，SDK 报错经 log.error 落 app-*.jsonl 时漏掩）。历史设计与改法记档见下。
 *
 * 上游 SDK 报错 message 可能含完整 URL（部分网关把 key 放 query param），
 * 或含 Authorization header 原文。redactSecret 在错误返回前清洗这些痕迹。
 * 思路参照 cc-switch 的 redact_url_for_log_with_secrets（lib.rs:159）。
 */
export { redactSecret } from '../../log/redact.js'
