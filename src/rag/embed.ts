/**
 * RAG embedding 调用 —— 依据 M7 #37 spec 第 4 节。
 *
 * 调外部 OpenAI 兼容端点（内置 fetch，零依赖）。
 * 异常容错：网络/HTTP 错误返回 null（降级用，不抛——#37 第 6.2 节降级回落）。
 */

/** embedding 调用结果（null = 失败/降级） */
export type EmbedResult = number[][] | null

export interface EmbedOptions {
  /** 请求超时毫秒；默认 30s。<=0 表示不启用超时。 */
  timeoutMs?: number
}

/**
 * 调外部 embedding 端点（OpenAI 兼容：POST { input, model }，Bearer 鉴权）。
 *
 * @param endpoint base_url（如 https://api.example.com/v1/embeddings）
 * @param model 模型名
 * @param apiKey Bearer token（绝不进 git）
 * @param texts 待 embed 的文本块数组
 * @returns 向量数组（与 texts 等长）；失败返回 null
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

    if (!resp.ok) return null

    const data = (await resp.json()) as { data?: Array<{ embedding?: number[] }> }
    if (!data.data || data.data.length !== texts.length) return null

    const vectors = data.data.map((d) => d.embedding)
    // 任一向量缺失 → 失败
    // 任一向量缺失或含非 finite(Infinity/NaN,坏端点) → 失败(防 cosineSimilarity 产 NaN 污染 topK)
    if (vectors.some((v) => !v || v.length === 0 || v.some((x) => !Number.isFinite(x)))) return null

    return vectors as number[][]
  } catch {
    // 网络/解析错误：静默降级（#37 第 6.2 节，不崩主路径）
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}
