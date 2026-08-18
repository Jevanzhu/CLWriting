/** 提供方行卡的共享展示纯函数（AI 与 RAG 列表共用）——自 AiServicePanel 拆出，行为零变更。
 *  P9 起增加模型行容量解析（K/M 后缀）、模型行校验、API Key 前端校验（P6）。
 */
import type { ProviderCaps, ModelConfDto } from '../api/providers'

/** caps 徽章文案与配色 class（连接失败=红/已连接=绿；null=未测试由调用方处理）。 */
export function capsBadge(caps: ProviderCaps | null): { text: string; cls: string } | null {
  if (!caps) return null
  if (!caps.connected) return { text: '连接失败', cls: 'bad' }
  return { text: '已连接', cls: 'ok' }
}

/** 探测时间的人话相对值（刚刚/N 分钟前/N 小时前/N 天前）。 */
export function timeAgo(ts: number | undefined): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}

// ── P9 §7.1 容量解析（K/M 后缀，DSH 同口径） ──

/** 把 128K / 1.5M / 8192 解析为 token；空串 → undefined；非法 → null。 */
export function parseCapacity(raw: string): number | null | undefined {
  const s = raw.trim()
  if (!s) return undefined
  const m = /^(\d+(?:\.\d+)?)\s*([KkMm]?)$/.exec(s)
  if (!m) return null
  const n = Number(m[1])
  // 0 = 显式清空（同空串，继承默认）；负数走正则不命中已排除
  if (n === 0) return undefined
  if (!Number.isFinite(n) || n <= 0) return null
  const mult = m[2]!.toLowerCase() === 'k' ? 1024 : m[2]!.toLowerCase() === 'm' ? 1024 * 1024 : 1
  const v = Math.floor(n * mult)
  return v > 0 ? v : null
}

/** 把 token 格式化为 K/M 输入串（整数；大于等于 1M 用 M，>=1K 用 K，否则原数）。 */
export function formatCapacity(tokens: number | undefined): string {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return ''
  if (tokens >= 1024 * 1024 && tokens % (1024 * 1024) === 0) return `${tokens / (1024 * 1024)}M`
  if (tokens >= 1024 && tokens % 1024 === 0) return `${tokens / 1024}K`
  return String(tokens)
}

export interface ModelRowDraft {
  id: string
  name?: string
  contextWindowText: string
  maxTokensText: string
}

/**
 * 模型行校验（DSH 教训：id 必填且供应商内唯一；容量空串 = 未声明，非法 = 拒存）。
 * 返回第一个错误的附加信息（error 文案 + 行索引 + 行内字段）；全部通过 → null。
 */
export function validateModels(
  rows: ModelRowDraft[],
): { error: string; index: number; field: 'id' | 'contextWindow' | 'maxTokens' } | null {
  const seen = new Set<string>()
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const id = row.id.trim()
    if (!id) return { error: `第 ${i + 1} 行模型 id 必填`, index: i, field: 'id' }
    if (seen.has(id)) return { error: `模型 id「${id}」重复`, index: i, field: 'id' }
    seen.add(id)
    const cw = parseCapacity(row.contextWindowText)
    if (cw === null) return { error: `第 ${i + 1} 行 contextWindow 格式非法（如 128K / 1.5M / 8192）`, index: i, field: 'contextWindow' }
    const mt = parseCapacity(row.maxTokensText)
    if (mt === null) return { error: `第 ${i + 1} 行 maxTokens 格式非法（如 4K / 16384）`, index: i, field: 'maxTokens' }
  }
  return null
}

/** 行草稿 → 可提交 DTO（空容量 = 不写字段）。 */
export function modelDraftToDto(rows: ModelRowDraft[]): ModelConfDto[] {
  const out: ModelConfDto[] = []
  for (const r of rows) {
    const id = r.id.trim()
    if (!id) continue
    const m: ModelConfDto = { id }
    const name = (r.name ?? '').trim()
    if (name) m.name = name
    const cw = parseCapacity(r.contextWindowText)
    if (cw !== undefined && cw !== null) m.contextWindow = cw
    const mt = parseCapacity(r.maxTokensText)
    if (mt !== undefined && mt !== null) m.maxTokens = mt
    out.push(m)
  }
  return out
}

/** DTO → 行草稿（编辑回填；未知字段丢弃——声明字段才是编辑面）。 */
export function dtoToModelDrafts(rows: ModelConfDto[] | undefined): ModelRowDraft[] {
  return (rows ?? []).map((m) => ({
    id: m.id ?? '',
    name: typeof m.name === 'string' ? m.name : '',
    contextWindowText: formatCapacity(typeof m.contextWindow === 'number' ? m.contextWindow : undefined),
    maxTokensText: formatCapacity(typeof m.maxTokens === 'number' ? m.maxTokens : undefined),
  }))
}

// ── P6 API Key 前端校验 ──

/**
 * API Key 形状校验（新增/编辑共通）——返回错误文案，null = 通过。
 * 拒绝：仅空白；控制/非法字符（排除常见引号包裹后仍含不可见）；含 KEY= 形（常见误贴 header 行）。
 */
export function apiKeyFailure(key: string): string | null {
  const s = key.trim()
  if (!s) return 'API Key 必填'
  // 剥掉首尾成对引号再检——引号包裹本身合法（少数字段值带引号）
  const inner = /^(['"])(.*)\1$/.test(s) ? s.slice(1, -1) : s
  if (/[\u0000-\u001f\u007f]/.test(inner)) return 'API Key 含控制字符'
  // 误贴请求头：KEY=... / KEY: ...（值可含空格，如 Authorization: Bearer x）
  if (/^\S+\s*[=:]\s*\S+/.test(inner)) return '粘贴的是请求头（KEY=...），请只填 Key 值'
  return null
}