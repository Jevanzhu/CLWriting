/**
 * 从模型 text 提取 JSON（容忍前后叙述性文字）。
 *
 * 模型常在 JSON 前后混入解释性文字，直接 JSON.parse 易失败。先尝试整体，
 * 再退而提取首个 `[...]` / `{...}` 片段。返回原始字符串（未 parse），
 * 调用方自行 JSON.parse 容错（损坏时给明确错误）。
 */
export function extractJson(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return trimmed
  const arr = trimmed.match(/\[[\s\S]*\]/)
  if (arr) return arr[0]
  const obj = trimmed.match(/\{[\s\S]*\}/)
  if (obj) return obj[0]
  return trimmed
}
