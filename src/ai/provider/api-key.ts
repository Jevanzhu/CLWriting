/**
 * API Key 合法性单点（I6，2026-08-22）——「一条 well-formed key 的唯一定义」。
 *
 * 口径参照 dsh（deepseek-harness packages/llm/llm/src/api-key.ts）：字符集 = 可打印
 * ASCII 且不含空格——HTTP header 值能逐字承载的集合。这是传输不变量而非某厂商策略：
 * 集合外的 key 到不了任何 provider（fetch 拒绝构造 header），与其运行期换一个不可解释
 * 的 401，不如写入时就地解释拒绝。
 *
 * 与前端孪生 web-next shared/provider-format.ts 的 apiKeyFailure 保持同 charset
 * （dsh「keep the two in step」）：孪生另做 UX 判断（引号包裹、误贴请求头），本模块
 * 只管传输不变量。留空是调用方的配置态（编辑留空 = 保留原 key），本函数只判已提交值。
 */

/** 可作为 HTTP header 值逐字承载的字符集：可打印 ASCII，空格除外。 */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/

/** 一条已提交的 API Key 为何不可用。 */
export type ApiKeyRejection = 'empty' | 'illegalCharacters'

/** 单条已提交 key 的判定。 */
export type ApiKeyCheck =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: ApiKeyRejection }

/**
 * 判定一条已提交的 API Key，先静默 trim（首尾空白只有一种读法）。
 * @param raw - 恰好如提交/存储/键入的 key 原文。
 * @returns trim 后可用的 key，或不可用的原因。
 */
export function normalizeApiKey(raw: string): ApiKeyCheck {
  const value = raw.trim()
  if (value.length === 0) return { ok: false, reason: 'empty' }
  if (!LEGAL_API_KEY.test(value)) return { ok: false, reason: 'illegalCharacters' }
  return { ok: true, value }
}

/**
 * 拒绝文案（端点复用，保证口径单一）——文案永不回显 key 本体：任何形式的把密钥
 * 回显进错误消息/日志/UI，都是这条诊断要避免的失败（dsh assertUsableApiKey 同则）。
 */
export function apiKeyRefusal(reason: ApiKeyRejection): string {
  return reason === 'empty'
    ? 'apiKey 必填'
    : 'API Key 含 HTTP 头无法传输的字符（须为不含空格的可打印 ASCII），请检查粘贴内容（如引住了整个值或夹带换行）'
}
