/**
 * RAG embedding 调用 —— 依据 M7 #37 spec 第 4 节。
 *
 * 调外部 OpenAI 兼容端点（内置 fetch；除 ../log 失败留痕外零 npm 依赖）。
 * 异常容错：网络/HTTP 错误返回 null（降级用，不抛——#37 第 6.2 节降级回落）；
 * 失败留痕走 log.warn（R62-4，每端点 60s 去抖——分批索引一次失败一屏，
 * 此前全静默，作者只见「召回为空」无从定位）。
 */

import { log } from '../log/index.js'

/** embedding 调用结果（null = 失败/降级） */
export type EmbedResult = number[][] | null

export interface EmbedOptions {
  /** 请求超时毫秒；默认 30s。<=0 表示不启用超时。 */
  timeoutMs?: number
  /** R62-4：用量回报——端点随响应下发 usage.prompt_tokens 时回调一次（记账通道，
   *  rag/index.ts 借此把 embedding 消耗记入 ai-calls.json 的 rag-embed 任务位）。 */
  onUsage?: (promptTokens: number) => void
}

/** 每端点失败留痕去抖（60s 窗口内同端点只留痕一次——分批索引失败不刷屏） */
const lastWarnAt = new Map<string, number>()

function warnEmbedFailure(endpoint: string, reason: string): void {
  const now = Date.now()
  if (now - (lastWarnAt.get(endpoint) ?? 0) < 60_000) return
  lastWarnAt.set(endpoint, now)
  log.warn('rag', `embedding 端点调用失败（${reason}；endpoint=${endpoint}）——RAG 索引/召回降级`)
}

/**
 * 调外部 embedding 端点（OpenAI 兼容：POST { input, model }，Bearer 鉴权）。
 *
 * @param endpoint base_url（如 https://api.example.com/v1/embeddings）
 * @param model 模型名
 * @param apiKey Bearer token（绝不进 git）
 * @param texts 待 embed 的文本块数组
 * @param options 超时/用量回调
 * @returns 向量数组（与 texts 等长且按 texts 顺序对齐）；失败返回 null
 */
export async function embed(
  endpoint: string,
  model: string,
  apiKey: string,
  texts: string[],
  options: EmbedOptions = {},
): Promise<EmbedResult> {
  if (texts.length === 0) return []

  const timeoutMs = options.timeoutMs ?? 30_000
  const controller = timeoutMs > 0 ? new AbortController() : null
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      ...(controller ? { signal: controller.signal } : {}),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ input: texts, model }),
    })

    if (!resp.ok) {
      warnEmbedFailure(endpoint, `HTTP ${resp.status}`)
      return null
    }

    const data = (await resp.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>
      usage?: { prompt_tokens?: number }
    }
    if (!data.data || data.data.length !== texts.length) {
      warnEmbedFailure(endpoint, `响应条数 ${data.data?.length ?? 0} ≠ 请求 ${texts.length}`)
      return null
    }

    // R62-3：按 index 归位——OpenAI 兼容协议的 data[] 数组顺序无契约（批次端点/部分
    // 网关按内部并行完成序返回），此前按位对齐在乱序端点上会把向量永久错配到别的块，
    // 毒化整库索引且无任何症状。全部条目带合法 index（0≤index<len 整数）→ 按 index
    // 归位（重复/空洞由落位后满位校验兜底）；全部不带 index → 回落按位（兼容不回显
    // index 的非标端点，与旧行为一致）；两种形态混杂 → 视为坏响应判失败。
    const hasIndex = data.data.every(
      (d) => typeof d.index === 'number' && Number.isInteger(d.index) && d.index >= 0 && d.index < texts.length,
    )
    const lacksIndex = data.data.every((d) => d.index === undefined)
    if (!hasIndex && !lacksIndex) {
      warnEmbedFailure(endpoint, '响应 index 字段形态混杂（部分条目带部分不带）')
      return null
    }
    const slots: Array<number[] | undefined> = new Array(texts.length).fill(undefined)
    if (hasIndex) {
      for (const d of data.data) slots[d.index as number] = d.embedding
    } else {
      data.data.forEach((d, i) => {
        slots[i] = d.embedding
      })
    }
    // 任一槽位空（缺 embedding / index 重复挤掉他槽留洞）、向量空或含非 finite
    // (Infinity/NaN，坏端点) → 失败（防 cosineSimilarity 产 NaN 污染 topK）
    if (slots.some((v) => !v || v.length === 0 || v.some((x) => !Number.isFinite(x)))) {
      warnEmbedFailure(endpoint, '向量槽位缺失/空洞（index 重复或 embedding 缺失/非法）')
      return null
    }

    const promptTokens = data.usage?.prompt_tokens
    if (typeof promptTokens === 'number' && promptTokens > 0) options.onUsage?.(promptTokens)

    return slots as number[][]
  } catch {
    // 网络/解析错误：降级不抛（#37 第 6.2 节，不崩主路径），仅留痕
    warnEmbedFailure(endpoint, '网络/解析异常')
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}
